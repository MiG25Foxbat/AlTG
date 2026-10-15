import { IUserBotReader } from '../UserBotModule/IUserBotReader';
import { fetchRecentPosts, fetchRecentPrivatePosts } from '../FetchModule/fetchService';
import { loadUnifiedPosts, UnifiedPost } from '../AiModule/analyzeService';
import { maxUrgency } from '../AiModule/reportValidator';
import { listChannels, listActiveChannelUsernames, listActivePrivateChannelIds } from '../../db/channelsRepo';
import { listTopics, resolveTopicChannels, TopicSettings } from '../../db/alertsRepo';
import { getSessionStatus } from '../../db/telegramAccountsRepo';
import {
  ScheduledTopic,
  listActiveTopicsWithDestination,
  seenPostKeys,
  saveTopicCheck,
  markTopicFailed,
  earliestHeldAt,
  countReleasedSince,
  listHeldByTopic,
  releaseReports,
  postponeReports,
  listReauthReminders,
  enqueueReauthReminder,
  cleanupAlertData,
  postKey,
  NewReport,
} from '../../db/reportsRepo';
import { analyzeTopicPosts, toMessageItems, GenerateReport } from './pipeline';
import { holdUntil, isLoud, mskDayStart } from './holdPolicy';
import { buildAlertMessages, escapeHtml } from './messageFormat';
import { Notifier } from './notifier';
import { processOutbox, RateLimiter } from './sender';
import { logger } from '../../utils/logger';

/**
 * Планировщик алертов (ТЗ, «Циклы и поток данных»):
 * 1. подписки, у которых подошло время → один fetch на пользователя →
 *    по каждой подписке новые посты → один вызов LLM → проверка пунктов →
 *    отчёт сразу или придержать;
 * 2. выпуск придержанного (склейка отчётов подписки в одно сообщение);
 * 3. напоминание о переподключении личной сессии — раз в сутки;
 * плюс отдельный частый тик отправщика очереди.
 * Работает только в процессе, который держит замок (server.ts).
 */

const DAY = 86400;

export interface SchedulerDeps {
  userBot: IUserBotReader;
  generate?: GenerateReport;
  /** PUBLIC_BASE_URL — для ссылок «переподключите аккаунт» */
  siteUrl?: string | null;
}

/** Откуда брать посты: с прошлой успешной проверки (первая — за интервал), но не дальше суток. */
function windowStart(t: ScheduledTopic, now: number): number {
  return Math.max(now - DAY, t.checkedUntil ?? now - t.topic.settings.intervalMinutes * 60);
}

const isDue = (t: ScheduledTopic, now: number) =>
  t.lastRunAt === null || t.lastRunAt + t.topic.settings.intervalMinutes * 60 <= now;

interface UserContext {
  posts: UnifiedPost[];
  publicIds: string[];
  privateIds: string[];
  privatePaused: boolean;
  titles: Map<string, string | null>;
}

export async function runDueTopics(deps: SchedulerDeps, now: number): Promise<void> {
  const byUser = new Map<number, ScheduledTopic[]>();
  for (const t of await listActiveTopicsWithDestination()) {
    if (isDue(t, now)) byUser.set(t.userId, [...(byUser.get(t.userId) ?? []), t]);
  }
  for (const [userId, topics] of byUser) {
    try {
      await checkUserTopics(deps, userId, topics, now);
    } catch (error) {
      logger.error(`Проверка подписок пользователя #${userId} не удалась:`, error);
    }
  }
}

async function checkUserTopics(deps: SchedulerDeps, userId: number, topics: ScheduledTopic[], now: number): Promise<void> {
  const cutoff = Math.min(...topics.map((t) => windowStart(t, now)));
  // Каналы пользователя читаем ОДИН раз на все его подписки. Отвалившуюся личную
  // сессию fetchRecentPrivatePosts сам помечает needs_reauth.
  await Promise.all([
    fetchRecentPosts(deps.userBot, userId, cutoff),
    fetchRecentPrivatePosts(userId, cutoff).catch((error) =>
      logger.error(`Приватные каналы пользователя #${userId} не прочитаны:`, error)
    ),
  ]);
  const privatePaused = (await getSessionStatus(userId)) === 'needs_reauth';
  const [posts, publicIds, privateIds, channels] = await Promise.all([
    loadUnifiedPosts(userId, cutoff, undefined, !privatePaused),
    listActiveChannelUsernames(userId),
    listActivePrivateChannelIds(userId),
    listChannels(userId),
  ]);
  const ctx: UserContext = { posts, publicIds, privateIds, privatePaused, titles: new Map(channels.map((c) => [c.username, c.title])) };

  for (const t of topics) {
    try {
      await checkTopic(deps, t, ctx, now);
    } catch (error: any) {
      logger.error(`Алерт «${t.topic.label}»: проверка не удалась — ${error?.message || error}`);
      await markTopicFailed(t.topic.id, now, windowStart(t, now));
    }
  }
}

async function checkTopic(deps: SchedulerDeps, t: ScheduledTopic, ctx: UserContext, now: number): Promise<void> {
  const settings = t.topic.settings;
  const scope = await resolveTopicChannels(t.userId, settings);
  const inScope = (channel: string) => !scope || scope.has(channel);
  // Подписка целиком из приватных каналов, а личная сессия отвалилась — на паузе до
  // переподключения (время проверки не двигаем, чтобы потом добрать до суток назад).
  if (ctx.privatePaused && !ctx.publicIds.some(inScope) && ctx.privateIds.some(inScope)) return;

  const from = windowStart(t, now);
  const seen = await seenPostKeys(t.topic.id);
  const fresh = ctx.posts.filter(
    (p) => p.postedAt >= from && inScope(p.channel) && !seen.has(postKey(p.channel, p.messageId))
  );

  const analysis = await analyzeTopicPosts(t.topic.label, fresh, deps.generate);
  for (const r of analysis.rejected) {
    logger.warn(`Алерт «${t.topic.label}»: пункт выкинут (${r.reason}): ${JSON.stringify(r.item).slice(0, 300)}`);
  }

  let report: NewReport | null = null;
  if (analysis.valid.length >= settings.minMatches) {
    const urgency = maxUrgency(analysis.valid.map((v) => v.urgency));
    const loud = isLoud(urgency, settings.loudFrom);
    report = {
      urgency,
      loud,
      items: toMessageItems(analysis.valid, ctx.titles),
      holdUntil: holdUntil({
        now,
        loud,
        settings,
        pausedUntil: t.pausedUntil,
        firstHeldAt: (await earliestHeldAt(t.topic.id)) ?? now,
        releasedToday: await countReleasedSince(t.topic.id, mskDayStart(now)),
      }),
    };
  }
  const cited = new Set(analysis.valid.flatMap((v) => v.sources.map((p) => postKey(p.channel, p.messageId))));
  await saveTopicCheck(
    t.topic.id,
    analysis.processed.map((p) => ({ channel: p.channel, messageId: p.messageId, cited: cited.has(postKey(p.channel, p.messageId)) })),
    report,
    now
  );
}

async function topicHasPrivateChannels(userId: number, settings: TopicSettings): Promise<boolean> {
  const scope = await resolveTopicChannels(userId, settings);
  return (await listActivePrivateChannelIds(userId)).some((id) => !scope || scope.has(id));
}

/**
 * Выпуск придержанного: по каждой подписке отчёты, чьё время пришло, склеиваем
 * в одно сообщение. Условия могли поменяться (поставили паузу, ушёл лимит) —
 * поэтому для обычных задержку пересчитываем ещё раз прямо здесь.
 */
export async function releaseDueReports(siteUrl: string | null | undefined, now: number): Promise<void> {
  for (const g of await listHeldByTopic()) {
    const due = g.reports.filter((r) => r.holdUntil <= now);
    if (due.length === 0) continue;
    const ids = due.map((r) => r.id);
    const loud = due.some((r) => r.loud);
    if (!loud) {
      const hold = holdUntil({
        now,
        loud,
        settings: g.topic.settings,
        pausedUntil: g.pausedUntil,
        firstHeldAt: Math.min(...g.reports.map((r) => r.createdAt)),
        releasedToday: await countReleasedSince(g.topic.id, mskDayStart(now)),
      });
      if (hold > now) {
        await postponeReports(ids, hold);
        continue;
      }
    }
    const privateChannelsPaused =
      (await getSessionStatus(g.userId)) === 'needs_reauth' && (await topicHasPrivateChannels(g.userId, g.topic.settings));
    const parts = buildAlertMessages({
      topicId: g.topic.id,
      topicLabel: g.topic.label,
      reportId: Math.max(...ids),
      items: due.flatMap((r) => r.items),
      now,
      privateChannelsPaused,
      siteUrl,
    });
    await releaseReports(ids, g.destinationId, parts, !loud, now);
  }
}

/** Личная сессия отвалилась — сообщение со ссылкой; повтор через сутки, пока не переподключится. */
export async function sendReauthReminders(siteUrl: string | null | undefined, now: number): Promise<void> {
  const link = siteUrl ? `<a href="${escapeHtml(siteUrl)}">переподключите аккаунт на сайте</a>` : 'переподключите аккаунт на сайте';
  const text =
    '⚠️ Ваш личный Telegram-аккаунт отключился от сервиса — приватные каналы сейчас не проверяются ' +
    `(публичные проверяются как обычно). Чтобы вернуть приватные, ${link}. Напомню через сутки.`;
  for (const r of await listReauthReminders(now)) {
    await enqueueReauthReminder(r.userId, r.destinationId, [{ text, replyMarkup: null }], now);
  }
}

/** Один тик планировщика (раз в минуту). */
export async function schedulerTick(deps: SchedulerDeps, now: number): Promise<void> {
  await runDueTopics(deps, now);
  await releaseDueReports(deps.siteUrl, now);
  await sendReauthReminders(deps.siteUrl, now);
  await cleanupAlertData(now);
}

/**
 * «Что пришло бы сейчас» для сайта: тот же конвейер (один fetch, LLM на
 * подписку, проверка пунктов, сборка сообщения), но всухую — без учёта уже
 * разобранных постов и придержки, ничего не пишет и не отправляет.
 */
export async function previewAlerts(deps: SchedulerDeps, userId: number, now: number) {
  const topics = (await listTopics(userId)).filter((t) => t.isActive);
  if (topics.length === 0) return [];
  const cutoff = now - Math.max(...topics.map((t) => t.settings.intervalMinutes)) * 60;
  await Promise.all([
    fetchRecentPosts(deps.userBot, userId, cutoff),
    fetchRecentPrivatePosts(userId, cutoff).catch((error) => logger.error('Превью: приватные каналы не прочитаны:', error)),
  ]);
  const privatePaused = (await getSessionStatus(userId)) === 'needs_reauth';
  const posts = await loadUnifiedPosts(userId, cutoff, undefined, !privatePaused);
  const titles = new Map((await listChannels(userId)).map((c) => [c.username, c.title]));

  const results = [];
  for (const topic of topics) {
    try {
      const scope = await resolveTopicChannels(userId, topic.settings);
      if (scope && scope.size === 0) {
        results.push({ topicId: topic.id, topic: topic.label, wouldSend: false, error: 'В выбранных группах/каналах нет каналов' });
        continue;
      }
      const inWindow = posts.filter((p) => p.postedAt >= now - topic.settings.intervalMinutes * 60 && (!scope || scope.has(p.channel)));
      const analysis = await analyzeTopicPosts(topic.label, inWindow, deps.generate);
      const items = toMessageItems(analysis.valid, titles);
      const wouldSend = items.length >= topic.settings.minMatches;
      results.push({
        topicId: topic.id,
        topic: topic.label,
        wouldSend,
        postsInWindow: inWindow.length,
        sentToAi: analysis.sentToAi,
        rejected: analysis.rejected.length,
        urgency: items.length ? maxUrgency(items.map((i) => i.urgency)) : null,
        messages: wouldSend
          ? buildAlertMessages({ topicId: topic.id, topicLabel: topic.label, reportId: 0, items, now }).map((p) => p.text)
          : [],
      });
    } catch (error: any) {
      results.push({ topicId: topic.id, topic: topic.label, wouldSend: false, error: error?.message || 'Ошибка анализа' });
    }
  }
  return results;
}

/**
 * Фоновые циклы: планировщик раз в минуту, отправщик очереди раз в секунду
 * (если есть чем слать). Тики не накладываются: следующий — после конца
 * предыдущего. Возвращает stop().
 */
export function startWorker(deps: SchedulerDeps & { notifier?: Notifier }): () => void {
  let stopped = false;
  const stops: (() => void)[] = [];
  const loop = (name: string, everyMs: number, fn: () => Promise<unknown>) => {
    let timer: NodeJS.Timeout;
    const run = async () => {
      try {
        await fn();
      } catch (error) {
        logger.error(`${name}: ошибка тика`, error);
      }
      if (!stopped) timer = setTimeout(run, everyMs);
    };
    timer = setTimeout(run, 0);
    stops.push(() => clearTimeout(timer));
  };

  loop('Планировщик алертов', 60_000, () => schedulerTick(deps, Math.floor(Date.now() / 1000)));
  if (deps.notifier) {
    const notifier = deps.notifier;
    const limiter = new RateLimiter();
    loop('Отправщик алертов', 1000, () => processOutbox(notifier, limiter));
  }
  return () => {
    stopped = true;
    stops.forEach((stop) => stop());
  };
}
