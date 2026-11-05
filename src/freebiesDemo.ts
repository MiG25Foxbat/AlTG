/**
 * Демо интерфейса халявы без Telegram: npm run demo:freebies
 *
 * Express-приложение из createApp на базе в памяти, фейковый читатель каналов, без бота, без опроса
 * источников, без нейросети и без .env (dotenv не подключается). Слушает только 127.0.0.1.
 * Акции - из очищенных сохранённых страниц src/tests/fixtures/freebies тем же путём, что в сервисе
 * (ingestRawDeals: разбор, фильтр первого захода, дубли), время сдвинуто к «сейчас». Данные живут до остановки.
 *
 * Вход: логин demo_freebies, пароль случайный на каждый запуск, печатается в консоль при старте
 * (учётная запись только в базе в памяти этого процесса).
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
import { ingestRawDeals } from './modules/FreebiesModule/ingest';
import { SOURCES, sourceDefs } from './modules/FreebiesModule/sources';
import { RawDeal } from './modules/FreebiesModule/types';

const DEMO_USER = 'demo_freebies';
const DEMO_PASSWORD = `Demo-${randomBytes(9).toString('base64url')}`;
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

/** Сколько акций сохранено: сервисный путь ingestRawDeals без сети и без нейросети (classify не передаём). */
async function seed(now: number): Promise<number> {
  await upsertSources(sourceDefs());
  const sources = await listSources();
  const db = await getDb();
  const idOf = (key: string) => sources.find((s) => s.key === key)!.id;
  let saved = 0;

  for (const config of SOURCES) {
    const html = fs.readFileSync(path.join(__dirname, 'tests', 'fixtures', 'freebies', FIXTURES[config.key]), 'utf8');
    const raws = config.adapter.parse(html, 'text/html');
    const newest = Math.max(...raws.map((r) => r.publishedAt ?? 0));
    // Самый свежий пост - три минуты назад, остальные раньше (пять суток сжаты примерно до шести часов).
    const shifted = raws.map((raw) => ({
      ...raw,
      publishedAt: now - 180 - Math.min(Math.floor((newest - (raw.publishedAt ?? newest)) / 20), 6 * 3600),
    }));
    saved += (await ingestRawDeals(idOf(config.key), shifted, config.defaults, false, now)).length;
  }

  // Три демо-акции: две живые со сроком от «сейчас» и одна без кода, которая «могла закончиться»; каждая у своего источника.
  const live: { key: string; raw: RawDeal }[] = [
    {
      key: 'tg-promokodi-goldapple',
      raw: { title: 'Демо: Золотое Яблоко', text: 'В Золотом Яблоке промокод `DEMOLIVE30`. -30% на уход, ещё 3 часа', url: 'https://t.me/demo/1', publishedAt: now - 120 },
    },
    {
      key: 'tg-wildberries',
      raw: { title: 'Демо: Wildberries', text: 'Кроссовки на WB со скидкой 55% по промокоду `KROSSDEMO`. Только сегодня', url: 'https://t.me/demo/2', publishedAt: now - 600 },
    },
    {
      key: 'tg-wildberries',
      raw: { title: 'Демо: Wildberries без промокода', text: 'Пуховики на WB со скидкой 40% на всю коллекцию', url: 'https://t.me/demo/3', publishedAt: now - 2400 },
    },
  ];
  for (const { key, raw } of live) {
    const config = SOURCES.find((c) => c.key === key)!;
    saved += (await ingestRawDeals(idOf(key), [raw], config.defaults, false, now)).length;
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
    logger.info(`Демо халявы: http://127.0.0.1:${port} (акций ${saved})`);
    logger.info(`Вход: логин ${DEMO_USER}, пароль ${DEMO_PASSWORD} (новый на каждый запуск)`);
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
