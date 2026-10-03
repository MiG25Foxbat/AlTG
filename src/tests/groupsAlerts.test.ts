import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import { getDb, closeDb } from '../db/database';
import { getOrCreateSoleUser } from '../db/usersRepo';
import { upsertChannel, listActiveChannelUsernames, countMonitoredChannels } from '../db/channelsRepo';
import { createGroup, updateGroup, deleteGroup, setChannelGroup, listGroups } from '../db/groupsRepo';
import { sanitizeAlertSettings, saveAlertSettings, getAlertSettings, addTopic, listTopics, deleteTopic } from '../db/alertsRepo';

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

test('sanitizeAlertSettings: мусор и выход за границы приводятся к допустимым значениям', () => {
  const s = sanitizeAlertSettings({
    enabled: 'yes', // не boolean true — выключено
    intervalMinutes: 7, // не из пресетов — дефолт
    scope: 'groups',
    groupIds: [1, '2', -3, 'x', 1],
    mode: 'weird',
    digestTime: '25:00',
    quietFrom: '22:30',
    minMatches: 999,
    maxPerDay: 0,
    injected: 'drop me',
  });
  assert.equal(s.enabled, false);
  assert.equal(s.intervalMinutes, 60);
  assert.deepEqual(s.groupIds, [1, 2]);
  assert.equal(s.mode, 'instant');
  assert.equal(s.digestTime, '09:00');
  assert.equal(s.quietFrom, '22:30');
  assert.equal(s.minMatches, 50);
  assert.equal(s.maxPerDay, 1);
  assert.equal('injected' in s, false);
});

test('настройки и темы алертов сохраняются и изолированы по пользователю', async () => {
  const userA = await getOrCreateSoleUser();
  const userB = await secondUser();
  await saveAlertSettings(userA, { enabled: true, intervalMinutes: 180 });
  assert.equal((await getAlertSettings(userA)).intervalMinutes, 180);
  assert.equal((await getAlertSettings(userB)).enabled, false); // у B — дефолты

  const topic = await addTopic(userA, '  ставка ЦБ  ');
  assert.equal(topic.label, 'ставка ЦБ');
  assert.equal(await deleteTopic(userB, topic.id), false);
  assert.equal((await listTopics(userA)).length, 1);
  await assert.rejects(() => addTopic(userA, '   '));
  closeDb();
});
