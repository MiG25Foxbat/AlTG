import type { TelegramClient } from 'teleproto';
import { getDb } from './database';
import { getOrCreateSoleUser } from './usersRepo';
import { getDecryptedAccount, deleteAccount } from './telegramAccountsRepo';
import { logger } from '../utils/logger';

/** Гарантирует, что есть хотя бы одна строка users (нужна для migrateLegacyData). */
export async function ensureDefaultUser(): Promise<number> {
  return getOrCreateSoleUser();
}

/**
 * Общий аккаунт из .env SESSION_STRING — служебный, он не должен лежать в
 * telegram_accounts как «личный» аккаунт пользователя. Раньше старт сервера
 * записывал его туда пользователю #1; тогда общий бот и «личный» клиент
 * работали на одном ключе авторизации, и Telegram убивал сессию
 * (AUTH_KEY_DUPLICATED). Удаляем ровно такую запись — с той же самой
 * сессией. Если пользователь сам подключил этот же номер через сайт, у него
 * другая сессия (новый ключ), и её не трогаем.
 */
export async function removeSharedSessionDuplicate(client: TelegramClient): Promise<void> {
  const me: any = await client.getMe();
  const db = await getDb();
  const row = (
    await db.execute({
      sql: 'SELECT user_id FROM telegram_accounts WHERE telegram_user_id = ?',
      args: [Number(me.id.toString())],
    })
  ).rows[0] as unknown as { user_id: number } | undefined;
  if (!row) return;

  const account = await getDecryptedAccount(row.user_id);
  if (account && account.sessionString === (client.session.save() as unknown as string)) {
    await deleteAccount(row.user_id);
    logger.warn(`Удалён дубль сессии общего аккаунта у пользователя #${row.user_id}`);
  }
}

/**
 * Одноразовый перенос старых однопользовательских таблиц channels/posts
 * в новые user_channels/public_posts. Идемпотентна: если старых таблиц
 * уже нет — ничего не делает. channels переносятся под userId (на этом
 * этапе пользователь один), posts — как есть в public_posts (общий кэш,
 * без привязки к пользователю).
 */
export async function migrateLegacyData(userId: number): Promise<void> {
  const db = await getDb();
  const legacyTables = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channels', 'posts')`
  );
  if (legacyTables.rows.length === 0) {
    return; // уже мигрировано или свежая БД — переносить нечего
  }

  const channels = await db.execute('SELECT username, title, added_at, is_active FROM channels');
  const posts = await db.execute(
    'SELECT channel_username, message_id, text, posted_at, fetched_at FROM posts'
  );

  const statements: (string | { sql: string; args?: (string | number | null | boolean)[] })[] = [];

  for (const row of channels.rows as unknown as {
    username: string;
    title: string | null;
    added_at: number;
    is_active: number;
  }[]) {
    statements.push({
      sql: `INSERT OR IGNORE INTO user_channels (user_id, channel_identifier, channel_title, is_active, added_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [userId, row.username, row.title, row.is_active, row.added_at],
    });
  }

  for (const row of posts.rows as unknown as {
    channel_username: string;
    message_id: number;
    text: string;
    posted_at: number;
    fetched_at: number;
  }[]) {
    statements.push({
      sql: `INSERT OR IGNORE INTO public_posts (channel_username, message_id, text, posted_at, fetched_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [row.channel_username, row.message_id, row.text, row.posted_at, row.fetched_at],
    });
  }

  statements.push('DROP TABLE posts');
  statements.push('DROP TABLE channels');

  await db.batch(statements, 'write');
  logger.info(
    `Миграция старой схемы: перенесено ${channels.rows.length} канал(ов) и ${posts.rows.length} пост(ов), старые таблицы удалены`
  );
}
