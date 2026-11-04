import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import { getDb, closeDb } from '../db/database';
import {
  DEFAULT_FREEBIES_SETTINGS,
  NewDeal,
  cleanupDeals,
  dealStatus,
  dedupKey,
  existingDedupKeys,
  getFreebiesSettings,
  listRecentDeals,
  listSources,
  sanitizeFreebiesSettings,
  saveDeal,
  updateFreebiesSettings,
  upsertSources,
} from '../db/dealsRepo';

const NOW = 1_800_000_000;

async function seedSource(): Promise<number> {
  await upsertSources([{ key: 'test', kind: 'rss', title: 'Тест', url: 'https://example.org/feed', siteUrl: 'https://example.org/', intervalSec: 120 }]);
  return (await listSources())[0].id;
}

const deal = (sourceId: number, patch: Partial<NewDeal> = {}): NewDeal => ({
  sourceId,
  store: 'goldapple',
  category: 'beauty',
  title: 'Минус 30% на уход',
  url: 'https://goldapple.ru/promo?utm=1#x',
  promoCode: 'PRIMER30',
  discountPercent: 30,
  discountText: '-30%',
  expiresAt: null,
  publishedAt: NOW - 60,
  muted: false,
  ...patch,
});

async function newUser(): Promise<number> {
  const db = await getDb();
  return Number((await db.execute({ sql: 'INSERT INTO users (created_at) VALUES (0)', args: [] })).lastInsertRowid);
}

test('sanitizeFreebiesSettings: мусор заменяется значениями по умолчанию, границы зажимаются', () => {
  assert.deepEqual(sanitizeFreebiesSettings(null), DEFAULT_FREEBIES_SETTINGS);
  assert.deepEqual(sanitizeFreebiesSettings('строка'), DEFAULT_FREEBIES_SETTINGS);
  const s = sanitizeFreebiesSettings({
    profile: 'both', alertsEnabled: 'да', stores: ['goldapple', 'evil', 'goldapple'], categories: 'beauty',
    minDiscount: 500, maxPerDay: 0, quietFrom: '25:00', quietTo: '07:30', breakQuiet: true,
  });
  assert.equal(s.profile, 'both');
  assert.equal(s.alertsEnabled, false); // только настоящий true
  assert.deepEqual(s.stores, ['goldapple']);
  assert.deepEqual(s.categories, []);
  assert.equal(s.minDiscount, 90);
  assert.equal(s.maxPerDay, 1);
  assert.equal(s.quietFrom, '23:00');
  assert.equal(s.quietTo, '07:30');
  assert.equal(s.breakQuiet, true);
});

test('настройки: нет строки - дефолты, patch меняет только свои поля, сломанный JSON не роняет', async () => {
  const userId = await newUser();
  assert.deepEqual(await getFreebiesSettings(userId), DEFAULT_FREEBIES_SETTINGS);
  await updateFreebiesSettings(userId, { alertsEnabled: true, stores: ['wildberries'] }, NOW);
  const s = await updateFreebiesSettings(userId, { minDiscount: 20, drop: 'table' }, NOW + 1);
  assert.equal(s.alertsEnabled, true);
  assert.deepEqual(s.stores, ['wildberries']);
  assert.equal(s.minDiscount, 20);
  assert.equal(Object.keys(s).length, Object.keys(DEFAULT_FREEBIES_SETTINGS).length);
  const db = await getDb();
  await db.execute({ sql: 'UPDATE freebies_settings SET settings_json = ? WHERE user_id = ?', args: ['{не json', userId] });
  assert.deepEqual(await getFreebiesSettings(userId), DEFAULT_FREEBIES_SETTINGS);
});

test('dedupKey: промокод без учёта регистра; без промокода - адрес без query и #, заголовок обрезан', () => {
  assert.equal(dedupKey('goldapple', 'primer30', 'https://a.ru/x', 'любой'), 'goldapple|PRIMER30');
  const a = dedupKey('wildberries', null, 'https://wb.ru/p?utm=1#a', '  Кроссовки   СО скидкой ');
  assert.equal(a, 'wildberries|https://wb.ru/p|кроссовки со скидкой');
  assert.equal(a, dedupKey('wildberries', null, 'https://wb.ru/p?utm=2', 'кроссовки со скидкой'));
  assert.equal(dedupKey('other', null, 'https://a.ru/', 'я'.repeat(100)).split('|')[2].length, 60);
});

test('dealStatus: срок известен - live/expired, срока нет - live первые 15 минут, потом maybe_over', () => {
  assert.equal(dealStatus(NOW - 3600, NOW + 10, NOW), 'live');
  assert.equal(dealStatus(NOW - 3600, NOW, NOW), 'expired');
  assert.equal(dealStatus(NOW - 899, null, NOW), 'live');
  assert.equal(dealStatus(NOW - 901, null, NOW), 'maybe_over');
});

test('saveDeal: дубль по dedup_key не вставляется, мусорные записи отбрасываются', async () => {
  const sourceId = await seedSource();
  const id = await saveDeal(deal(sourceId), NOW);
  assert.ok(id);
  assert.equal(await saveDeal(deal(sourceId, { url: 'https://other.ru/' }), NOW), null); // тот же промокод
  assert.equal(await saveDeal(deal(sourceId, { promoCode: null, url: 'javascript:alert(1)' }), NOW), null);
  assert.equal(await saveDeal(deal(sourceId, { promoCode: null, title: '<b></b>' }), NOW), null);
  const badPromo = await saveDeal(deal(sourceId, { promoCode: 'плохой код!', url: 'https://x.ru/2' }), NOW);
  assert.ok(badPromo);

  const keys = await existingDedupKeys(['goldapple|PRIMER30', 'goldapple|NOPE']);
  assert.deepEqual([...keys], ['goldapple|PRIMER30']);

  const all = await listRecentDeals(0, {}, 50, NOW);
  assert.equal(all.find((d) => d.id === badPromo)!.promoCode, null); // плохой промокод не записан
  const first = all.find((d) => d.id === id)!;
  assert.equal(first.url, 'https://goldapple.ru/promo?utm=1#x');
  assert.equal(first.sourceTitle, 'Тест');
  assert.equal(first.status, 'live');
});

test('listRecentDeals: фильтры по магазину и категории, since, limit; уборка старше 7 дней', async () => {
  const sourceId = (await listSources())[0].id;
  await saveDeal(deal(sourceId, { store: 'wildberries', category: 'fashion', promoCode: 'WB10', url: 'https://wb.ru/a' }), NOW + 10);
  await saveDeal(deal(sourceId, { store: 'wildberries', category: 'pets', promoCode: 'WB20', url: 'https://wb.ru/b' }), NOW - 8 * 86400);
  assert.equal((await listRecentDeals(NOW - 100, { stores: ['wildberries'] }, 50, NOW + 10)).length, 1);
  assert.equal((await listRecentDeals(0, { categories: ['pets'] }, 50, NOW)).length, 1);
  assert.equal((await listRecentDeals(0, {}, 1, NOW)).length, 1);
  await cleanupDeals(NOW);
  assert.equal((await listRecentDeals(0, { categories: ['pets'] }, 50, NOW)).length, 0);
});

test('upsertSources: повторный вызов обновляет описание, но не сбрасывает состояние опроса', async () => {
  const db = await getDb();
  await db.execute(`UPDATE deal_sources SET fail_count = 3, etag = 'abc', last_ok_at = 5 WHERE key = 'test'`);
  await upsertSources([{ key: 'test', kind: 'rss', title: 'Новое имя', url: 'https://example.org/feed', siteUrl: 'https://example.org/', intervalSec: 10 }]);
  const s = (await listSources()).find((x) => x.key === 'test')!;
  assert.equal(s.title, 'Новое имя');
  assert.equal(s.intervalSec, 60); // не меньше 60
  assert.equal(s.failCount, 3);
  assert.equal(s.etag, 'abc');
  assert.equal(s.lastOkAt, 5);
});

test.after(() => closeDb());
