import { getDb } from './database';

/**
 * Прототип работает как один локальный оператор — полноценного экрана
 * входа ещё нет (см. docs/tech-stack-final.md, "Что сознательно не
 * входит в этот этап"). Эта функция — мост к многопользовательской схеме
 * без логина: если пользователей ещё нет, создаёт единственного; если
 * есть — возвращает первого (сейчас их всегда ровно один).
 */
export async function getOrCreateSoleUser(): Promise<number> {
  const db = await getDb();
  const existing = await db.execute('SELECT id FROM users ORDER BY id LIMIT 1');
  if (existing.rows.length > 0) {
    return Number((existing.rows[0] as unknown as { id: number }).id);
  }
  const now = Math.floor(Date.now() / 1000);
  const result = await db.execute({
    sql: 'INSERT INTO users (created_at, status, last_active_at) VALUES (?, ?, ?)',
    args: [now, 'active', now],
  });
  return Number(result.lastInsertRowid);
}
