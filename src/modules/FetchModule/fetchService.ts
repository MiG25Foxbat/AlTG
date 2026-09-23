import { IUserBotReader } from '../UserBotModule/IUserBotReader';
import { collectMessagesInWindow } from '../UserBotModule/windowPagination';
import { withPersonalClient } from '../UserBotModule/personalAccount';
import { listActiveChannelUsernames, listActivePrivateChannelIds } from '../../db/channelsRepo';
import { insertPosts } from '../../db/postsRepo';
import { insertPrivatePosts } from '../../db/privatePostsRepo';
import { logger } from '../../utils/logger';

const PRIVATE_PAGE_SIZE = 100;
const MAX_PRIVATE_MESSAGES = 500; // тот же лимит, что и для публичных каналов в UserBot.ts

export interface ChannelFetchResult {
  channel: string;
  fetchedCount: number;
  newCount: number;
  error?: string;
}

/** Превращает технические ошибки GramJS в понятные фразы для интерфейса. */
function describeTelegramError(error: any): string {
  const code = error?.errorMessage || error?.message || '';
  if (code === 'FLOOD' || /FLOOD/.test(code)) {
    const wait = error?.seconds ? ` (подождите ~${error.seconds} сек.)` : '';
    return `Telegram временно ограничил запросы к этому каналу${wait}`;
  }
  if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID/.test(code)) {
    return 'Канал с таким именем не существует';
  }
  if (/CHANNEL_PRIVATE/.test(code)) {
    return 'Канал приватный или недоступен для чтения';
  }
  return code || 'Неизвестная ошибка при чтении канала';
}

/**
 * Забирает свежие посты (не старше cutoffUnixSeconds) по всем активным
 * каналам и сохраняет их в БД. Ошибка на одном канале не прерывает работу
 * с остальными — каждый канал независим.
 */
export async function fetchRecentPosts(
  userBot: IUserBotReader,
  userId: number,
  cutoffUnixSeconds: number
): Promise<ChannelFetchResult[]> {
  const channels = await listActiveChannelUsernames(userId);
  const results: ChannelFetchResult[] = [];

  for (const channel of channels) {
    try {
      const messages = await userBot.getMessagesInWindow(channel, cutoffUnixSeconds);
      const newCount = await insertPosts(
        messages.map((m) => ({
          channelUsername: channel,
          messageId: m.id,
          text: m.text,
          postedAt: m.date,
        }))
      );
      results.push({ channel, fetchedCount: messages.length, newCount });
    } catch (error: any) {
      logger.error(`Ошибка при получении постов из ${channel}:`, error);
      results.push({
        channel,
        fetchedCount: 0,
        newCount: 0,
        error: describeTelegramError(error),
      });
    }
  }

  return results;
}

/**
 * То же самое для приватных каналов, но через ЛИЧНЫЙ Telegram-клиент
 * пользователя (только он состоит в этих каналах — общий системный бот
 * не может их прочитать) и с записью в private_posts, а не в общий кэш.
 * Если у пользователя не подключён личный аккаунт — тихо возвращает [],
 * это не ошибка: значит просто нечего опрашивать этим способом.
 */
export async function fetchRecentPrivatePosts(
  userId: number,
  cutoffUnixSeconds: number
): Promise<ChannelFetchResult[]> {
  const channelIds = await listActivePrivateChannelIds(userId);
  if (channelIds.length === 0) return [];

  const results = await withPersonalClient(userId, async (client) => {
    const perChannel: ChannelFetchResult[] = [];
    for (const channelId of channelIds) {
      try {
        const messages = await collectMessagesInWindow(
          async (offsetId) => {
            const page = await client.getMessages(channelId, {
              limit: PRIVATE_PAGE_SIZE,
              offsetId: offsetId || undefined,
            });
            return (page as any[]).map((m) => ({ id: m.id, message: m.message, date: m.date }));
          },
          cutoffUnixSeconds,
          MAX_PRIVATE_MESSAGES
        );
        const newCount = await insertPrivatePosts(
          userId,
          messages.map((m) => ({ channelIdentifier: channelId, messageId: m.id, text: m.text, postedAt: m.date }))
        );
        perChannel.push({ channel: channelId, fetchedCount: messages.length, newCount });
      } catch (error: any) {
        logger.error(`Ошибка при получении постов из приватного канала ${channelId}:`, error);
        perChannel.push({ channel: channelId, fetchedCount: 0, newCount: 0, error: describeTelegramError(error) });
      }
    }
    return perChannel;
  });

  return results ?? [];
}
