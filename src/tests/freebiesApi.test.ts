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
    const base = { sourceId, discountText: null, expiresAt: null, muted: false, publishedAt: now - 60 };
    await saveDeal({ ...base, store: 'goldapple', category: 'beauty', title: 'Минус 30%', url: 'https://goldapple.ru/a', promoCode: 'GA30', discountPercent: 30 }, now - 30);
    await saveDeal({ ...base, store: 'wildberries', category: 'pets', title: 'Корм со скидкой', url: 'https://wb.ru/b', promoCode: null, discountPercent: 40 }, now - 10);
    await saveDeal({ ...base, store: 'ozon', category: 'other', title: 'Вчерашняя', url: 'https://ozon.ru/c', promoCode: 'OLD1', discountPercent: 5 }, now - 2 * 86400);
    assert.equal((await api('/api/channels', { method: 'POST', body: JSON.stringify({ username: 'testchannel' }) })).status, 201);
    const db = await getDb();
    await db.execute({
      sql: 'INSERT INTO public_posts (channel_username, message_id, text, posted_at, fetched_at) VALUES (?, ?, ?, ?, ?)',
      args: ['@testchannel', 7, 'Пост канала', now - 20, now],
    });

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
    assert.deepEqual(ids(all), ['deal:2', 'post:@testchannel:7', 'deal:1']); // склеены по времени
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
