import { IUserBotReader } from '../UserBotModule/IUserBotReader';
import { listActiveChannelUsernames } from '../../db/channelsRepo';
import { insertPosts } from '../../db/postsRepo';
import { logger } from '../../utils/logger';

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
  cutoffUnixSeconds: number
): Promise<ChannelFetchResult[]> {
  const channels = listActiveChannelUsernames();
  const results: ChannelFetchResult[] = [];

  for (const channel of channels) {
    try {
      const messages = await userBot.getMessagesInWindow(channel, cutoffUnixSeconds);
      const newCount = insertPosts(
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
