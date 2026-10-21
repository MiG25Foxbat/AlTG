import { UnifiedPost, toLink, MAX_POSTS_SENT_TO_LLM } from '../AiModule/analyzeService';
import { generateAlertReport } from '../AiModule/llmClient';
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
 * Новые посты подписки → ОДИН вызов LLM на всю подписку → проверка каждого
 * пункта. Без фильтра по ключевым словам: что относится к теме, решает модель
 * по смыслу (как в ручном поиске), — подстрочный фильтр терял посты вроде
 * «открылась кофейня» для темы «кафешки». Нет постов — нет вызова LLM.
 * Не влезшее в лимит постов для LLM не считается разобранным — уйдёт в
 * следующую проверку.
 */
export async function analyzeTopicPosts(
  topicLabel: string,
  posts: UnifiedPost[],
  generate: GenerateReport = generateAlertReport
): Promise<TopicAnalysis> {
  if (posts.length === 0) return { processed: [], valid: [], rejected: [], sentToAi: 0 };

  const candidates = posts.slice(0, MAX_POSTS_SENT_TO_LLM);
  const raw = await generate(topicLabel, candidates.map((p, index) => ({ index, text: p.text })));
  const { valid, rejected } = validateReportItems(raw, candidates);
  return { processed: candidates, valid, rejected, sentToAi: candidates.length };
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
