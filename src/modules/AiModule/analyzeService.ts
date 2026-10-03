import { IUserBotReader } from '../UserBotModule/IUserBotReader';
import { fetchRecentPosts, fetchRecentPrivatePosts, ChannelFetchResult } from '../FetchModule/fetchService';
import { getPostsSince } from '../../db/postsRepo';
import { getPrivatePostsSince } from '../../db/privatePostsRepo';
import { listChannels } from '../../db/channelsRepo';
import { extractKeywords, keywordPreFilter } from '../FilterModule/keywordFilter';
import { summarizeWithGemini } from './geminiClient';
import { windowMinutesToCutoff, formatMoscowTime } from '../../utils/time';
import { logger } from '../../utils/logger';

const POSTS_FETCHED_FROM_DB_CAP = 2000;
const MAX_POSTS_SENT_TO_LLM = 300;

export interface ResultItem {
  channel: string;
  channelTitle: string | null;
  messageId: number;
  postedAtUnix: number;
  postedAtFormatted: string;
  text: string;
  link: string;
  gist: string;
}

/** Общая для public_posts/private_posts форма — дальше по пайплайну (фильтр, ИИ) им всё равно, откуда пост. */
interface UnifiedPost {
  channel: string;
  isPrivate: boolean;
  messageId: number;
  text: string;
  postedAt: number;
}

export interface AnalyzeResult {
  windowMinutes: number;
  topic: string;
  channelsChecked: number;
  channelErrors: { channel: string; error: string }[];
  postsInWindow: number;
  postsSentToAi: number;
  usedKeywordFallback: boolean;
  summary: string;
  items: ResultItem[];
  tookMs: number;
}

function toLink(channel: string, messageId: number, isPrivate: boolean): string {
  if (isPrivate) {
    // Deep-link на пост в канале без публичного @username — рабочий формат
    // Telegram (t.me/c/<id>/<msg>) только для тех, кто уже состоит в канале,
    // как раз наш случай. "-100"-префикс (bot-API стиль ID) отбрасываем.
    const bareId = channel.replace(/^-100/, '').replace(/^-/, '');
    return `https://t.me/c/${bareId}/${messageId}`;
  }
  return `https://t.me/${channel.replace(/^@/, '')}/${messageId}`;
}

export async function analyzeTopic(
  userBot: IUserBotReader,
  userId: number,
  topic: string,
  windowMinutes: number,
  /** Если задан — анализируются только посты из этих каналов (алерты по группам). */
  onlyChannels?: Set<string>
): Promise<AnalyzeResult> {
  const startedAt = Date.now();
  const cutoff = windowMinutesToCutoff(windowMinutes);

  const [fetchResults, privateFetchResults]: [ChannelFetchResult[], ChannelFetchResult[]] = await Promise.all([
    fetchRecentPosts(userBot, userId, cutoff),
    fetchRecentPrivatePosts(userId, cutoff),
  ]);
  const channelErrors = [...fetchResults, ...privateFetchResults]
    .filter((r) => r.error)
    .map((r) => ({ channel: r.channel, error: r.error! }));

  const [publicPosts, privatePosts] = await Promise.all([
    getPostsSince(userId, cutoff, POSTS_FETCHED_FROM_DB_CAP),
    getPrivatePostsSince(userId, cutoff, POSTS_FETCHED_FROM_DB_CAP),
  ]);
  const posts: UnifiedPost[] = [
    ...publicPosts.map((p) => ({ channel: p.channel_username, isPrivate: false, messageId: p.message_id, text: p.text, postedAt: p.posted_at })),
    ...privatePosts.map((p) => ({ channel: p.channel_identifier, isPrivate: true, messageId: p.message_id, text: p.text, postedAt: p.posted_at })),
  ]
    .filter((p) => !onlyChannels || onlyChannels.has(p.channel))
    .sort((a, b) => b.postedAt - a.postedAt)
    .slice(0, POSTS_FETCHED_FROM_DB_CAP);

  const baseResult = {
    windowMinutes,
    topic,
    channelsChecked: fetchResults.length + privateFetchResults.length,
    channelErrors,
    postsInWindow: posts.length,
  };

  if (posts.length === 0) {
    return {
      ...baseResult,
      postsSentToAi: 0,
      usedKeywordFallback: false,
      summary: 'За выбранный период не нашлось ни одного поста. Попробуйте увеличить период или проверьте список каналов.',
      items: [],
      tookMs: Date.now() - startedAt,
    };
  }

  const keywords = extractKeywords(topic);
  const keywordMatches = keywordPreFilter(posts, keywords);
  const usedKeywordFallback = keywordMatches.length === 0;
  const candidates = (usedKeywordFallback ? posts : keywordMatches).slice(0, MAX_POSTS_SENT_TO_LLM);

  logger.info(
    `Анализ темы "${topic}": постов в окне ${posts.length}, после ключевых слов ${keywordMatches.length}, ` +
      `отправляется в ИИ ${candidates.length}${usedKeywordFallback ? ' (fallback — ключевые слова ничего не нашли)' : ''}`
  );

  const aiResult = await summarizeWithGemini(
    topic,
    candidates.map((post, index) => ({ index, text: post.text }))
  );

  const channelTitles = new Map((await listChannels(userId)).map((c) => [c.username, c.title]));

  const items: ResultItem[] = aiResult.relevant
    .filter((r) => candidates[r.index] !== undefined)
    .map((r) => {
      const post = candidates[r.index];
      return {
        channel: post.channel,
        channelTitle: channelTitles.get(post.channel) ?? null,
        messageId: post.messageId,
        postedAtUnix: post.postedAt,
        postedAtFormatted: formatMoscowTime(post.postedAt),
        text: post.text,
        link: toLink(post.channel, post.messageId, post.isPrivate),
        gist: r.gist,
      };
    })
    .sort((a, b) => b.postedAtUnix - a.postedAtUnix);

  return {
    ...baseResult,
    postsSentToAi: candidates.length,
    usedKeywordFallback,
    summary: aiResult.summary,
    items,
    tookMs: Date.now() - startedAt,
  };
}
