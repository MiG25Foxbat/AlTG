/**
 * Проверка источников халявы, которую можно запускать без разработчика:
 *   npx ts-node src/freebiesCheck.ts            все источники
 *   npx ts-node src/freebiesCheck.ts web-        только сайты (ключи с этим началом)
 *   npx ts-node src/freebiesCheck.ts tg- web-4lapy
 *
 * Что делает: один проход настоящего раннера сервиса по выбранным источникам (robots.txt, запрос, разбор,
 * фильтр, сохранение), база в памяти, без .env, без нейросети, без бота. Потом тот же разбор ещё раз на уже
 * полученных ответах, без сети: новых акций быть не должно (проверка на дубли). Потом доставка на тестового
 * пользователя: какие сообщения бот поставил бы в очередь. Никуда ничего не отправляет.
 *
 * Результат: папка .freebies-check/<дата-время>/ — report.md (итог и оценка по каждому источнику),
 * deals.json (все найденные акции), messages.txt (тексты сообщений бота), requests.json и ответы сайтов как есть.
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.DB_PATH = ':memory:';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.GEMINI_API_KEY;
delete process.env.OPEN_ROUTER_API_KEY;

import { getDb, closeDb } from './db/database';
import { listRecentDeals, listSources, updateFreebiesSettings, upsertSources } from './db/dealsRepo';
import { linkPrivateChat } from './db/destinationsRepo';
import { registerUser } from './db/usersRepo';
import { deliverDeals } from './modules/AlertModule/dealDelivery';
import { createFreebiesRunner } from './modules/FreebiesModule/runner';
import { SOURCES, sourceDefs } from './modules/FreebiesModule/sources';

interface Rec {
  url: string;
  status: number | null;
  ms: number;
  bytes: number;
  error: string | null;
  file: string | null;
}

const KEEP_HEADERS = ['content-type', 'etag', 'last-modified', 'location', 'retry-after'];
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const outDir = path.join(process.cwd(), '.freebies-check', stamp);
const records: Rec[] = [];
const replay = new Map<string, { status: number; headers: Headers; body: string }>();

const urlOf = (input: any) => String(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
const make = (status: number, headers: Headers, body: string) => new Response(NULL_BODY.has(status) ? null : body, { status, headers });

/** Настоящий fetch, который запоминает каждый ответ на диск и для повторного прохода без сети. */
const recordingFetch: typeof fetch = async (input: any, init?: RequestInit) => {
  const url = urlOf(input);
  const started = Date.now();
  const rec: Rec = { url, status: null, ms: 0, bytes: 0, error: null, file: null };
  records.push(rec);
  try {
    const res = await fetch(input, init);
    const body = await res.text();
    const headers = new Headers();
    for (const h of KEEP_HEADERS) if (res.headers.get(h)) headers.set(h, res.headers.get(h)!);
    Object.assign(rec, { status: res.status, ms: Date.now() - started, bytes: body.length });
    rec.file = `${String(records.length).padStart(2, '0')}-${url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').slice(0, 80)}.txt`;
    fs.writeFileSync(path.join(outDir, rec.file), body);
    replay.set(url, { status: res.status, headers, body });
    console.log(`  ${res.status} ${String(rec.ms).padStart(5)} мс ${Math.round(body.length / 1024)} КБ  ${url}`);
    return make(res.status, headers, body);
  } catch (error: any) {
    rec.ms = Date.now() - started;
    rec.error = error?.cause?.code || error?.name || String(error);
    console.log(`  ОШИБКА ${rec.error} ${rec.ms} мс  ${url}`);
    throw error;
  }
};

const replayFetch: typeof fetch = async (input: any) => {
  const hit = replay.get(urlOf(input));
  if (!hit) throw new TypeError('нет сохранённого ответа');
  return make(hit.status, hit.headers, hit.body);
};

const plain = (html: string) =>
  html
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '-');

async function main() {
  const prefixes = process.argv.slice(2);
  const configs = SOURCES.filter((s) => prefixes.length === 0 || prefixes.some((p) => s.key.startsWith(p)));
  if (configs.length === 0) throw new Error(`нет источников с ключами: ${prefixes.join(', ')}`);
  fs.mkdirSync(outDir, { recursive: true });

  const now = Math.floor(Date.now() / 1000);
  const db = await getDb();
  await upsertSources(sourceDefs());
  const keys = configs.map((c) => c.key);
  const inList = keys.map(() => '?').join(',');
  // Остальные источники выключены; выбранным ставим «уже проверялся», иначе первая проверка сохранила бы акции
  // без рассылки (muted) и сообщения бота было бы не проверить.
  await db.execute({ sql: `UPDATE deal_sources SET is_active = 0 WHERE key NOT IN (${inList})`, args: keys });
  await db.execute({ sql: `UPDATE deal_sources SET last_ok_at = ? WHERE key IN (${inList})`, args: [now - 60, ...keys] });

  const userId = await registerUser('freebies_check', 'not-a-login');
  await linkPrivateChat(userId, 900_000_777, now);
  await updateFreebiesSettings(userId, { alertsEnabled: true, quietEnabled: false, maxPerDay: 100 }, now);

  console.log(`Проверяю источников: ${configs.length}. Запросы:`);
  const clock = () => now;
  await createFreebiesRunner({ fetch: recordingFetch, now: clock, random: () => 0.5, deliver: async () => {}, sources: configs }).tick();

  const count = async () => Number((await db.execute('SELECT COUNT(*) AS n FROM deals')).rows[0].n);
  const before = await count();
  // Повтор на тех же ответах без сети: дублей быть не должно.
  await db.execute({ sql: `UPDATE deal_sources SET next_check_at = 0 WHERE key IN (${inList}) AND fail_count = 0`, args: keys });
  await createFreebiesRunner({ fetch: replayFetch, now: clock, random: () => 0.5, deliver: async () => {}, sources: configs }).tick();
  const duplicates = (await count()) - before;

  await deliverDeals(now);
  const messages = (await db.execute('SELECT text_html FROM outbox ORDER BY id')).rows.map((r) => plain(String(r.text_html)));

  const deals = await listRecentDeals(now - 7 * 86400, {}, 1000, now);
  const state = await listSources();
  const rows: string[] = [];
  const details: string[] = [];

  for (const c of configs) {
    const s = state.find((x) => x.key === c.key)!;
    const origin = new URL(c.url).origin;
    const robots = records.find((r) => r.url === `${origin}/robots.txt`);
    // Свой адрес источника; если сайт переадресовал - последний ответ того же хоста. У каналов хост общий (t.me).
    const page = records.find((r) => r.url === c.url) ?? [...records].reverse().find((r) => r.url.startsWith(origin) && !r.url.endsWith('/robots.txt'));
    const mine = deals.filter((d) => d.sourceKey === c.key);
    const foreign = mine.filter((d) => new URL(d.url).origin !== (c.key.startsWith('tg-') ? 'https://t.me' : origin)).length;

    let parsed = '-';
    let parseError: string | null = null;
    const body = page?.url && replay.get(page.url);
    if (body && body.status === 200) {
      try {
        parsed = String(c.adapter.parse(body.body, body.headers.get('content-type') ?? '').length);
      } catch (error: any) {
        parseError = error?.message || String(error);
      }
    }

    const verdict =
      s.disabledReason === 'robots'
        ? 'ЗАПРЕЩЁН robots.txt'
        : !robots || robots.error
          ? `НЕДОСТУПЕН из этой сети (robots.txt: ${robots?.error ?? 'не запрошен'})`
          : !page
            ? 'НЕДОСТУПЕН из этой сети (страница не запрошена)'
            : page.error
              ? `НЕДОСТУПЕН из этой сети (${page.error})`
              : page.status !== 200
                ? `ОТКАЗ сайта, код ${page.status}`
                : parseError
                  ? `СЛОМАН РАЗБОР: ${parseError}`
                  : mine.length > 0
                    ? 'РАБОТАЕТ'
                    : 'РАБОТАЕТ, свежих акций нет';

    rows.push(
      `| ${c.key} | ${robots?.status ?? robots?.error ?? '-'} | ${page?.status ?? page?.error ?? '-'} | ${page ? `${page.ms} мс` : '-'} | ${parsed} | ${mine.length} | ${foreign} | ${verdict} |`
    );
    details.push(`### ${c.title} (\`${c.key}\`)\n\nАдрес: ${c.url}\nИтог: ${verdict}\n`);
    for (const d of mine.slice(0, 5)) {
      details.push(
        `- ${d.title}\n  магазин ${d.store}, категория ${d.category}, промокод ${d.promoCode ?? 'нет'}, скидка ${d.discountText ?? 'нет'}, ` +
          `до ${when(d.expiresAt)}, статус ${d.status}\n  ${d.url}`
      );
    }
    if (mine.length > 5) details.push(`- … и ещё ${mine.length - 5}, все в deals.json`);
    details.push('');
  }

  const reachableTg = configs.some((c) => c.key.startsWith('tg-') && records.some((r) => r.url.startsWith('https://t.me/') && r.status));
  const reachableWeb = configs.some((c) => !c.key.startsWith('tg-') && records.some((r) => r.url.startsWith(new URL(c.url).origin) && r.status));
  const report = [
    `# Проверка источников халявы ${when(now)} МСК`,
    '',
    `Сеть: t.me ${reachableTg ? 'доступен' : 'НЕ доступен'}, сайты магазинов ${reachableWeb ? 'хотя бы часть доступна' : 'НЕ доступны'}.`,
    `Найдено акций: ${deals.length}. Повторный разбор тех же ответов дал новых: ${duplicates} (должно быть 0).`,
    `Сообщений бот поставил бы в очередь: ${messages.length} (Telegram-акции не старше часа, акции сайтов не старше суток).`,
    '',
    '| Источник | robots.txt | Страница | Время | Записей на странице | Акций сохранено | Чужих ссылок | Итог |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Примеры акций по источникам',
    '',
    ...details,
  ].join('\n');

  fs.writeFileSync(path.join(outDir, 'report.md'), report);
  fs.writeFileSync(path.join(outDir, 'deals.json'), JSON.stringify(deals, null, 2));
  fs.writeFileSync(path.join(outDir, 'messages.txt'), messages.join('\n\n----------\n\n') || 'Сообщений нет.');
  fs.writeFileSync(path.join(outDir, 'requests.json'), JSON.stringify(records, null, 2));

  console.log('\n' + rows.map((r) => r.split('|').slice(1, -1).map((x) => x.trim()).filter((_, i) => [0, 4, 5, 7].includes(i)).join('  |  ')).join('\n'));
  console.log(`\nДублей при повторе: ${duplicates}. Сообщений в очереди: ${messages.length}.`);
  console.log(`Отчёт: ${path.join(outDir, 'report.md')}`);
  closeDb();
}

main().catch((error) => {
  console.error('Проверка упала:', error);
  process.exit(1);
});
