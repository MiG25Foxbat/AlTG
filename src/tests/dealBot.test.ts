import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
delete process.env.PUBLIC_BASE_URL;

import { getDb, closeDb } from '../db/database';
import { getFreebiesSettings } from '../db/dealsRepo';
import { linkPrivateChat } from '../db/destinationsRepo';
import { freebiesView, handleFreebiesCallback } from '../modules/BotModule/dealBot';

const NOW = 1_800_000_000;

async function linkedUser(chatId: number): Promise<number> {
  const db = await getDb();
  const userId = Number((await db.execute('INSERT INTO users (created_at) VALUES (0)')).lastInsertRowid);
  await linkPrivateChat(userId, chatId, NOW);
  return userId;
}

const buttons = (view?: { keyboard?: { inline_keyboard: { text: string; callback_data?: string }[][] } }) =>
  (view?.keyboard?.inline_keyboard ?? []).flat();

test('/freebies: главный экран, все callback_data с префиксом fr: и не длиннее 64 байт', async () => {
  const u = await linkedUser(1);
  const view = await freebiesView(u);
  assert.match(view.text, /Акции в бот: выключены/);
  assert.match(view.text, /Магазины: все/);
  const data = buttons(view).map((b) => b.callback_data!);
  assert.deepEqual(data, ['fr:on', 'fr:st', 'fr:bq']);
  for (const d of data) assert.ok(d.startsWith('fr:') && Buffer.byteLength(d) <= 64);
});

test('кнопки включают алерты и «пробивать тихие часы», по повторному нажатию выключают', async () => {
  const u = await linkedUser(2);
  const on = await handleFreebiesCallback(2, 'fr:on', NOW);
  assert.equal(on.toast, 'Акции включены');
  assert.match(on.edit!.text, /Акции в бот: включены/);
  assert.equal((await getFreebiesSettings(u)).alertsEnabled, true);

  await handleFreebiesCallback(2, 'fr:bq', NOW);
  assert.equal((await getFreebiesSettings(u)).breakQuiet, true);
  assert.match((await freebiesView(u)).text, /приходят и в тихие часы/);

  await handleFreebiesCallback(2, 'fr:on', NOW);
  await handleFreebiesCallback(2, 'fr:bq', NOW);
  const s = await getFreebiesSettings(u);
  assert.deepEqual([s.alertsEnabled, s.breakQuiet], [false, false]);
});

test('магазины: из «все» убираем один, остальные остаются; все отмечены = пустой список; последний не снять', async () => {
  const u = await linkedUser(3);
  const storesScreen = await handleFreebiesCallback(3, 'fr:st', NOW);
  for (const b of buttons(storesScreen.edit)) assert.ok(Buffer.byteLength(b.callback_data!) <= 64);

  await handleFreebiesCallback(3, 'fr:s:ozon', NOW);
  assert.deepEqual((await getFreebiesSettings(u)).stores, ['goldapple', 'wildberries', 'letual', 'iledebeaute', 'podrygka', '4lapy', 'other']);

  await handleFreebiesCallback(3, 'fr:s:ozon', NOW);
  assert.deepEqual((await getFreebiesSettings(u)).stores, []);

  for (const c of ['goldapple', 'wildberries', 'ozon', 'letual', 'iledebeaute', 'podrygka', '4lapy']) await handleFreebiesCallback(3, `fr:s:${c}`, NOW);
  assert.deepEqual((await getFreebiesSettings(u)).stores, ['other']);
  const last = await handleFreebiesCallback(3, 'fr:s:other', NOW);
  assert.equal(last.toast, 'Нужен хотя бы один магазин');
  assert.deepEqual((await getFreebiesSettings(u)).stores, ['other']);

  await handleFreebiesCallback(3, 'fr:sa', NOW);
  assert.deepEqual((await getFreebiesSettings(u)).stores, []);
});

test('неизвестные кнопки отвечают «Кнопка устарела», непривязанный чат получает подсказку и ничего не меняет', async () => {
  const u = await linkedUser(4);
  const before = await getFreebiesSettings(u);
  for (const d of ['fr:zzz', 'fr:s:nope', 'fr:s', 'fr:']) {
    assert.equal((await handleFreebiesCallback(4, d, NOW)).toast, 'Кнопка устарела', d);
  }
  assert.deepEqual(await getFreebiesSettings(u), before);
  assert.match((await handleFreebiesCallback(999, 'fr:on', NOW)).toast!, /не привязан/);
});

test('кнопка на сайт появляется только при публичном https-адресе', async () => {
  const u = await linkedUser(5);
  process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
  assert.equal(buttons(await freebiesView(u)).some((b: any) => b.url), false);
  process.env.PUBLIC_BASE_URL = 'https://example.org';
  assert.equal(buttons(await freebiesView(u)).some((b: any) => b.url === 'https://example.org'), true);
  delete process.env.PUBLIC_BASE_URL;
  closeDb();
});
