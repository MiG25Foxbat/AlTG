import { getDb } from './database';
import { TopicDto, TopicRow, topicFromRow, Urgency } from './alertsRepo';
import { enqueueStatements } from './outboxRepo';
import { MessageItem, OutgoingPart } from '../modules/AlertModule/messageFormat';

/**
 * Отчёты алертов и всё, что вокруг них: какие посты подписка уже разобрала,
 * придержанные отчёты, выпуск в outbox. Время — unix-секунды.
 */

const DAY = 86400;

/** Активный получатель подписки: явный destination_id или личный чат владельца. */
const DESTINATION_JOIN = `JOIN alert_destinations d ON d.status = 'active' AND (
  d.id = t.destination_id OR (t.destination_id IS NULL AND d.user_id = t.user_id AND d.kind = 'telegram_private'))`;

export interface ScheduledTopic {
  topic: TopicDto;
  userId: number;
  lastRunAt: number | null;
  checkedUntil: number | null;
  destinationId: number;
  pausedUntil: number | null;
}

/** Включённые подписки, которым есть куда слать (без привязанного бота проверять незачем). */
export async function listActiveTopicsWithDestination(): Promise<ScheduledTopic[]> {
  const db = await getDb();
  const result = await db.execute(`
    SELECT t.id, t.user_id, t.label, t.is_active, t.settings_json, t.last_run_at, t.checked_until,
           d.id AS destination_id, d.paused_until
    FROM topics t ${DESTINATION_JOIN}
    WHERE t.is_active = 1
    ORDER BY t.user_id, t.id`);
  return (result.rows as any[]).map((r) => ({
    topic: topicFromRow(r as TopicRow),
    userId: r.user_id,
    lastRunAt: r.last_run_at,
    checkedUntil: r.checked_until,
    destinationId: r.destination_id,
    pausedUntil: r.paused_until,
  }));
}

export const postKey = (channel: string, messageId: number) => `${channel}:${messageId}`;

export async function seenPostKeys(topicId: number): Promise<Set<string>> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT channel_identifier, message_id FROM topic_seen_posts WHERE topic_id = ?',
    args: [topicId],
  });
  return new Set((result.rows as any[]).map((r) => postKey(r.channel_identifier, r.message_id)));
}

export interface NewReport {
  urgency: Urgency;
  loud: boolean;
  items: MessageItem[];
  holdUntil: number;
}

export interface ProcessedPost {
  channel: string;
  messageId: number;
  /** Пост — источник пункта в отчёте */
  cited: boolean;
}

/**
 * Итог успешной проверки подписки — одной транзакцией: отчёт (если набралось),
 * все разобранные посты (чтобы не гонять их через LLM снова) и время проверки.
 * id нового отчёта берём подзапросом MAX(id) внутри той же транзакции.
 */
export async function saveTopicCheck(topicId: number, processed: ProcessedPost[], report: NewReport | null, now: number): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      ...(report
        ? [
            {
              sql: `INSERT INTO alert_reports (topic_id, urgency, loud, items_json, status, hold_until, created_at)
                    VALUES (?, ?, ?, ?, 'held', ?, ?)`,
              args: [topicId, report.urgency, report.loud ? 1 : 0, JSON.stringify(report.items), report.holdUntil, now],
            },
          ]
        : []),
      ...processed.map((p) => ({
        sql: `INSERT OR IGNORE INTO topic_seen_posts (topic_id, channel_identifier, message_id, report_id, seen_at)
              VALUES (?, ?, ?, CASE WHEN ? THEN (SELECT MAX(id) FROM alert_reports WHERE topic_id = ?) END, ?)`,
        args: [topicId, p.channel, p.messageId, report && p.cited ? 1 : 0, topicId, now],
      })),
      { sql: 'UPDATE topics SET last_run_at = ?, checked_until = ? WHERE id = ?', args: [now, now, topicId] },
    ],
    'write'
  );
}

/**
 * Проверка не удалась (LLM, сеть): следующая попытка — через интервал, посты
 * остаются неразобранными. Если это была первая проверка, запоминаем начало
 * её окна — иначе окно следующей уедет вперёд и эти посты потеряются.
 */
export async function markTopicFailed(topicId: number, now: number, windowStart: number): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE topics SET last_run_at = ?, checked_until = COALESCE(checked_until, ?) WHERE id = ?',
    args: [now, windowStart, topicId],
  });
}

export async function earliestHeldAt(topicId: number): Promise<number | null> {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT MIN(created_at) AS t FROM alert_reports WHERE topic_id = ? AND status = 'held'`,
    args: [topicId],
  });
  return (result.rows[0] as any)?.t ?? null;
}

/** Сколько алертов (выпусков) по подписке ушло с момента since. */
export async function countReleasedSince(topicId: number, since: number): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT COUNT(DISTINCT released_at) AS n FROM alert_reports WHERE topic_id = ? AND status = 'released' AND released_at >= ?`,
    args: [topicId, since],
  });
  return Number((result.rows[0] as any).n);
}

export interface HeldReport {
  id: number;
  loud: boolean;
  items: MessageItem[];
  holdUntil: number;
  createdAt: number;
}

export interface HeldTopic {
  topic: TopicDto;
  userId: number;
  destinationId: number;
  pausedUntil: number | null;
  reports: HeldReport[];
}

/** Придержанные отчёты включённых подписок с активным получателем, по подпискам. */
export async function listHeldByTopic(): Promise<HeldTopic[]> {
  const db = await getDb();
  const result = await db.execute(`
    SELECT r.id AS report_id, r.loud, r.items_json, r.hold_until, r.created_at,
           t.id, t.user_id, t.label, t.is_active, t.settings_json, d.id AS destination_id, d.paused_until
    FROM alert_reports r JOIN topics t ON t.id = r.topic_id ${DESTINATION_JOIN}
    WHERE r.status = 'held' AND t.is_active = 1
    ORDER BY r.id`);
  const byTopic = new Map<number, HeldTopic>();
  for (const r of result.rows as any[]) {
    if (!byTopic.has(r.id)) {
      byTopic.set(r.id, {
        topic: topicFromRow(r as TopicRow),
        userId: r.user_id,
        destinationId: r.destination_id,
        pausedUntil: r.paused_until,
        reports: [],
      });
    }
    byTopic.get(r.id)!.reports.push({
      id: r.report_id,
      loud: r.loud === 1,
      items: JSON.parse(r.items_json),
      holdUntil: r.hold_until,
      createdAt: r.created_at,
    });
  }
  return [...byTopic.values()];
}

const placeholders = (n: number) => Array(n).fill('?').join(', ');

/** Выпуск: сообщение в outbox и отчёты в released — атомарно, чтобы не потерять и не задвоить. */
export async function releaseReports(
  reportIds: number[],
  destinationId: number,
  parts: OutgoingPart[],
  disableNotification: boolean,
  now: number
): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      ...enqueueStatements(destinationId, parts, disableNotification, now),
      {
        sql: `UPDATE alert_reports SET status = 'released', released_at = ? WHERE id IN (${placeholders(reportIds.length)})`,
        args: [now, ...reportIds],
      },
    ],
    'write'
  );
}

export async function postponeReports(reportIds: number[], until: number): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE alert_reports SET hold_until = ? WHERE id IN (${placeholders(reportIds.length)})`,
    args: [until, ...reportIds],
  });
}

/** Кому пора напомнить про отвалившуюся личную сессию: не чаще раза в сутки. */
export async function listReauthReminders(now: number): Promise<{ userId: number; destinationId: number }[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT ta.user_id, d.id AS destination_id FROM telegram_accounts ta
          JOIN alert_destinations d ON d.user_id = ta.user_id AND d.kind = 'telegram_private' AND d.status = 'active'
          WHERE ta.session_status = 'needs_reauth' AND (ta.reauth_notified_at IS NULL OR ta.reauth_notified_at <= ?)`,
    args: [now - DAY],
  });
  return (result.rows as any[]).map((r) => ({ userId: r.user_id, destinationId: r.destination_id }));
}

export async function enqueueReauthReminder(userId: number, destinationId: number, parts: OutgoingPart[], now: number): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      ...enqueueStatements(destinationId, parts, true, now),
      { sql: 'UPDATE telegram_accounts SET reauth_notified_at = ? WHERE user_id = ?', args: [now, userId] },
    ],
    'write'
  );
}

/** Старьё: окно постов — максимум сутки, остальное нужно только для разбора полётов. */
export async function cleanupAlertData(now: number): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      { sql: 'DELETE FROM topic_seen_posts WHERE seen_at < ?', args: [now - 3 * DAY] },
      { sql: 'DELETE FROM alert_reports WHERE created_at < ?', args: [now - 7 * DAY] },
      { sql: `DELETE FROM outbox WHERE status IN ('sent', 'failed') AND created_at < ?`, args: [now - 7 * DAY] },
      { sql: 'DELETE FROM bot_link_tokens WHERE expires_at < ?', args: [now] },
    ],
    'write'
  );
}
