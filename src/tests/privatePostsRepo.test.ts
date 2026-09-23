import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import { closeDb } from '../db/database';
import { getOrCreateSoleUser } from '../db/usersRepo';
import { upsertChannel, setChannelActive } from '../db/channelsRepo';
import { insertPrivatePosts, getPrivatePostsSince } from '../db/privatePostsRepo';

test('privatePostsRepo: дедуп по (user, channel, message_id), фильтр по активным каналам', async () => {
  const userId = await getOrCreateSoleUser();
  await upsertChannel(userId, '-100111', 'Private active', true);
  await upsertChannel(userId, '-100222', 'Private inactive', true);
  await setChannelActive(userId, '-100222', false);

  const now = Math.floor(Date.now() / 1000);
  const inserted = await insertPrivatePosts(userId, [
    { channelIdentifier: '-100111', messageId: 1, text: 'первый', postedAt: now },
    { channelIdentifier: '-100222', messageId: 1, text: 'из выключенного', postedAt: now },
  ]);
  assert.equal(inserted, 2);

  const dedup = await insertPrivatePosts(userId, [
    { channelIdentifier: '-100111', messageId: 1, text: 'повтор', postedAt: now },
  ]);
  assert.equal(dedup, 0);

  const posts = await getPrivatePostsSince(userId, now - 3600, 100);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel_identifier, '-100111');

  closeDb();
});

test('privatePostsRepo: пост пользователя A не отдаётся пользователю B даже с тем же channel_identifier', async () => {
  const userA = await getOrCreateSoleUser();
  await upsertChannel(userA, '-100999', 'A private', true);

  const { getDb } = await import('../db/database');
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const insertResult = await db.execute({
    sql: 'INSERT INTO users (created_at, status, last_active_at) VALUES (?, ?, ?)',
    args: [now, 'active', now],
  });
  const userB = Number(insertResult.lastInsertRowid);
  await upsertChannel(userB, '-100999', 'B private, same id', true);

  await insertPrivatePosts(userA, [{ channelIdentifier: '-100999', messageId: 5, text: 'A only', postedAt: now }]);

  const postsForB = await getPrivatePostsSince(userB, now - 3600, 100);
  assert.equal(postsForB.length, 0);

  closeDb();
});
