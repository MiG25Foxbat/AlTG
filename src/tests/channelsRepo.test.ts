import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import { closeDb } from '../db/database';
import { getOrCreateSoleUser } from '../db/usersRepo';
import {
  listChannels,
  listActiveChannelUsernames,
  listActivePrivateChannelIds,
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

test('channelsRepo: приватный канал помечен isPrivate и разведён по спискам с публичным', async () => {
  const userId = await getOrCreateSoleUser();

  await upsertChannel(userId, '@publicchan', 'Public', false);
  const privateChannel = await upsertChannel(userId, '-1001234567890', 'Private Chat', true);
  assert.equal(privateChannel.isPrivate, true);

  // deepEqual тут не подходит: userId переиспользуется предыдущими тестами
  // файла (getOrCreateSoleUser всегда возвращает один и тот же id), у него
  // уже могут быть другие публичные каналы — проверяем именно разведение
  // по приватности, а не точный состав списка.
  const publicIds = await listActiveChannelUsernames(userId);
  assert.ok(publicIds.includes('@publicchan'));
  assert.ok(!publicIds.includes('-1001234567890'));
  assert.deepEqual(await listActivePrivateChannelIds(userId), ['-1001234567890']);

  closeDb();
});
