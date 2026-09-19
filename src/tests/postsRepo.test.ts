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

test('postsRepo: getPostsSince не отдаёт пользователю A посты канала, активного только у пользователя B (изоляция по user_channels.user_id в JOIN)', async () => {
  const userA = await getOrCreateSoleUser();
  // У A свой собственный канал, никак не связанный с @activechan ниже —
  // если предикат user_id по ошибке уберут из JOIN, чужой активный канал
  // не должен "просочиться" в выдачу A даже при непустом списке своих.
  await upsertChannel(userA, '@ownchan', 'Own channel for A');

  // getOrCreateSoleUser всегда возвращает одного и того же пользователя в
  // этом прототипе — здесь вставляем второго пользователя напрямую через
  // getDb(), как в channelsRepo.test.ts, чтобы проверить именно предикат
  // user_channels.user_id = ? в JOIN внутри getPostsSince.
  const { getDb } = await import('../db/database');
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const insertResult = await db.execute({
    sql: 'INSERT INTO users (created_at, status, last_active_at) VALUES (?, ?, ?)',
    args: [now, 'active', now],
  });
  const userB = Number(insertResult.lastInsertRowid);
  // У B — своя запись user_channels на @activechan (имя специально
  // совпадает с активным каналом из первого теста этого файла). A эту
  // запись не создавал и на канал не подписан.
  await upsertChannel(userB, '@activechan', 'Active for B');

  await insertPosts([
    { channelUsername: '@activechan', messageId: 999, text: 'пост из канала B', postedAt: now },
  ]);

  const postsForA = await getPostsSince(userA, now - 3600, 100);
  assert.ok(
    postsForA.every((p) => p.message_id !== 999),
    'пост из канала, активного только у пользователя B, не должен попадать в выдачу пользователя A'
  );

  closeDb();
});
