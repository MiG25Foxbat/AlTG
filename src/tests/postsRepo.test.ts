import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import { closeDb } from '../db/database';
import { getOrCreateSoleUser } from '../db/usersRepo';
import { upsertChannel, setChannelActive } from '../db/channelsRepo';
import { insertPosts, getPostsSince } from '../db/postsRepo';

test('postsRepo: insertPosts дедуплицирует по (channel, message_id), getPostsSince фильтрует по активным каналам пользователя', async () => {
  const userId = await getOrCreateSoleUser();
  await upsertChannel(userId, '@activechan', 'Active');
  await upsertChannel(userId, '@inactivechan', 'Inactive');
  await setChannelActive(userId, '@inactivechan', false);

  const now = Math.floor(Date.now() / 1000);
  const inserted = await insertPosts([
    { channelUsername: '@activechan', messageId: 1, text: 'первый', postedAt: now },
    { channelUsername: '@activechan', messageId: 2, text: 'второй', postedAt: now - 10 },
    { channelUsername: '@inactivechan', messageId: 1, text: 'из выключенного канала', postedAt: now },
  ]);
  assert.equal(inserted, 3);

  // повторная вставка тех же (channel, message_id) — дедуп, 0 новых строк
  const dedupInsert = await insertPosts([
    { channelUsername: '@activechan', messageId: 1, text: 'первый (повтор)', postedAt: now },
  ]);
  assert.equal(dedupInsert, 0);

  const posts = await getPostsSince(userId, now - 3600, 100);
  assert.equal(posts.length, 2); // не включает пост из @inactivechan
  assert.ok(posts.every((p) => p.channel_username === '@activechan'));
  assert.equal(posts[0].posted_at >= posts[posts.length - 1].posted_at, true); // новые первыми

  closeDb();
});
