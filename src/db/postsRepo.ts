import { getDb } from './database';

export interface PostRow {
  id: number;
  channel_username: string;
  message_id: number;
  text: string;
  posted_at: number;
  fetched_at: number;
}

export interface NewPost {
  channelUsername: string;
  messageId: number;
  text: string;
  postedAt: number;
}

/**
 * Вставляет посты пачкой. Дубликаты (тот же канал + message_id) тихо
 * пропускаются благодаря UNIQUE-ограничению — это и есть дедуп при
 * повторном опросе одного и того же окна времени.
 * Возвращает, сколько строк реально добавилось.
 */
export function insertPosts(posts: NewPost[]): number {
  if (posts.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO posts (channel_username, message_id, text, posted_at, fetched_at)
     VALUES (@channelUsername, @messageId, @text, @postedAt, @fetchedAt)`
  );
  const fetchedAt = Math.floor(Date.now() / 1000);

  // node:sqlite не даёт готового db.transaction(fn) как better-sqlite3 —
  // оборачиваем вручную, чтобы вставка пачки постов была одной транзакцией
  // (быстрее и атомарно: либо весь фетч канала сохранился, либо ни один пост).
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const row of posts) {
      const result = stmt.run({ ...row, fetchedAt });
      inserted += Number(result.changes);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return inserted;
}

/** Посты из активных каналов не старше cutoff (unix-секунды), самые новые первыми. */
export function getPostsSince(cutoffUnixSeconds: number, limit: number): PostRow[] {
  return getDb()
    .prepare(
      `SELECT posts.* FROM posts
       JOIN channels ON channels.username = posts.channel_username
       WHERE channels.is_active = 1 AND posts.posted_at >= ?
       ORDER BY posts.posted_at DESC
       LIMIT ?`
    )
    .all(cutoffUnixSeconds, limit) as unknown as PostRow[];
}
