import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import { closeDb, getDb } from '../db/database';
import { NewDeal, dealStatus, listSources, saveDeal, updateFreebiesSettings, upsertSources } from '../db/dealsRepo';
import { linkPrivateChat, setPause, Destination } from '../db/destinationsRepo';
import { deliverDeals, isStaleForDelivery, matchesSettings, previewDeals } from '../modules/AlertModule/dealDelivery';
import { getFreebiesSettings } from '../db/dealsRepo';
import { Notifier, OutgoingMessage, SendResult } from '../modules/AlertModule/notifier';
import { RateLimiter, processOutbox } from '../modules/AlertModule/sender';
import { createFreebiesRunner } from '../modules/FreebiesModule/runner';
import { SourceConfig } from '../modules/FreebiesModule/sources';
import { tmeAdapter } from '../modules/FreebiesModule/tmeAdapter';

const ts = (iso: string) => Date.parse(iso) / 1000;
const NOON = ts('2026-11-04T09:00:00Z'); // 12:00 МСК, тихих часов нет
const NIGHT = ts('2026-11-04T21:00:00Z'); // 00:00 МСК, тихие часы 23:00-08:00
const MORNING = ts('2026-11-05T05:00:00Z'); // 08:00 МСК

let sourceId = 0;
let codeNo = 0;

async function reset(): Promise<void> {
  const db = await getDb();
  for (const table of ['outbox', 'alert_destinations', 'deal_sources', 'users']) await db.execute(`DELETE FROM ${table}`);
  await upsertSources([{ key: 'src', kind: 'html', title: 'Канал', url: 'https://t.me/s/x', siteUrl: 'https://t.me/x', intervalSec: 120 }]);
  sourceId = (await listSources())[0].id;
}

/** Пользователь с привязанным ботом и включёнными алертами (settings - поверх этого). */
async function user(chatId: number, settings: Record<string, unknown> = {}): Promise<{ userId: number; destinationId: number }> {
  const db = await getDb();
  const userId = Number((await db.execute({ sql: 'INSERT INTO users (created_at) VALUES (0)', args: [] })).lastInsertRowid);
  await linkPrivateChat(userId, chatId, 0);
  const destinationId = Number((await db.execute({ sql: 'SELECT id FROM alert_destinations WHERE user_id = ?', args: [userId] })).rows[0].id);
  await updateFreebiesSettings(userId, { alertsEnabled: true, ...settings }, 0);
  return { userId, destinationId };
}

async function deal(now: number, patch: Partial<NewDeal> = {}): Promise<number> {
  const id = await saveDeal(
    {
      sourceId,
      store: 'goldapple',
      category: 'beauty',
      title: 'Минус 30% на уход',
      url: 'https://goldapple.ru/promo',
      promoCode: `CODE${++codeNo}`,
      discountPercent: 30,
      discountText: '-30%',
      expiresAt: null,
      publishedAt: now - 60,
      muted: false,
      ...patch,
    },
    now
  );
  assert.ok(id, 'акция сохранена');
  return id!;
}

const count = async (sql: string, ...args: (string | number)[]) =>
  Number(((await (await getDb()).execute({ sql, args })).rows[0] as any).n);
const outbox = () => count('SELECT COUNT(*) AS n FROM outbox');
const rows = async () => ((await (await getDb()).execute('SELECT user_id, deal_id, status, hold_until, queued_at FROM deal_deliveries ORDER BY user_id, deal_id')).rows as any[]);

class FakeNotifier implements Notifier {
  calls: { chatId: number | null; message: OutgoingMessage }[] = [];
  async send(d: Destination, message: OutgoingMessage): Promise<SendResult> {
    this.calls.push({ chatId: d.chatId, message });
    return { ok: true };
  }
}

test('акция уходит в очередь одним действием; отправка processOutbox со звуком, кнопкой «Открыть», без повтора', async () => {
  await reset();
  const { userId } = await user(1001);
  const id = await deal(NOON, { title: 'Скидка на помаду', url: 'https://goldapple.ru/lip' });
  await deliverDeals(NOON);
  assert.deepEqual((await rows()).map((r) => [r.user_id, r.deal_id, r.status, r.queued_at]), [[userId, id, 'queued', NOON]]);
  assert.equal(await outbox(), 1);

  const notifier = new FakeNotifier();
  assert.equal(await processOutbox(notifier, new RateLimiter(), () => NOON * 1000), 1);
  const [call] = notifier.calls;
  assert.equal(call.chatId, 1001);
  assert.equal(call.message.disableNotification, false, 'со звуком');
  assert.ok(call.message.textHtml.includes('Скидка на помаду'));
  assert.deepEqual(call.message.replyMarkup, { inline_keyboard: [[{ text: 'Открыть', url: 'https://goldapple.ru/lip' }]] });
  assert.equal(await processOutbox(notifier, new RateLimiter(), () => (NOON + 5) * 1000), 0, 'второй раз то же сообщение не уходит');
});

test('одна акция одному пользователю один раз; каждому пользователю - своя; два запуска подряд и одновременно без дубля', async () => {
  await reset();
  await user(1001);
  await user(1002);
  await deal(NOON);
  await Promise.all([deliverDeals(NOON), deliverDeals(NOON)]); // второй запуск пропускается флагом
  await deliverDeals(NOON + 1);
  await deliverDeals(NOON + 2);
  assert.equal(await outbox(), 2);
  assert.equal((await rows()).length, 2);
  // Появилась ещё одна акция - уходит только она.
  await deal(NOON + 10);
  await deliverDeals(NOON + 10);
  assert.equal(await outbox(), 4);
});

test('простой INSERT: уже существующая строка роняет весь batch, в очередь ничего не добавляется', async () => {
  await reset();
  const { userId } = await user(1001);
  const id = await deal(NOON);
  const db = await getDb();
  await db.execute({ sql: `INSERT INTO deal_deliveries (user_id, deal_id, status, created_at) VALUES (?, ?, 'skipped', 0)`, args: [userId, id] });
  await deliverDeals(NOON);
  assert.equal(await outbox(), 0);
  assert.equal((await rows())[0].status, 'skipped');
});

test('первый опрос источника не шлёт: найденное при нём muted, следующий опрос рассылает только новое', async () => {
  await reset();
  await user(1001);
  const source: SourceConfig = { key: 'src', kind: 'html', title: 'Канал', url: 'https://t.me/s/chan', siteUrl: 'https://t.me/chan', intervalSec: 120, adapter: tmeAdapter, defaults: {} };
  const db = await getDb();
  await db.execute(`UPDATE deal_sources SET url = 'https://t.me/s/chan'`);
  const post = (code: string, i: number) => `<div class="tgme_widget_message" data-post="chan/${i}">
<div class="tgme_widget_message_text js-message_text">В Золотом Яблоке промокод <code>${code}</code>. -10% на всё</div>
<a class="tgme_widget_message_date"><time datetime="${new Date((NOON - 300 + i) * 1000).toISOString()}"></time></a></div>`;
  let posts = [post('AAA111', 1)];
  const clock = { t: NOON };
  const runner = createFreebiesRunner({
    fetch: (async (input: any) => (String(input).endsWith('/robots.txt') ? new Response('', { status: 404 }) : new Response(posts.join('\n')))) as typeof fetch,
    now: () => clock.t,
    random: () => 0.5,
    sources: [source],
    afterSave: () => deliverDeals(clock.t),
  });
  await runner.tick();
  assert.equal(await count('SELECT COUNT(*) AS n FROM deals WHERE muted = 1'), 1);
  assert.equal(await outbox(), 0, 'первый опрос ничего не отправил');
  assert.equal((await rows()).length, 0);
  await deliverDeals(clock.t + 1); // и минутный тик тоже
  assert.equal(await outbox(), 0);

  posts = [post('AAA111', 1), post('BBB222', 2)];
  clock.t = NOON + 130;
  await runner.tick();
  assert.equal(await outbox(), 1);
  const sent = (await db.execute('SELECT text_html FROM outbox')).rows[0] as any;
  assert.ok(sent.text_html.includes('BBB222') && !sent.text_html.includes('AAA111'));
});

test('отбор: свежесть (час), срок, muted, магазин, категория, только с промокодом, минимальная скидка, выключенные алерты, заблокированный бот', async () => {
  await reset();
  const all = await user(1001);
  const wbOnly = await user(1002, { stores: ['wildberries'] });
  const promoOnly = await user(1003, { onlyWithPromo: true, minDiscount: 40 });
  const off = await user(1004, { alertsEnabled: false });
  const blocked = await user(1005);
  const db = await getDb();
  await db.execute({ sql: `UPDATE alert_destinations SET status = 'blocked' WHERE id = ?`, args: [blocked.destinationId] });

  await deal(NOON, { promoCode: null, discountPercent: 10 }); // goldapple без кода, 10%
  await deal(NOON, { store: 'wildberries', promoCode: 'WB50', discountPercent: 50 });
  await deal(NOON, { publishedAt: NOON - 3601, promoCode: 'OLD' }); // старше часа
  await deal(NOON, { expiresAt: NOON - 1, promoCode: 'EXPIRED' }); // срок вышел
  await deal(NOON, { muted: true, promoCode: 'MUTED' });
  await deliverDeals(NOON);

  const perUser = async (u: { userId: number }) =>
    (await db.execute({ sql: `SELECT d.promo_code FROM deal_deliveries dd JOIN deals d ON d.id = dd.deal_id WHERE dd.user_id = ? ORDER BY d.id`, args: [u.userId] })).rows.map((r: any) => r.promo_code);
  assert.deepEqual(await perUser(all), [null, 'WB50']);
  assert.deepEqual(await perUser(wbOnly), ['WB50']);
  assert.deepEqual(await perUser(promoOnly), ['WB50']);
  assert.deepEqual(await perUser(off), []);
  assert.deepEqual(await perUser(blocked), []);
  assert.equal(await outbox(), 4);

  const s = await getFreebiesSettings(all.userId);
  assert.equal(matchesSettings({ store: 'pets', category: 'pets', promoCode: null, discountPercent: null } as any, { ...s, categories: ['pets'] }), true);
  assert.equal(matchesSettings({ store: 'goldapple', category: 'beauty', promoCode: 'X', discountPercent: null } as any, { ...s, categories: ['pets'] }), false);
});

test('тихие часы держат акцию, breakQuiet пробивает, пауза держит всегда', async () => {
  await reset();
  const quiet = await user(1001); // тихие часы 23:00-08:00 по умолчанию
  const breaker = await user(1002, { breakQuiet: true });
  const paused = await user(1003, { breakQuiet: true });
  await setPause(paused.destinationId, NIGHT + 1800);
  const id = await deal(NIGHT);
  await deliverDeals(NIGHT);

  const by = (userId: number) => rows().then((r) => r.find((x) => x.user_id === userId && x.deal_id === id));
  const q = await by(quiet.userId);
  assert.equal(q.status, 'held');
  assert.equal(q.hold_until, MORNING, 'до 08:00 МСК');
  assert.equal((await by(breaker.userId)).status, 'queued');
  const p = await by(paused.userId);
  assert.equal(p.status, 'held', 'пауза бота держит даже при breakQuiet');
  assert.equal(p.hold_until, NIGHT + 1800);
  assert.equal(await outbox(), 1);

  // Пауза кончилась, акция ещё свежая - выпуск ставит её в очередь, строка held становится queued.
  await deliverDeals(NIGHT + 1801);
  assert.equal((await by(paused.userId)).status, 'queued');
  assert.equal(await outbox(), 2);
  // Утром тихие часы закончились, но ночная халява уже не живая: skipped, в очередь не идёт.
  await deliverDeals(MORNING);
  assert.equal((await by(quiet.userId)).status, 'skipped');
  assert.equal(await outbox(), 2);
  await deliverDeals(MORNING + 60);
  assert.equal(await outbox(), 2, 'повторные выпуски ничего не добавляют');
});

test('выпуск: устаревшая за паузу акция skipped; отключили алерты - skipped; пауза продлена - остаётся held', async () => {
  await reset();
  const a = await user(1001);
  const b = await user(1002);
  const c = await user(1003);
  for (const u of [a, b, c]) await setPause(u.destinationId, NOON + 600);
  await deal(NOON);
  await deliverDeals(NOON);
  assert.deepEqual((await rows()).map((r) => r.status), ['held', 'held', 'held']);

  await updateFreebiesSettings(b.userId, { alertsEnabled: false }, NOON);
  await setPause(c.destinationId, NOON + 7200);
  await deliverDeals(NOON + 601);
  const status = Object.fromEntries((await rows()).map((r) => [r.user_id, r.status]));
  assert.deepEqual(status, { [a.userId]: 'queued', [b.userId]: 'skipped', [c.userId]: 'held' });
  assert.equal((await rows()).find((r) => r.user_id === c.userId).hold_until, NOON + 7200);

  await deliverDeals(NOON + 3700); // прошёл час от публикации
  assert.equal((await rows()).find((r) => r.user_id === c.userId).status, 'skipped');
  assert.equal(await outbox(), 1);
});

test('дневной лимит: сверх maxPerDay акция придерживается (полночь, затем тихие часы до 08:00)', async () => {
  await reset();
  await user(1001, { maxPerDay: 1 });
  await deal(NOON);
  await deal(NOON);
  await deliverDeals(NOON);
  const r = await rows();
  assert.deepEqual(r.map((x) => x.status), ['queued', 'held']);
  // До полуночи по Москве, а полночь - тихие часы: цепочка задержек доходит до 08:00.
  assert.equal(r[1].hold_until, MORNING);
  assert.equal(await outbox(), 1);
});

test('сухой прогон: причины, сообщение, ничего не пишет; считает так, будто алерты включены и бот привязан', async () => {
  await reset();
  const u = await user(1001, { stores: ['goldapple'], alertsEnabled: false });
  const free = await user(1002); // второй, чтобы убедиться, что чужие доставки не мешают
  const mutedId = await deal(NOON, { muted: true, promoCode: 'MUTED1' });
  const sentId = await deal(NOON, { promoCode: 'SENT1' });
  const oldId = await deal(NOON - 1800, { promoCode: 'OLD1', publishedAt: NOON - 7200 });
  const filteredId = await deal(NOON, { store: 'wildberries', promoCode: 'FILT1' });
  const okId = await deal(NOON, { promoCode: 'OKAY1' });
  const db = await getDb();
  await db.execute({ sql: `INSERT INTO deal_deliveries (user_id, deal_id, status, created_at) VALUES (?, ?, 'queued', 0)`, args: [u.userId, sentId] });
  const before = [await outbox(), (await rows()).length];

  const settings = await getFreebiesSettings(u.userId);
  const preview = await previewDeals(u.userId, settings, 180, NOON);
  const reason = Object.fromEntries(preview.results.map((r) => [r.deal.id, r.reason]));
  assert.deepEqual(reason, { [mutedId]: 'muted', [sentId]: 'already_sent', [oldId]: 'expired', [filteredId]: 'filtered', [okId]: 'ok' });
  assert.equal(preview.alertsEnabled, false);
  assert.equal(preview.botLinked, true);
  const ok = preview.results.find((r) => r.deal.id === okId)!;
  assert.equal(ok.wouldSend, true);
  assert.ok(ok.message!.includes('OKAY1'));
  assert.equal(preview.results.find((r) => r.deal.id === filteredId)!.message, null);
  assert.deepEqual([await outbox(), (await rows()).length], before, 'ничего не записано');

  // Ночью то же самое придержало бы до утра; у пользователя без привязки botLinked = false.
  const night = await previewDeals(u.userId, settings, 180, NIGHT);
  assert.ok(night.results.every((r) => r.reason !== 'ok'));
  void free;
  const lonely = Number((await db.execute({ sql: 'INSERT INTO users (created_at) VALUES (0)', args: [] })).lastInsertRowid);
  const p2 = await previewDeals(lonely, settings, 180, NOON);
  assert.equal(p2.botLinked, false);
  assert.equal(p2.results.find((r) => r.deal.id === okId)!.reason, 'ok');
  const held = (await previewDeals(u.userId, { ...settings, stores: [] }, 600, NIGHT)).results.find((r) => r.deal.id === okId);
  assert.ok(!held || held.reason !== 'ok');
});

test('медленный источник (web-): без срока живая, окно рассылки сутки; Telegram как раньше', () => {
  const NOW = 1_800_000_000;
  const old = { publishedAt: NOW - 6 * 3600, expiresAt: null };
  assert.equal(dealStatus(old.publishedAt, null, NOW, true), 'live');
  assert.equal(dealStatus(old.publishedAt, null, NOW), 'maybe_over');
  assert.equal(dealStatus(old.publishedAt, NOW - 1, NOW, true), 'expired');
  assert.equal(isStaleForDelivery({ ...old, sourceKey: 'web-podrygka' }, NOW), false);
  assert.equal(isStaleForDelivery({ ...old, sourceKey: 'tg-wildberries' }, NOW), true);
  assert.equal(isStaleForDelivery({ publishedAt: NOW - 25 * 3600, expiresAt: null, sourceKey: 'web-podrygka' }, NOW), true);
  assert.equal(isStaleForDelivery({ publishedAt: NOW - 60, expiresAt: NOW - 1, sourceKey: 'web-podrygka' }, NOW), true);
});

test.after(() => closeDb());
