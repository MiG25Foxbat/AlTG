import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import { getDb, closeDb, migrateAlertSettingsToTopics } from '../db/database';
import { getOrCreateSoleUser } from '../db/usersRepo';
import { upsertChannel, listActiveChannelUsernames, countMonitoredChannels } from '../db/channelsRepo';
import { createGroup, updateGroup, deleteGroup, setChannelGroup, listGroups } from '../db/groupsRepo';
import {
  sanitizeTopicSettings,
  addTopic,
  listTopics,
  updateTopic,
  deleteTopic,
  resolveTopicChannels,
} from '../db/alertsRepo';

async function secondUser(): Promise<number> {
  const db = await getDb();
  const r = await db.execute({ sql: 'INSERT INTO users (created_at, status) VALUES (?, ?)', args: [0, 'active'] });
  return Number(r.lastInsertRowid);
}

test('группы: выключенная группа выключает мониторинг своих каналов, удаление группы их освобождает', async () => {
  const userId = await getOrCreateSoleUser();
  await upsertChannel(userId, '@ingroup', 'In group');
  await upsertChannel(userId, '@loose', 'No group');
  const group = await createGroup(userId, 'Крипта');

  assert.equal(await setChannelGroup(userId, '@ingroup', group.id), true);
  assert.equal(await countMonitoredChannels(userId), 2);

  await updateGroup(userId, group.id, { isActive: false });
  assert.deepEqual(await listActiveChannelUsernames(userId), ['@loose']);
  assert.equal(await countMonitoredChannels(userId), 1);

  assert.equal(await deleteGroup(userId, group.id), true);
  assert.equal(await countMonitoredChannels(userId), 2); // канал снова без группы и включён
  assert.deepEqual(await listGroups(userId), []);
  closeDb();
});

test('группы: нельзя положить свой канал в чужую группу и менять чужую группу', async () => {
  const userA = await getOrCreateSoleUser();
  const userB = await secondUser();
  await upsertChannel(userA, '@mine', 'Mine');
  const foreign = await createGroup(userB, 'Чужая');

  assert.equal(await setChannelGroup(userA, '@mine', foreign.id), false);
  assert.equal(await updateGroup(userA, foreign.id, { name: 'Взлом' }), undefined);
  assert.equal(await deleteGroup(userA, foreign.id), false);
  closeDb();
});

test('sanitizeTopicSettings: мусор и выход за границы приводятся к допустимым значениям', () => {
  const s = sanitizeTopicSettings({
    intervalMinutes: 7, // не из пресетов — дефолт
    scope: 'channels',
    groupIds: [1, '2', -3, 'x', 1],
    channels: ['@a', ' @a ', '', 5, 'x'.repeat(101)],
    digestHours: 99,
    quietFrom: '22:30',
    quietTo: '25:00',
    loudFrom: 'panic',
    minMatches: 999,
    maxPerDay: 0,
    injected: 'drop me',
  });
  assert.equal(s.intervalMinutes, 60);
  assert.equal(s.scope, 'channels');
  assert.deepEqual(s.groupIds, [1, 2]);
  assert.deepEqual(s.channels, ['@a']);
  assert.equal(s.digestHours, 24);
  assert.equal(s.quietFrom, '22:30');
  assert.equal(s.quietTo, '08:00');
  assert.equal(s.loudFrom, 'urgent');
  assert.equal(s.minMatches, 50);
  assert.equal(s.maxPerDay, 1);
  assert.equal('injected' in s, false);
});

test('подписки: у каждой свои настройки, частичное обновление, изоляция по пользователю', async () => {
  const userA = await getOrCreateSoleUser();
  const userB = await secondUser();

  const topic = await addTopic(userA, '  ставка ЦБ  ', { intervalMinutes: 180 });
  const other = await addTopic(userA, 'нефть');
  assert.equal(topic.label, 'ставка ЦБ');
  assert.equal(topic.settings.intervalMinutes, 180);
  assert.equal(other.settings.intervalMinutes, 60); // у второй — свои (дефолтные)

  const updated = await updateTopic(userA, topic.id, { settings: { loudFrom: 'important' } });
  assert.equal(updated!.settings.loudFrom, 'important');
  assert.equal(updated!.settings.intervalMinutes, 180); // не затёрлось частичным обновлением
  assert.equal((await updateTopic(userA, topic.id, { isActive: false }))!.isActive, false);
  await assert.rejects(() => updateTopic(userA, topic.id, { label: '  ' }));

  assert.equal(await updateTopic(userB, topic.id, { isActive: true }), undefined);
  assert.equal(await deleteTopic(userB, topic.id), false);
  const list = await listTopics(userA);
  assert.deepEqual(list.map((t) => [t.label, t.isActive, t.settings.intervalMinutes]), [
    ['ставка ЦБ', false, 180],
    ['нефть', true, 60],
  ]);
  await assert.rejects(() => addTopic(userA, '   '));
  closeDb();
});

test('подписки: область каналов — все / группы / конкретные каналы', async () => {
  const userId = await getOrCreateSoleUser();
  await upsertChannel(userId, '@one', null);
  await upsertChannel(userId, '@two', null);
  const group = await createGroup(userId, 'Новости');
  await setChannelGroup(userId, '@two', group.id);

  const base = sanitizeTopicSettings({});
  assert.equal(await resolveTopicChannels(userId, base), undefined);
  assert.deepEqual([...(await resolveTopicChannels(userId, { ...base, scope: 'groups', groupIds: [group.id] }))!], ['@two']);
  assert.deepEqual([...(await resolveTopicChannels(userId, { ...base, scope: 'channels', channels: ['@one', '@alien'] }))!], ['@one']);
  closeDb();
});

test('миграция: общие alert_settings копируются в каждую тему пользователя, старая таблица удаляется', async () => {
  const db = await getDb();
  await db.batch(
    [
      `INSERT INTO users (id, created_at) VALUES (11, 0), (12, 0), (13, 0)`,
      `INSERT INTO topics (user_id, label, is_active, created_at) VALUES
         (11, 'включена', 1, 1), (11, 'выключена', 0, 2), (12, 'алерты выкл', 1, 3), (13, 'без настроек', 1, 4)`,
      `CREATE TABLE alert_settings (user_id INTEGER PRIMARY KEY, settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
      `INSERT INTO alert_settings VALUES
         (11, '{"enabled":true,"mode":"digest","digestTime":"09:00","intervalMinutes":180,"quietFrom":"22:00"}', 0),
         (12, '{"enabled":false,"mode":"instant","intervalMinutes":30}', 0)`,
    ],
    'write'
  );
  await migrateAlertSettingsToTopics(db);
  await migrateAlertSettingsToTopics(db); // повторный запуск ничего не делает

  assert.equal((await db.execute(`SELECT 1 FROM sqlite_master WHERE name = 'alert_settings'`)).rows.length, 0);
  const [a, b] = await listTopics(11);
  assert.deepEqual([a.isActive, a.settings.digestHours, a.settings.intervalMinutes, a.settings.quietFrom], [true, 24, 180, '22:00']);
  assert.deepEqual([b.isActive, b.settings.intervalMinutes], [false, 180]); // настройки скопированы и в выключенную
  const [c] = await listTopics(12);
  assert.deepEqual([c.isActive, c.settings.digestHours, c.settings.intervalMinutes], [false, 0, 30]); // общий выключатель был выкл
  const [d] = await listTopics(13);
  assert.deepEqual([d.isActive, d.settings.intervalMinutes], [false, 60]); // настроек не было = алерты были выключены
  closeDb();
});
