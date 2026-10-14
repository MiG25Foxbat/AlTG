import { createHash, randomBytes } from 'node:crypto';
import { getDb } from './database';

/** Куда доставлять: личка с ботом; группа компании и почта — заложены, пока не используются. */
export type DestinationKind = 'telegram_private' | 'telegram_group' | 'email';

export interface Destination {
  id: number;
  userId: number;
  kind: DestinationKind;
  chatId: number | null;
  threadId: number | null;
  email: string | null;
}

/**
 * Получатель заблокировал бота (403 при отправке или my_chat_member=kicked):
 * помечаем и сразу снимаем с очереди всё, что ему ещё не ушло, — после
 * разблокировки старые алерты уже неактуальны.
 */
export async function markDestinationBlocked(destinationId: number): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      { sql: `UPDATE alert_destinations SET status = 'blocked' WHERE id = ?`, args: [destinationId] },
      {
        sql: `UPDATE outbox SET status = 'failed', locked_at = NULL, last_error = 'получатель заблокировал бота'
              WHERE destination_id = ? AND status IN ('pending', 'sending')`,
        args: [destinationId],
      },
    ],
    'write'
  );
}

export interface PrivateChatLink {
  destinationId: number;
  userId: number;
  chatId: number;
  status: string;
  pausedUntil: number | null;
}

const LINK_COLUMNS = 'id AS destinationId, user_id AS userId, chat_id AS chatId, status, paused_until AS pausedUntil';

/** Чей это личный чат с ботом (кнопки и команды бота работают от имени этого пользователя). */
export async function getLinkByChat(chatId: number): Promise<PrivateChatLink | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT ${LINK_COLUMNS} FROM alert_destinations WHERE kind = 'telegram_private' AND chat_id = ?`,
    args: [chatId],
  });
  return result.rows[0] as unknown as PrivateChatLink | undefined;
}

export async function getLinkByUser(userId: number): Promise<PrivateChatLink | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT ${LINK_COLUMNS} FROM alert_destinations WHERE kind = 'telegram_private' AND user_id = ?`,
    args: [userId],
  });
  return result.rows[0] as unknown as PrivateChatLink | undefined;
}

/**
 * Привязать личный чат к пользователю: один чат — один пользователь, у
 * пользователя один личный чат. Если этот чат был привязан к другому
 * аккаунту — привязка переезжает. Строку пользователя обновляем на месте,
 * чтобы не потерять его очередь.
 */
export async function linkPrivateChat(userId: number, chatId: number, now: number): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      {
        sql: `DELETE FROM alert_destinations WHERE kind = 'telegram_private' AND chat_id = ? AND user_id <> ?`,
        args: [chatId, userId],
      },
      {
        sql: `UPDATE alert_destinations SET chat_id = ?, status = 'active' WHERE kind = 'telegram_private' AND user_id = ?`,
        args: [chatId, userId],
      },
      {
        sql: `INSERT INTO alert_destinations (user_id, kind, chat_id, status, created_at)
              SELECT ?, 'telegram_private', ?, 'active', ?
              WHERE NOT EXISTS (SELECT 1 FROM alert_destinations WHERE kind = 'telegram_private' AND user_id = ?)`,
        args: [userId, chatId, now, userId],
      },
    ],
    'write'
  );
}

/** my_chat_member в личке: kicked — пользователь заблокировал бота, member — разблокировал. */
export async function setPrivateChatStatus(chatId: number, status: 'active' | 'blocked'): Promise<void> {
  const link = await getLinkByChat(chatId);
  if (!link) return;
  if (status === 'blocked') return markDestinationBlocked(link.destinationId);
  const db = await getDb();
  await db.execute({ sql: `UPDATE alert_destinations SET status = 'active' WHERE id = ?`, args: [link.destinationId] });
}

/** Пауза из бота — на всё, что идёт этому получателю. null — снять. */
export async function setPause(destinationId: number, until: number | null): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: 'UPDATE alert_destinations SET paused_until = ? WHERE id = ?', args: [until, destinationId] });
}

// --- Одноразовые токены для t.me/<бот>?start=<токен> (запасной путь привязки) ---

export const LINK_TOKEN_TTL_SEC = 15 * 60;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** 32 символа [A-Za-z0-9_-] — влезает в payload /start (до 64). В БД — только хеш. */
export async function createLinkToken(userId: number, now: number): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  const db = await getDb();
  await db.batch(
    [
      { sql: 'DELETE FROM bot_link_tokens WHERE expires_at < ?', args: [now] },
      {
        sql: 'INSERT INTO bot_link_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
        args: [hashToken(token), userId, now + LINK_TOKEN_TTL_SEC],
      },
    ],
    'write'
  );
  return token;
}

/** Погасить токен: атомарно, ровно один раз и только до истечения срока. */
export async function consumeLinkToken(token: string, now: number): Promise<number | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: `UPDATE bot_link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id`,
    args: [now, hashToken(token), now],
  });
  const row = result.rows[0] as unknown as { user_id: number } | undefined;
  return row?.user_id;
}
