import type { InStatement } from '@libsql/client';
import { getDb } from './database';
import { Destination } from './destinationsRepo';
import { InlineKeyboard, OutgoingPart } from '../modules/AlertModule/messageFormat';

/**
 * Очередь исходящих сообщений (ТЗ п. 3). Статусы: pending → sending →
 * sent | failed. Все времена — unix-секунды.
 */

export interface DueMessage {
  id: number;
  attempts: number;
  destination: Destination;
  textHtml: string;
  disableNotification: boolean;
  replyMarkup: InlineKeyboard | null;
}

/** Части одного алерта — подряд, в порядке частей (отправщик берёт по id). Для batch вместе с другими записями. */
export function enqueueStatements(
  destinationId: number,
  parts: OutgoingPart[],
  disableNotification: boolean,
  now: number
): InStatement[] {
  return parts.map((p) => ({
    sql: `INSERT INTO outbox (destination_id, text_html, disable_notification, reply_markup_json, next_attempt_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [destinationId, p.text, disableNotification ? 1 : 0, p.replyMarkup ? JSON.stringify(p.replyMarkup) : null, now, now],
  }));
}

export async function enqueueParts(
  destinationId: number,
  parts: OutgoingPart[],
  disableNotification: boolean,
  now: number
): Promise<void> {
  if (parts.length === 0) return;
  const db = await getDb();
  await db.batch(enqueueStatements(destinationId, parts, disableNotification, now), 'write');
}

/** Упали посреди отправки — через stuckBefore вернуть в очередь (может уйти повторно, см. handoff). */
export async function requeueStuck(stuckBefore: number): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    sql: `UPDATE outbox SET status = 'pending', locked_at = NULL WHERE status = 'sending' AND locked_at < ?`,
    args: [stuckBefore],
  });
  return result.rowsAffected;
}

export async function listDueMessages(now: number, limit: number): Promise<DueMessage[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT o.id, o.attempts, o.text_html, o.disable_notification, o.reply_markup_json,
                 d.id AS destination_id, d.user_id, d.kind, d.chat_id, d.thread_id, d.email
          FROM outbox o JOIN alert_destinations d ON d.id = o.destination_id AND d.status = 'active'
          WHERE o.status = 'pending' AND o.next_attempt_at <= ?
          ORDER BY o.id LIMIT ?`,
    args: [now, limit],
  });
  return (result.rows as any[]).map((r) => ({
    id: r.id,
    attempts: r.attempts,
    destination: {
      id: r.destination_id,
      userId: r.user_id,
      kind: r.kind,
      chatId: r.chat_id,
      threadId: r.thread_id,
      email: r.email,
    },
    textHtml: r.text_html,
    disableNotification: r.disable_notification === 1,
    replyMarkup: r.reply_markup_json ? JSON.parse(r.reply_markup_json) : null,
  }));
}

/** Забрать сообщение в отправку; false — его уже забрал кто-то другой. */
export async function claimMessage(id: number, now: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    sql: `UPDATE outbox SET status = 'sending', locked_at = ? WHERE id = ? AND status = 'pending'`,
    args: [now, id],
  });
  return result.rowsAffected === 1;
}

export async function markSent(id: number, now: number): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE outbox SET status = 'sent', sent_at = ?, locked_at = NULL, last_error = NULL WHERE id = ?`,
    args: [now, id],
  });
}

export async function scheduleRetry(id: number, attempts: number, nextAttemptAt: number, error: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE outbox SET status = 'pending', locked_at = NULL, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`,
    args: [attempts, nextAttemptAt, error, id],
  });
}

export async function markFailed(id: number, attempts: number, error: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE outbox SET status = 'failed', locked_at = NULL, attempts = ?, last_error = ? WHERE id = ?`,
    args: [attempts, error, id],
  });
}

/** 429: отложить это сообщение и всё, что ждёт этот же чат, до until. Попытку не засчитываем. */
export async function postponeDestination(destinationId: number, messageId: number, until: number): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE outbox SET status = 'pending', locked_at = NULL, next_attempt_at = MAX(next_attempt_at, ?)
          WHERE destination_id = ? AND (status = 'pending' OR id = ?)`,
    args: [until, destinationId, messageId],
  });
}
