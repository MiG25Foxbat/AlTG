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
 * Вставляет посты пачкой в общий кэш public_posts (без userId — текст
 * одного и того же публичного поста одинаков для всех пользователей,
 * см. docs/tech-stack-final.md, раздел 5.3). Дубликаты (тот же канал +
 * message_id) тихо пропускаются благодаря UNIQUE-ограничению. batch()
 * оборачивает вставку в одну транзакцию сам — ручной BEGIN/COMMIT/
 * ROLLBACK, нужный для node:sqlite, здесь не требуется.
 */
export async function insertPosts(posts: NewPost[]): Promise<number> {
  if (posts.length === 0) return 0;
  const db = await getDb();
  const fetchedAt = Math.floor(Date.now() / 1000);

  const results = await db.batch(
    posts.map((post) => ({
      sql: `INSERT OR IGNORE INTO public_posts (channel_username, message_id, text, posted_at, fetched_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [post.channelUsername, post.messageId, post.text, post.postedAt, fetchedAt],
    })),
    'write'
  );
  return results.reduce((sum, r) => sum + r.rowsAffected, 0);
}

/**
 * Посты не старше cutoff (unix-секунды) из каналов, которые у ЭТОГО
 * пользователя активны — фильтр по активности теперь на user_channels
 * (per-user), не на public_posts (общий, без понятия "активен").
 */
export async function getPostsSince(
  userId: number,
  cutoffUnixSeconds: number,
  limit: number
): Promise<PostRow[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT public_posts.* FROM public_posts
          JOIN user_channels
            ON user_channels.channel_identifier = public_posts.channel_username
          WHERE user_channels.user_id = ?
            AND user_channels.is_active = 1
            AND public_posts.posted_at >= ?
          ORDER BY public_posts.posted_at DESC
          LIMIT ?`,
    args: [userId, cutoffUnixSeconds, limit],
  });
  return result.rows as unknown as PostRow[];
}
