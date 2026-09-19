import type { TelegramClient } from 'teleproto';
import { getDb } from './database';
import { getOrCreateSoleUser } from './usersRepo';
import { hasAccount, upsertAccount } from './telegramAccountsRepo';
import { logger } from '../utils/logger';

/**
 * Однооператорский мост к многопользовательской схеме (см. usersRepo.ts):
 * при первом запуске создаёт единственный users-row и привязывает к нему
 * текущий Telegram-аккаунт из SESSION_STRING в .env, запросив реальные
 * phone/telegram_user_id через client.getMe() — не заглушку. При
 * повторных запусках — no-op, getMe() не вызывается снова.
 */
export async function ensureDefaultUser(client: TelegramClient): Promise<number> {
  const userId = await getOrCreateSoleUser();
  if (await hasAccount(userId)) {
    return userId;
  }

  const me: any = await client.getMe();
  const sessionString = client.session.save() as unknown as string;

  await upsertAccount(userId, {
    telegramUserId: Number(me.id.toString()),
    phoneNumber: String(me.phone || ''),
    sessionString,
  });
  logger.info(`Telegram-аккаунт привязан к пользователю #${userId} (telegram_user_id=${me.id})`);
  return userId;
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
