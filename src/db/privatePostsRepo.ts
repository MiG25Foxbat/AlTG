import { getDb } from './database';

export interface PrivatePostRow {
  id: number;
  user_id: number;
  channel_identifier: string;
  message_id: number;
  text: string;
  posted_at: number;
  fetched_at: number;
}

export interface NewPrivatePost {
  channelIdentifier: string;
  messageId: number;
  text: string;
  postedAt: number;
}

/**
 * Посты приватных каналов — НЕ общий кэш (в отличие от public_posts):
 * привязаны к user_id, потому что получены личным Telegram-подключением
 * этого пользователя и делиться ими с другими нельзя, даже если кто-то
 * ещё состоит в том же приватном канале (см. docs/tech-stack-final.md, 5.3).
 */
export async function insertPrivatePosts(userId: number, posts: NewPrivatePost[]): Promise<number> {
  if (posts.length === 0) return 0;
  const db = await getDb();
  const fetchedAt = Math.floor(Date.now() / 1000);

  const results = await db.batch(
    posts.map((post) => ({
      sql: `INSERT OR IGNORE INTO private_posts (user_id, channel_identifier, message_id, text, posted_at, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [userId, post.channelIdentifier, post.messageId, post.text, post.postedAt, fetchedAt],
    })),
    'write'
  );
  return results.reduce((sum, r) => sum + r.rowsAffected, 0);
}

/** Посты приватных каналов пользователя не старше cutoff — уже все "свои", доп. join не нужен. */
export async function getPrivatePostsSince(
  userId: number,
  cutoffUnixSeconds: number,
  limit: number
): Promise<PrivatePostRow[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT private_posts.* FROM private_posts
          JOIN user_channels
            ON user_channels.channel_identifier = private_posts.channel_identifier
           AND user_channels.user_id = private_posts.user_id
          WHERE private_posts.user_id = ?
            AND user_channels.is_active = 1
            AND private_posts.posted_at >= ?
          ORDER BY private_posts.posted_at DESC
          LIMIT ?`,
    args: [userId, cutoffUnixSeconds, limit],
  });
  return result.rows as unknown as PrivatePostRow[];
}
