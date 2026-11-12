import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import { closeDb, getDb } from '../db/database';
import { listSources, upsertSources, Source } from '../db/dealsRepo';
import { USER_AGENT, createFreebiesRunner, startFreebiesWorker } from '../modules/FreebiesModule/runner';
import { SOURCES, SourceConfig } from '../modules/FreebiesModule/sources';
import { tmeAdapter } from '../modules/FreebiesModule/tmeAdapter';

const T0 = Date.parse('2026-11-04T09:00:00Z') / 1000;

const config = (key: string, channel: string, intervalSec = 120): SourceConfig => ({
  key,
  kind: 'html',
  title: key,
  url: `https://t.me/s/${channel}`,
  siteUrl: `https://t.me/${channel}`,
  intervalSec,
  adapter: tmeAdapter,
  defaults: {},
});
const A = config('a', 'chan_a');
const B = config('b', 'chan_b');

/** Страница t.me/s с акциями; время постов - за пять минут до T0. */
function page(channel: string, codes: string[]): string {
  return codes
    .map(
      (code, i) => `<div class="tgme_widget_message" data-post="${channel}/${100 + i}">
<div class="tgme_widget_message_text js-message_text">В Золотом Яблоке промокод <code>${code}</code>. -10% на всё</div>
<a class="tgme_widget_message_date" href="https://t.me/${channel}/${100 + i}"><time datetime="${new Date((T0 - 300 + i) * 1000).toISOString()}"></time></a></div>`
    )
    .join('\n');
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Фальшивая сеть: handler отвечает на запрос, calls хранит всё, что просили. */
function network(handler: Handler) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFake = (async (input: any, init: RequestInit = {}) => {
    calls.push({ url: String(input), headers: { ...(init.headers as Record<string, string>) } });
    return handler(new URL(String(input)), init);
  }) as typeof fetch;
  return { calls, fetchFake, pages: () => calls.filter((c) => !c.url.endsWith('/robots.txt')) };
}

const notFound = () => new Response('', { status: 404 });

async function setup(configs: SourceConfig[], handler: Handler, extra: Partial<Parameters<typeof createFreebiesRunner>[0]> = {}) {
  const db = await getDb();
  await db.execute('DELETE FROM deal_sources');
  await upsertSources(configs);
  const net = network(handler);
  const clock = { t: T0 };
  const runner = createFreebiesRunner({
    fetch: net.fetchFake,
    now: () => clock.t,
    random: () => 0.5, // множитель разброса ровно 1.0
    sources: configs,
    ...extra,
  });
  const source = async (key = 'a'): Promise<Source> => (await listSources()).find((s) => s.key === key)!;
  const deals = async () => (await db.execute('SELECT promo_code, muted FROM deals ORDER BY id')).rows as any[];
  return { net, clock, runner, source, deals };
}

test('первая проверка: robots.txt, страница, акции сохранены без рассылки (muted), last_ok_at и следующий срок', async () => {
  const s = await setup([A], (url) => (url.pathname === '/robots.txt' ? notFound() : new Response(page('chan_a', ['AAA111']), { headers: { etag: '"v1"' } })));
  await s.runner.tick();
  assert.deepEqual(s.net.calls.map((c) => c.url), ['https://t.me/robots.txt', 'https://t.me/s/chan_a']);
  assert.ok(s.net.calls.every((c) => c.headers['User-Agent'] === USER_AGENT && !/@/.test(c.headers['User-Agent'])));
  const src = await s.source();
  assert.equal(src.lastOkAt, T0);
  assert.equal(src.nextCheckAt, T0 + 120);
  assert.equal(src.etag, '"v1"');
  assert.equal(src.failCount, 0);
  assert.deepEqual(await s.deals(), [{ promo_code: 'AAA111', muted: 1 }]);

  // Рано: источник не созрел, запросов нет.
  s.clock.t = T0 + 60;
  await s.runner.tick();
  assert.equal(s.net.calls.length, 2);
});

test('условный запрос: If-None-Match, 304 считается успехом; после первой проверки акции уже не muted; robots из кэша', async () => {
  let serve = 'first' as 'first' | '304' | 'changed';
  const s = await setup([A], (url, init) => {
    if (url.pathname === '/robots.txt') return notFound();
    if (serve === '304' && (init.headers as Record<string, string>)['If-None-Match'] === '"v1"') return new Response(null, { status: 304 });
    if (serve === 'first') return new Response(page('chan_a', ['AAA111']), { headers: { etag: '"v1"' } });
    return new Response(page('chan_a', ['AAA111', 'BBB222']), { headers: { etag: '"v2"', 'last-modified': 'Wed, 04 Nov 2026 09:00:00 GMT' } });
  });
  await s.runner.tick();
  assert.equal((await s.source()).etag, '"v1"');

  serve = '304';
  s.clock.t = T0 + 120;
  await s.runner.tick();
  assert.equal((await s.source()).lastOkAt, T0 + 120, '304 тоже успех и ставит last_ok_at');
  assert.equal(s.net.pages().at(-1)!.headers['If-None-Match'], '"v1"');
  assert.equal(s.net.calls.filter((c) => c.url.endsWith('/robots.txt')).length, 1, 'robots.txt в кэше');
  assert.deepEqual(await s.deals(), [{ promo_code: 'AAA111', muted: 1 }]);

  serve = 'changed';
  s.clock.t = T0 + 240;
  await s.runner.tick(); // источник уже отвечал, новая акция идёт в рассылку
  assert.deepEqual(await s.deals(), [{ promo_code: 'AAA111', muted: 1 }, { promo_code: 'BBB222', muted: 0 }]);
  const last = await s.source();
  assert.equal(last.etag, '"v2"');
  assert.equal(last.lastModified, 'Wed, 04 Nov 2026 09:00:00 GMT');
});

test('пустой разбор - тоже успех: last_ok_at ставится, ошибки сбрасываются', async () => {
  const s = await setup([A], (url) => (url.pathname === '/robots.txt' ? notFound() : new Response('<html>нет постов</html>')));
  const db = await getDb();
  await db.execute(`UPDATE deal_sources SET fail_count = 3 WHERE key = 'a'`);
  await s.runner.tick();
  const src = await s.source();
  assert.equal(src.lastOkAt, T0);
  assert.equal(src.failCount, 0);
});

test('robots.txt запрещает - источник отключён с причиной robots, страница не запрашивалась', async () => {
  const s = await setup([A], (url) => (url.pathname === '/robots.txt' ? new Response('User-agent: *\nDisallow: /s/') : new Response('x')));
  await s.runner.tick();
  const src = await s.source();
  assert.equal(src.isActive, false);
  assert.equal(src.disabledReason, 'robots');
  assert.deepEqual(s.net.calls.map((c) => c.url), ['https://t.me/robots.txt']);
  s.clock.t = T0 + 100_000;
  await s.runner.tick();
  assert.equal(s.net.calls.length, 1, 'отключённый источник больше не опрашивается');
});

test('robots.txt: 5xx - проверка неудачная и страница не запрашивается; Crawl-delay - нижняя граница интервала; кэш на сутки', async () => {
  let robotsStatus = 503;
  const s = await setup([A], (url) =>
    url.pathname === '/robots.txt'
      ? new Response(robotsStatus === 200 ? 'User-agent: *\nCrawl-delay: 600' : '', { status: robotsStatus })
      : new Response(page('chan_a', []))
  );
  await s.runner.tick();
  assert.equal((await s.source()).failCount, 1);
  assert.equal(s.net.pages().length, 0);

  robotsStatus = 200;
  s.clock.t = T0 + 200;
  await s.runner.tick();
  const src = await s.source();
  assert.equal(src.failCount, 0);
  assert.equal(src.nextCheckAt, T0 + 200 + 600, 'Crawl-delay 600 больше интервала 120');

  // Через сутки robots.txt читается заново.
  const before = s.net.calls.filter((c) => c.url.endsWith('/robots.txt')).length;
  s.clock.t = T0 + 200 + 86_401;
  await s.runner.tick();
  assert.equal(s.net.calls.filter((c) => c.url.endsWith('/robots.txt')).length, before + 1);
});

test('сеть или 5xx: повторы через 5 и 30 секунд без штрафа, третья неудача считается', async () => {
  let ok = false;
  const s = await setup([A], (url) => {
    if (url.pathname === '/robots.txt') return notFound();
    if (ok) return new Response(page('chan_a', []));
    return new Response('', { status: 503 });
  });
  await s.runner.tick();
  assert.deepEqual([(await s.source()).failCount, (await s.source()).nextCheckAt], [0, T0 + 5]);
  s.clock.t = T0 + 5;
  await s.runner.tick();
  assert.deepEqual([(await s.source()).failCount, (await s.source()).nextCheckAt], [0, T0 + 5 + 30]);
  s.clock.t = T0 + 35;
  await s.runner.tick();
  const third = await s.source();
  assert.equal(third.failCount, 1);
  assert.equal(third.nextCheckAt, T0 + 35 + 120);

  // Сбой сети (исключение fetch) ведёт себя так же; успех сбрасывает счётчики.
  ok = true;
  s.clock.t = T0 + 200;
  await s.runner.tick();
  assert.equal((await s.source()).failCount, 0);
});

test('пять неудачных проверок подряд отключают источник сами', async () => {
  const s = await setup([A], (url) => (url.pathname === '/robots.txt' ? notFound() : new Response('закрыто', { status: 403 })));
  for (let i = 1; i <= 5; i++) {
    s.clock.t = T0 + i * 1000;
    await s.runner.tick();
    assert.equal((await s.source()).failCount, i);
  }
  const src = await s.source();
  assert.equal(src.isActive, false);
  assert.equal(src.disabledReason, 'errors');
  const calls = s.net.calls.length;
  s.clock.t = T0 + 50_000; // раньше суток
  await s.runner.tick();
  assert.equal(s.net.calls.length, calls);
});

test('отключённый по ошибкам источник раз в сутки пробуется один раз: неудача откладывает на сутки, успех включает обратно', async () => {
  let ok = false;
  const s = await setup([A], (url) => (url.pathname === '/robots.txt' ? notFound() : ok ? new Response(page('chan_a', ['AAA111'])) : new Response('закрыто', { status: 403 })));
  for (let i = 1; i <= 5; i++) {
    s.clock.t = T0 + i * 1000;
    await s.runner.tick();
  }
  assert.equal((await s.source()).isActive, false);

  s.clock.t = T0 + 5000 + 86400; // сутки спустя: одна проба, не провалилась бы - без быстрых повторов
  const before = s.net.pages().length;
  await s.runner.tick();
  assert.equal(s.net.pages().length, before + 1);
  let src = await s.source();
  assert.equal(src.isActive, false);
  assert.equal(src.nextCheckAt, T0 + 2 * 86400 + 5000);

  s.clock.t = src.nextCheckAt;
  ok = true;
  await s.runner.tick();
  src = await s.source();
  assert.deepEqual([src.isActive, src.disabledReason, src.failCount, src.lastOkAt], [true, null, 0, s.clock.t]);
});

test('429: ждём Retry-After, неудачей не считается, ожидание ограничено часом', async () => {
  let retryAfter = '600';
  const s = await setup([A], (url) =>
    url.pathname === '/robots.txt' ? notFound() : new Response('', { status: 429, headers: { 'retry-after': retryAfter } })
  );
  await s.runner.tick();
  let src = await s.source();
  assert.equal(src.failCount, 0);
  assert.equal(src.nextCheckAt, T0 + 600);
  retryAfter = '999999';
  s.clock.t = T0 + 600;
  await s.runner.tick();
  src = await s.source();
  assert.equal(src.failCount, 0);
  assert.equal(src.nextCheckAt, T0 + 600 + 3600);
});

test('переход на другой хост и ответ больше 2 МБ - неудача; переход внутри хоста принимается', async () => {
  let mode: 'evil' | 'big' | 'inner' = 'evil';
  const s = await setup([A], (url) => {
    if (url.pathname === '/robots.txt') return notFound();
    if (mode === 'evil') return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } });
    if (mode === 'big') return new Response('x'.repeat(2 * 1024 * 1024 + 10));
    if (url.pathname === '/s/chan_a') return new Response(null, { status: 301, headers: { location: '/s/chan_a/' } });
    return new Response(page('chan_a', ['AAA111']));
  });
  await s.runner.tick();
  assert.equal((await s.source()).failCount, 1);
  assert.ok(!s.net.calls.some((c) => c.url.includes('evil.example')), 'на чужой хост не ходили');
  mode = 'big';
  s.clock.t = T0 + 1000;
  await s.runner.tick();
  assert.equal((await s.source()).failCount, 2);
  mode = 'inner';
  s.clock.t = T0 + 2000;
  await s.runner.tick();
  const src = await s.source();
  assert.equal(src.failCount, 0);
  assert.equal((await s.deals()).length, 1);
});

test('исключение внутри проверки тоже неудача: источник с постоянной ошибкой отключится', async () => {
  const s = await setup([A], () => notFound());
  const db = await getDb();
  await db.execute(`UPDATE deal_sources SET url = 'не адрес' WHERE key = 'a'`);
  for (let i = 1; i <= 5; i++) {
    s.clock.t = T0 + i * 1000;
    await s.runner.tick();
  }
  const src = await s.source();
  assert.equal(src.failCount, 5);
  assert.equal(src.isActive, false);
  assert.equal(src.disabledReason, 'errors');
});

test('robots.txt с переходом на другой хост - неудача, а не «можно всё»', async () => {
  const s = await setup([A], (url) =>
    url.pathname === '/robots.txt' ? new Response(null, { status: 302, headers: { location: 'https://evil.example/robots.txt' } }) : new Response(page('chan_a', []))
  );
  await s.runner.tick();
  assert.equal((await s.source()).failCount, 1);
  assert.equal(s.net.pages().length, 0);
  assert.ok(!s.net.calls.some((c) => c.url.includes('evil.example')));
});

test('разброс интервала +-20%', async () => {
  for (const [random, expected] of [[0, 96], [1, 144]] as const) {
    const s = await setup([A], (url) => (url.pathname === '/robots.txt' ? notFound() : new Response(page('chan_a', []))), { random: () => random });
    await s.runner.tick();
    assert.equal((await s.source()).nextCheckAt, T0 + expected);
  }
});

test('два источника на одном хосте опрашиваются строго по очереди', async () => {
  let active = 0;
  let maxActive = 0;
  const s = await setup([A, B], async (url) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    return url.pathname === '/robots.txt' ? notFound() : new Response(page(url.pathname.split('/')[2], []));
  });
  await s.runner.tick();
  assert.equal(maxActive, 1);
  assert.equal((await s.source('a')).lastOkAt, T0);
  assert.equal((await s.source('b')).lastOkAt, T0);
  assert.equal(s.net.calls.filter((c) => c.url.endsWith('/robots.txt')).length, 1, 'robots.txt хоста читается один раз на оба источника');
});

test('нейросеть: на первом (muted) опросе не зовётся; потом один вызов на тик, только для новых записей; упала - акция остаётся; afterSave получает id', async () => {
  const batches: string[][] = [];
  const saved: number[][] = [];
  let codes = ['AAA111'];
  const s = await setup([A], (url) => (url.pathname === '/robots.txt' ? notFound() : new Response(page('chan_a', codes))), {
    classify: async (items) => {
      batches.push(items.map((i) => i.text));
      throw new Error('нейросеть недоступна');
    },
    afterSave: async (ids) => {
      saved.push(ids);
    },
  });
  await s.runner.tick();
  assert.equal(batches.length, 0, 'первый опрос: акции всё равно не рассылаются');
  assert.equal(saved.length, 1);

  codes = ['AAA111', 'BBB222', 'CCC333'];
  s.clock.t = T0 + 200;
  await s.runner.tick();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2, 'AAA111 уже в базе и в нейросеть не идёт');
  assert.equal(saved.length, 2);
  assert.equal(saved[1].length, 2);
  assert.deepEqual((await s.deals()).map((d) => d.promo_code), ['AAA111', 'BBB222', 'CCC333']);

  s.clock.t = T0 + 400;
  await s.runner.tick(); // те же посты: ключи уже в базе
  assert.equal(batches.length, 1, 'для уже известных записей нейросеть не зовётся');
  assert.equal(saved.length, 2);
});

test('startFreebiesWorker: пишет источники из SOURCES в базу, опрашивает по одному robots на хост и останавливается', async () => {
  const db = await getDb();
  await db.execute('DELETE FROM deal_sources');
  const requested: string[] = [];
  const stop = startFreebiesWorker({
    fetch: (async (input: any) => {
      requested.push(String(input));
      return String(input).endsWith('/robots.txt') ? notFound() : new Response('<html></html>');
    }) as typeof fetch,
    classify: undefined,
  });
  const deadline = Date.now() + 3000;
  let sources = await listSources();
  const tg = () => sources.filter((s) => s.key.startsWith('tg-'));
  while (Date.now() < deadline && !(sources.length === SOURCES.length && tg().every((s) => s.lastOkAt !== null))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    sources = await listSources();
  }
  stop();
  assert.equal(sources.length, SOURCES.length);
  assert.deepEqual(tg().map((s) => s.url), [
    'https://t.me/s/promokodi_skidki_beauty',
    'https://t.me/s/Promokodi_zolotoe_yabloko',
    'https://t.me/s/wildberriesru_official',
  ]);
  assert.deepEqual(tg().map((s) => [s.kind, s.intervalSec, s.isActive]), [['html', 120, true], ['html', 120, true], ['html', 300, true]]);
  // Пустая страница вместо акций: страницы с __NEXT_DATA__ дают неудачу разбора, а не тихий пустой успех.
  assert.equal(sources.find((s) => s.key === 'web-iledebeaute')!.failCount, 1);
  assert.equal(new Set(requested.filter((u) => u.endsWith('/robots.txt'))).size, 6, 'по одному robots.txt на хост');
  const count = requested.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(requested.length, count, 'после stop() запросов нет');
});

test.after(() => closeDb());
