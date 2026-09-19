import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import { getDb, closeDb } from '../db/database';

test('getDb: создаёт все таблицы новой многопользовательской схемы', async () => {
  const db = await getDb();
  const result = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
  );
  const names = result.rows.map((row) => (row as unknown as { name: string }).name);
  for (const expected of [
    'activity_log',
    'private_posts',
    'public_posts',
    'telegram_accounts',
    'topics',
    'user_channels',
    'users',
  ]) {
    assert.ok(names.includes(expected), `таблица ${expected} должна существовать`);
  }
  closeDb();
});

test('getDb: возвращает один и тот же singleton-клиент при повторном вызове', async () => {
  const db1 = await getDb();
  const db2 = await getDb();
  assert.equal(db1, db2);
  closeDb();
});
