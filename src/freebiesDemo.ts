/**
 * Демо интерфейса халявы без Telegram: npm run demo:freebies
 *
 * Express-приложение из createApp на базе в памяти, фейковый читатель каналов, без бота, без опроса
 * источников, без нейросети и без .env (dotenv не подключается). Слушает только 127.0.0.1.
 * Акции - из очищенных сохранённых страниц src/tests/fixtures/freebies через тот же разбор, что и в сервисе,
 * время сдвинуто к «сейчас». Данные живут до остановки процесса.
 *
 * Демо-вход (только для этого демо, в базе в памяти, в боевых данных его нет):
 *   логин:  demo_freebies
 *   пароль: Demo-S-JbZqXfDcR7
 *
 * Адрес: http://127.0.0.1:3099 (порт из DEMO_PORT). Остановка: Ctrl+C.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// До первого обращения к базе: только память, никакого боевого хранилища; ключ сессий случайный на запуск.
process.env.DB_PATH = ':memory:';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.GEMINI_API_KEY;
delete process.env.OPEN_ROUTER_API_KEY;
process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { createApp } from './app';
import { closeDb, getDb } from './db/database';
import { upsertChannel } from './db/channelsRepo';
import { listSources, saveDeal, updateFreebiesSettings, upsertSources } from './db/dealsRepo';
import { linkPrivateChat } from './db/destinationsRepo';
import { insertPosts } from './db/postsRepo';
import { registerUser } from './db/usersRepo';
import { hashPassword } from './utils/crypto';
import { logger } from './utils/logger';
import { IUserBotReader } from './modules/UserBotModule/IUserBotReader';
import { extractDeals } from './modules/FreebiesModule/parse';
import { SOURCES, sourceDefs } from './modules/FreebiesModule/sources';
import { RawDeal } from './modules/FreebiesModule/types';

const DEMO_USER = 'demo_freebies';
const DEMO_PASSWORD = 'Demo-S-JbZqXfDcR7';
const FIXTURES: Record<string, string> = {
  'tg-promokodi-beauty': 'tme-promokodi-beauty.html',
  'tg-promokodi-goldapple': 'tme-promokodi-goldapple.html',
  'tg-wildberries': 'tme-wildberries-official.html',
};

/** Фейковый Telegram: канал «найден», постов за окно нет (посты ленты заложены в базу при старте). */
const fakeUserBot: IUserBotReader = {
  async resolveChannel() {
    return { title: 'Демо-канал' };
  },
  async getMessagesInWindow() {
    return [];
  },
};

async function seed(now: number): Promise<number> {
  await upsertSources(sourceDefs());
  const sources = await listSources();
  const db = await getDb();
  let saved = 0;

  for (const config of SOURCES) {
    const sourceId = sources.find((s) => s.key === config.key)!.id;
    const html = fs.readFileSync(path.join(__dirname, 'tests', 'fixtures', 'freebies', FIXTURES[config.key]), 'utf8');
    const raws = config.adapter.parse(html, 'text/html');
    const newest = Math.max(...raws.map((r) => r.publishedAt ?? 0));
    for (const raw of raws) {
      // Самый свежий пост - три минуты назад, остальные раньше (пять суток сжаты примерно до шести часов).
      const publishedAt = now - 180 - Math.min(Math.floor((newest - (raw.publishedAt ?? newest)) / 20), 6 * 3600);
      for (const d of extractDeals({ ...raw, publishedAt }, config.defaults, now)) {
        if (d.promoCode === null && d.discountText === null) continue;
        if (await saveDeal({ ...d, sourceId, muted: false }, Math.min(now, publishedAt + 30))) saved++;
      }
    }
  }

  // Две акции, которые всегда живые: срок задан относительно «сейчас».
  const live: RawDeal[] = [
    { externalId: null, title: 'Демо: Золотое Яблоко', text: 'В Золотом Яблоке промокод `DEMOLIVE30`. -30% на уход, ещё 3 часа', url: 'https://t.me/demo/1', publishedAt: now - 120 },
    { externalId: null, title: 'Демо: Wildberries', text: 'Кроссовки на WB со скидкой 55% по промокоду `KROSSDEMO`. Только сегодня', url: 'https://t.me/demo/2', publishedAt: now - 600 },
  ];
  const wb = sources.find((s) => s.key === 'tg-wildberries')!.id;
  for (const raw of live) {
    for (const d of extractDeals(raw, {}, now)) if (await saveDeal({ ...d, sourceId: wb, muted: false }, raw.publishedAt!)) saved++;
  }

  await db.execute({ sql: 'UPDATE deal_sources SET last_ok_at = ?, last_checked_at = ?, next_check_at = ?', args: [now, now, now + 3600] });
  return saved;
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const userId = await registerUser(DEMO_USER, await hashPassword(DEMO_PASSWORD));
  await linkPrivateChat(userId, 900_000_001, now); // фейковая личка: бот «привязан», сообщений никто не шлёт
  await updateFreebiesSettings(userId, { profile: 'both' }, now);

  const saved = await seed(now);
  await upsertChannel(userId, '@demo_channel', 'Демо-канал');
  await insertPosts([
    { channelUsername: '@demo_channel', messageId: 11, text: 'Пример поста из канала, который добавлен во вкладке «Каналы».', postedAt: now - 240 },
    { channelUsername: '@demo_channel', messageId: 10, text: 'Ещё один пример поста канала, чтобы лента была смешанной.', postedAt: now - 1500 },
  ]);

  const app = await createApp(fakeUserBot);
  const port = Number(process.env.DEMO_PORT) || 3099;
  const server = app.listen(port, '127.0.0.1', () => {
    logger.info(`Демо халявы: http://127.0.0.1:${port} (акций ${saved}). Вход: ${DEMO_USER} / ${DEMO_PASSWORD}`);
    logger.info('Без Telegram, бота, опроса источников и нейросети. Остановка: Ctrl+C');
  });

  const shutdown = () => {
    server.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error('Демо не запустилось:', error);
  process.exit(1);
});
