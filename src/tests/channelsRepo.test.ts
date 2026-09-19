import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import { closeDb } from '../db/database';
import { getOrCreateSoleUser } from '../db/usersRepo';
import {
  listChannels,
  listActiveChannelUsernames,
  getChannel,
  upsertChannel,
  setChannelActive,
  removeChannel,
} from '../db/channelsRepo';

test('channelsRepo: полный цикл CRUD скопирован per-user', async () => {
  const userId = await getOrCreateSoleUser();

  assert.deepEqual(await listChannels(userId), []);

  const created = await upsertChannel(userId, '@testchan', 'Test Channel');
  assert.equal(created.username, '@testchan');
  assert.equal(created.title, 'Test Channel');
  assert.equal(created.isActive, true);
  assert.equal(created.isPrivate, false);

  assert.deepEqual(await listActiveChannelUsernames(userId), ['@testchan']);

  const fetched = await getChannel(userId, '@testchan');
  assert.equal(fetched?.title, 'Test Channel');

  const deactivated = await setChannelActive(userId, '@testchan', false);
  assert.equal(deactivated?.isActive, false);
  assert.deepEqual(await listActiveChannelUsernames(userId), []);

  const removed = await removeChannel(userId, '@testchan');
  assert.equal(removed, true);
  assert.deepEqual(await listChannels(userId), []);

  closeDb();
});

test('channelsRepo: один и тот же channel_identifier у двух разных user_id не конфликтует', async () => {
  const userA = await getOrCreateSoleUser();
  // getOrCreateSoleUser всегда возвращает один и тот же id в этом
  // прототипе — здесь вставляем второго пользователя напрямую, чтобы
  // проверить именно то, что защищает UNIQUE(user_id, channel_identifier).
  const { getDb } = await import('../db/database');
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const insertResult = await db.execute({
    sql: 'INSERT INTO users (created_at, status, last_active_at) VALUES (?, ?, ?)',
    args: [now, 'active', now],
  });
  const userB = Number(insertResult.lastInsertRowid);

  await upsertChannel(userA, '@shared', 'Shared A');
  await upsertChannel(userB, '@shared', 'Shared B');

  assert.equal((await getChannel(userA, '@shared'))?.title, 'Shared A');
  assert.equal((await getChannel(userB, '@shared'))?.title, 'Shared B');

  closeDb();
});
