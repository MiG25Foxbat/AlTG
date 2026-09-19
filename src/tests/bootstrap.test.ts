import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.DB_PATH = ':memory:';
process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { getDb, closeDb } from '../db/database';
import { migrateLegacyData, ensureDefaultUser } from '../db/bootstrap';
import { getOrCreateSoleUser } from '../db/usersRepo';
import { getDecryptedAccount } from '../db/telegramAccountsRepo';
import { listChannels } from '../db/channelsRepo';
import { getPostsSince } from '../db/postsRepo';

test('migrateLegacyData: переносит старые channels/posts в новую схему и удаляет старые таблицы', async () => {
  const db = await getDb();
  await db.batch(
    [
      `CREATE TABLE channels (username TEXT PRIMARY KEY, title TEXT, added_at INTEGER NOT NULL, is_active INTEGER NOT NULL DEFAULT 1)`,
      `CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_username TEXT NOT NULL, message_id INTEGER NOT NULL, text TEXT NOT NULL, posted_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL, UNIQUE(channel_username, message_id))`,
      {
        sql: `INSERT INTO channels VALUES (?, ?, ?, ?)`,
        args: ['@oldchan', 'Old Channel', 1000, 1],
      },
      {
        sql: `INSERT INTO posts (channel_username, message_id, text, posted_at, fetched_at) VALUES (?, ?, ?, ?, ?)`,
        args: ['@oldchan', 1, 'привет', 2000, 2000],
      },
    ],
    'write'
  );

  const userId = await getOrCreateSoleUser();
  await migrateLegacyData(userId);

  const channels = await listChannels(userId);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].username, '@oldchan');

  const posts = await getPostsSince(userId, 0, 10);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, 'привет');

  const tables = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channels', 'posts')`
  );
  assert.equal(tables.rows.length, 0);

  await migrateLegacyData(userId); // повторный запуск — no-op, не падает и не дублирует
  assert.equal((await listChannels(userId)).length, 1);

  closeDb();
});

test('ensureDefaultUser: создаёт users+telegram_accounts из client.getMe(), повторный вызов — no-op', async () => {
  const fakeClient: any = {
    getMe: async () => ({ id: 987654321, phone: '79990001122' }),
    session: { save: () => 'FAKE_SESSION_STRING' },
  };

  const userId = await ensureDefaultUser(fakeClient);
  const account = await getDecryptedAccount(userId);
  assert.deepEqual(account, {
    telegramUserId: 987654321,
    phoneNumber: '79990001122',
    sessionString: 'FAKE_SESSION_STRING',
  });

  let calledAgain = false;
  const secondFakeClient: any = {
    getMe: async () => {
      calledAgain = true;
      return { id: 111, phone: '111' };
    },
    session: { save: () => 'SHOULD_NOT_BE_USED' },
  };
  const userIdAgain = await ensureDefaultUser(secondFakeClient);
  assert.equal(userIdAgain, userId);
  assert.equal(calledAgain, false); // аккаунт уже привязан — getMe() не должен вызываться повторно

  closeDb();
});
