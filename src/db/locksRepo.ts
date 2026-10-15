import { getDb } from './database';

/**
 * Lease в service_locks: взять, если свободен, истёк или уже наш (тогда это
 * продление). Нужен, чтобы MTProto-клиенты, планировщик и polling бота жили
 * ровно в одном процессе — при деплое Render старый и новый инстанс какое-то
 * время работают одновременно (риск AUTH_KEY_DUPLICATED и 409 у polling).
 */
export async function tryAcquireLease(name: string, owner: string, ttlSec: number, now: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    sql: `INSERT INTO service_locks (name, owner, expires_at) VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
          WHERE service_locks.owner = excluded.owner OR service_locks.expires_at <= ?`,
    args: [name, owner, now + ttlSec, now],
  });
  return result.rowsAffected === 1;
}

export async function releaseLease(name: string, owner: string): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: 'DELETE FROM service_locks WHERE name = ? AND owner = ?', args: [name, owner] });
}
