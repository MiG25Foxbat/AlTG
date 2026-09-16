import { IUserBotReader } from '../UserBotModule/IUserBotReader';
import { fetchRecentPosts, ChannelFetchResult } from '../FetchModule/fetchService';
import { getPostsSince, PostRow } from '../../db/postsRepo';
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

function toLink(channel: string, messageId: number): string {
  return `https://t.me/${channel.replace(/^@/, '')}/${messageId}`;
}

export async function analyzeTopic(
  userBot: IUserBotReader,
  topic: string,
  windowMinutes: number
): Promise<AnalyzeResult> {
  const startedAt = Date.now();
  const cutoff = windowMinutesToCutoff(windowMinutes);

  const fetchResults: ChannelFetchResult[] = await fetchRecentPosts(userBot, cutoff);
  const channelErrors = fetchResults
    .filter((r) => r.error)
    .map((r) => ({ channel: r.channel, error: r.error! }));

  const posts: PostRow[] = getPostsSince(cutoff, POSTS_FETCHED_FROM_DB_CAP);

  const baseResult = {
    windowMinutes,
    topic,
    channelsChecked: fetchResults.length,
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

  const channelTitles = new Map(listChannels().map((c) => [c.username, c.title]));

  const items: ResultItem[] = aiResult.relevant
    .filter((r) => candidates[r.index] !== undefined)
    .map((r) => {
      const post = candidates[r.index];
      return {
        channel: post.channel_username,
        channelTitle: channelTitles.get(post.channel_username) ?? null,
        messageId: post.message_id,
        postedAtUnix: post.posted_at,
        postedAtFormatted: formatMoscowTime(post.posted_at),
        text: post.text,
        link: toLink(post.channel_username, post.message_id),
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
