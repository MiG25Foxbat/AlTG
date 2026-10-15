import { UnifiedPost, toLink, MAX_POSTS_SENT_TO_LLM } from '../AiModule/analyzeService';
import { extractKeywords, keywordPreFilter } from '../FilterModule/keywordFilter';
import { generateAlertReport } from '../AiModule/geminiClient';
import { validateReportItems, ValidItem, RejectedItem } from '../AiModule/reportValidator';
import { MessageItem } from './messageFormat';

/** Вызов LLM для алерта — подменяется в тестах. */
export type GenerateReport = (topic: string, posts: { index: number; text: string }[]) => Promise<unknown[]>;

export interface TopicAnalysis {
  /** Разобранные посты — их больше не отправляем в LLM для этой подписки */
  processed: UnifiedPost[];
  valid: ValidItem<UnifiedPost>[];
  rejected: RejectedItem[];
  sentToAi: number;
}

/**
 * Новые посты подписки → keyword-фильтр (ничего не нашёл — фолбэк на все
 * посты) → ОДИН вызов LLM на всю подписку → проверка каждого пункта.
 * Нет постов — нет вызова LLM. Отсеянное ключевыми словами считается
 * разобранным; не влезшее в лимит постов для LLM — нет (уйдёт в следующую проверку).
 */
export async function analyzeTopicPosts(
  topicLabel: string,
  posts: UnifiedPost[],
  generate: GenerateReport = generateAlertReport
): Promise<TopicAnalysis> {
  if (posts.length === 0) return { processed: [], valid: [], rejected: [], sentToAi: 0 };

  const matches = keywordPreFilter(posts, extractKeywords(topicLabel));
  const candidates = (matches.length > 0 ? matches : posts).slice(0, MAX_POSTS_SENT_TO_LLM);
  const matched = new Set(matches);
  const filteredOut = matches.length > 0 ? posts.filter((p) => !matched.has(p)) : [];

  const raw = await generate(topicLabel, candidates.map((p, index) => ({ index, text: p.text })));
  const { valid, rejected } = validateReportItems(raw, candidates);
  return { processed: [...candidates, ...filteredOut], valid, rejected, sentToAi: candidates.length };
}

/** Проверенные пункты → пункты сообщения: ссылки и время постов — из наших метаданных, не от модели. */
export function toMessageItems(valid: ValidItem<UnifiedPost>[], channelTitles: Map<string, string | null>): MessageItem[] {
  return valid.map((v) => ({
    text: v.text,
    urgency: v.urgency,
    sources: v.sources.map((p) => ({
      channel: p.channel,
      channelTitle: channelTitles.get(p.channel) ?? null,
      link: toLink(p.channel, p.messageId, p.isPrivate),
      postedAt: p.postedAt,
    })),
  }));
}
