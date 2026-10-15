import dotenv from 'dotenv';
dotenv.config();

import { randomUUID } from 'node:crypto';
import { UserBot } from './modules/UserBotModule/UserBot';
import { createApp } from './app';
import { createAlertBot, AlertBot } from './modules/BotModule/bot';
import { startWorker } from './modules/AlertModule/scheduler';
import { TelegramNotifier } from './modules/AlertModule/notifier';
import { getDb, closeDb } from './db/database';
import { ensureDefaultUser, migrateLegacyData, removeSharedSessionDuplicate } from './db/bootstrap';
import { tryAcquireLease, releaseLease } from './db/locksRepo';
import { logger } from './utils/logger';

const PORT = Number(process.env.PORT) || 3000;
const sessionString = process.env.SESSION_STRING;

/** Замок одного экземпляра: держим lease, продлеваем, ждём, если он у другого процесса. */
const LEASE_NAME = 'worker';
const LEASE_TTL_SEC = 60;
const LEASE_RENEW_MS = 20_000;
const LEASE_WAIT_MS = 5_000;
const OWNER = randomUUID();
const nowSec = () => Math.floor(Date.now() / 1000);

if (!sessionString) {
  logger.error('SESSION_STRING не задан в .env. Сначала выполните: npm run generate-session');
  process.exit(1);
}

async function main() {
  // Инициализируем БД сразу, чтобы упасть на старте, если с ней что-то не так,
  // а не посреди первого запроса пользователя.
  await getDb();
  const userId = await ensureDefaultUser();
  await migrateLegacyData(userId);

  const userBot = new UserBot(sessionString as string);

  // Бот алертов необязателен: без токена (или с ошибкой настройки) сайт работает как раньше.
  // Webhook можно принимать в любом экземпляре; polling — только в держателе замка (ниже).
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  let alertBot: AlertBot | undefined;
  if (botToken) {
    try {
      alertBot = await createAlertBot(botToken);
    } catch (error: any) {
      logger.error(`Бот алертов не запущен: ${error?.message || error}`);
    }
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN не задан — бот алертов выключен');
  }

  // Порт открываем сразу, не дожидаясь замка: при деплое Render новый экземпляр должен
  // пройти проверку здоровья, пока старый ещё работает и держит замок.
  const app = await createApp(userBot, alertBot);
  const server = app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    logger.info(`Сервер запущен: ${url}`);
    if (!process.env.NO_AUTO_OPEN) {
      import('open')
        .then((mod) => mod.default(url))
        .catch(() => logger.warn(`Не удалось открыть браузер автоматически. Откройте вручную: ${url}`));
    }
  });

  let holdsLease = false;
  let shuttingDown = false;
  let renewTimer: NodeJS.Timeout | undefined;
  let stopWorker: (() => void) | undefined;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Останавливаюсь...');
    clearInterval(renewTimer);
    stopWorker?.();
    server.close();
    await alertBot?.stop().catch(() => {});
    if (holdsLease) {
      await userBot.close().catch(() => {});
      await releaseLease(LEASE_NAME, OWNER).catch(() => {});
    }
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // MTProto (общий аккаунт), polling бота и планировщик — только в одном процессе:
  // две копии одной SESSION_STRING → AUTH_KEY_DUPLICATED, два polling → 409.
  let waitingLogged = false;
  while (!(await tryAcquireLease(LEASE_NAME, OWNER, LEASE_TTL_SEC, nowSec()))) {
    if (shuttingDown) return;
    if (!waitingLogged) {
      logger.warn('Замок держит другой экземпляр сервера — жду его остановки (Telegram и алерты пока не запущены)');
      waitingLogged = true;
    }
    await new Promise((resolve) => setTimeout(resolve, LEASE_WAIT_MS));
  }
  holdsLease = true;
  if (shuttingDown) {
    await releaseLease(LEASE_NAME, OWNER).catch(() => {});
    return;
  }

  renewTimer = setInterval(async () => {
    const renewed = await tryAcquireLease(LEASE_NAME, OWNER, LEASE_TTL_SEC, nowSec()).catch((error) => {
      logger.warn('Не удалось продлить замок (повторю):', error?.message || error);
      return null;
    });
    if (renewed === false) {
      logger.error('Замок перехватил другой экземпляр — останавливаюсь, чтобы не работать двумя копиями');
      void shutdown();
    }
  }, LEASE_RENEW_MS);

  await userBot.init();
  logger.info('Telegram userbot подключён');
  await removeSharedSessionDuplicate(userBot.client);

  alertBot?.startPolling();
  stopWorker = startWorker({
    userBot,
    siteUrl: process.env.PUBLIC_BASE_URL || null,
    notifier: alertBot && botToken ? new TelegramNotifier(botToken) : undefined,
  });
  logger.info('Планировщик алертов запущен');
}

main().catch((error) => {
  logger.error('Не удалось запустить сервер:', error);
  process.exit(1);
});
