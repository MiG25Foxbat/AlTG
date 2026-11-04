import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.DB_PATH = ':memory:';
process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString('base64');
delete process.env.GEMINI_API_KEY;
delete process.env.OPEN_ROUTER_API_KEY;

import { createApp } from '../app';
import { closeDb, getDb } from '../db/database';
import { saveDeal, upsertSources, listSources } from '../db/dealsRepo';
import { IUserBotReader } from '../modules/UserBotModule/IUserBotReader';

const fakeUserBot: IUserBotReader = {
  async resolveChannel() {
    return { title: 'Канал' };
  },
  async getMessagesInWindow() {
    return [];
  },
};

test('HTTP API халявы: вход, лента, акции, настройки, источники', async () => {
  const app = await createApp(fakeUserBot);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  let cookie = '';
  const api = async (pathname: string, init?: RequestInit) => {
    const res = await fetch(`${baseUrl}${pathname}`, {
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...init,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const ids = (r: { body: any }) => r.body.items.map((i: any) => i.id);

  try {
    for (const p of ['/api/feed', '/api/freebies/deals', '/api/freebies/settings', '/api/freebies/sources']) {
      assert.equal((await api(p)).status, 401, p);
    }
    assert.equal((await api('/api/freebies/settings', { method: 'PATCH', body: '{}' })).status, 401);

    const reg = await api('/api/register', { method: 'POST', body: JSON.stringify({ username: 'freebie_user', password: 'correct horse battery' }) });
    assert.equal(reg.status, 201);

    // Данные: источник, три акции (одна двухдневной давности), один пост отслеживаемого канала.
    const now = Math.floor(Date.now() / 1000);
    await upsertSources([{ key: 'pepper', kind: 'rss', title: 'Pepper.ru', url: 'https://example.org/rss', siteUrl: 'https://example.org/', intervalSec: 300 }]);
    const sourceId = (await listSources())[0].id;
    const base = { sourceId, discountText: null, expiresAt: null, muted: false };
    await saveDeal({ ...base, publishedAt: now - 30, store: 'goldapple', category: 'beauty', title: 'Минус 30%', url: 'https://goldapple.ru/a', promoCode: 'GA30', discountPercent: 30 }, now - 30);
    await saveDeal({ ...base, publishedAt: now - 10, store: 'wildberries', category: 'pets', title: 'Корм со скидкой', url: 'https://wb.ru/b', promoCode: null, discountPercent: 40 }, now - 10);
    await saveDeal({ ...base, publishedAt: now - 2 * 86400, store: 'ozon', category: 'other', title: 'Вчерашняя', url: 'https://ozon.ru/c', promoCode: 'OLD1', discountPercent: 5 }, now - 2 * 86400);
    assert.equal((await api('/api/channels', { method: 'POST', body: JSON.stringify({ username: 'testchannel' }) })).status, 201);
    const db = await getDb();
    await db.execute({
      sql: 'INSERT INTO public_posts (channel_username, message_id, text, posted_at, fetched_at) VALUES (?, ?, ?, ?, ?)',
      args: ['@testchannel', 7, 'Пост канала', now - 20, now],
    });

    // Приватный канал: виден в ленте, пока личная сессия жива, и пропадает, когда ей нужен повторный вход.
    const me = (await api('/api/me')).body;
    await db.execute({ sql: `INSERT INTO user_channels (user_id, channel_identifier, is_private, added_at) VALUES (?, '-100777', 1, 0)`, args: [me.id] });
    await db.execute({
      sql: `INSERT INTO private_posts (user_id, channel_identifier, message_id, text, posted_at, fetched_at) VALUES (?, '-100777', 5, 'Закрытый пост', ?, ?)`,
      args: [me.id, now - 40, now],
    });
    assert.ok(ids(await api('/api/feed?kind=channels')).includes('post:-100777:5'));
    await db.execute({
      sql: `INSERT INTO telegram_accounts (user_id, telegram_user_id, phone_number_encrypted, session_string_encrypted, session_status, connected_at)
            VALUES (?, 555, 'x', 'x', 'needs_reauth', 0)`,
      args: [me.id],
    });
    assert.ok(!ids(await api('/api/feed?kind=channels')).includes('post:-100777:5'));
    await db.execute({ sql: 'DELETE FROM telegram_accounts WHERE user_id = ?', args: [me.id] });
    await db.execute({ sql: `DELETE FROM user_channels WHERE channel_identifier = '-100777'`, args: [] });

    const deals = await api('/api/freebies/deals');
    assert.equal(deals.status, 200);
    assert.deepEqual(deals.body.deals.map((d: any) => d.store), ['wildberries', 'goldapple']); // за сутки, новые сверху
    assert.equal(deals.body.deals[1].sourceTitle, 'Pepper.ru');
    assert.equal(deals.body.deals[1].status, 'live');
    assert.equal((await api('/api/freebies/deals?store=goldapple')).body.deals.length, 1);
    assert.equal((await api('/api/freebies/deals?category=pets&limit=1')).body.deals.length, 1);
    for (const bad of ['store=nope', 'category=nope', 'limit=0', 'limit=101', 'limit=abc']) {
      assert.equal((await api(`/api/freebies/deals?${bad}`)).status, 400, bad);
    }

    const all = await api('/api/feed?kind=all');
    // Склеены по времени; у акции время - publishedAt, как в карточке «N мин назад».
    assert.deepEqual(ids(all), ['deal:2', 'post:@testchannel:7', 'deal:1']);
    assert.equal(all.body.items[0].at, all.body.items[0].deal.publishedAt);
    const post = all.body.items.find((i: any) => i.kind === 'post');
    assert.equal(post.link, 'https://t.me/testchannel/7');
    assert.equal(post.deal, undefined);
    assert.equal(all.body.items.find((i: any) => i.id === 'deal:1').deal.promoCode, 'GA30');
    assert.equal(all.body.items.find((i: any) => i.id === 'deal:1').title, 'Золотое яблоко');
    assert.equal((await api('/api/feed?kind=channels')).body.items.every((i: any) => i.kind === 'post'), true);
    assert.deepEqual(ids(await api('/api/feed?kind=freebies')), ['deal:2', 'deal:1']);
    assert.equal((await api('/api/feed?kind=all&limit=1')).body.items.length, 1);
    assert.equal((await api('/api/feed?kind=xx')).status, 400);
    assert.equal((await api('/api/feed?limit=500')).status, 400);

    // Лента акций учитывает настройки пользователя, /deals - нет.
    await api('/api/freebies/settings', { method: 'PATCH', body: JSON.stringify({ stores: ['goldapple'] }) });
    assert.deepEqual(ids(await api('/api/feed?kind=freebies')), ['deal:1']);
    assert.equal((await api('/api/freebies/deals')).body.deals.length, 2);

    const settings = await api('/api/freebies/settings');
    assert.equal(settings.body.settings.profile, null);
    assert.deepEqual(settings.body.settings.stores, ['goldapple']);
    assert.deepEqual(settings.body.stores[0], { code: 'goldapple', label: 'Золотое яблоко' });
    assert.equal(settings.body.categories.length, 4);

    const patched = await api('/api/freebies/settings', { method: 'PATCH', body: JSON.stringify({ profile: 'freebies', minDiscount: 999, evil: 1 }) });
    assert.equal(patched.body.settings.profile, 'freebies');
    assert.equal(patched.body.settings.minDiscount, 90);
    assert.equal(patched.body.settings.evil, undefined);
    assert.equal((await api('/api/freebies/settings', { method: 'PATCH', body: '[1]' })).status, 400);

    // Сухой прогон: за сутки, без записи; бот не привязан и алерты выключены - но считается так, будто включены.
    for (const bad of [{ minutes: 5 }, { minutes: 2000 }, { minutes: 'x' }, { minutes: 30.5 }]) {
      assert.equal((await api('/api/freebies/preview', { method: 'POST', body: JSON.stringify(bad) })).status, 400, JSON.stringify(bad));
    }
    await api('/api/freebies/settings', { method: 'PATCH', body: JSON.stringify({ minDiscount: 0 }) });
    const preview = await api('/api/freebies/preview', { method: 'POST', body: '{}' });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.alertsEnabled, false);
    assert.equal(preview.body.botLinked, false);
    const byDeal = Object.fromEntries(preview.body.results.map((r: any) => [r.deal.id, r]));
    assert.equal(byDeal[2].reason, 'filtered'); // магазин wildberries не выбран
    assert.ok(['ok', 'held'].includes(byDeal[1].reason)); // ночью по Москве придержала бы
    assert.ok(byDeal[1].message.includes('GA30'));
    assert.equal(byDeal[2].message, null);
    assert.equal(byDeal[3], undefined, 'двухдневная акция в окно не попала');
    assert.equal((await db.execute('SELECT COUNT(*) AS n FROM deal_deliveries')).rows[0].n, 0);
    assert.equal((await db.execute('SELECT COUNT(*) AS n FROM outbox')).rows[0].n, 0);

    const sources = await api('/api/freebies/sources');
    assert.equal(sources.body.llmCalls, 0);
    assert.deepEqual(sources.body.sources, [
      { key: 'pepper', title: 'Pepper.ru', siteUrl: 'https://example.org/', kind: 'rss', isActive: true, disabledReason: null, lastOkAt: null },
    ]);
  } finally {
    server.close();
    closeDb();
  }
});
