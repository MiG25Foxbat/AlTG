import dotenv from 'dotenv';
dotenv.config();

import { UserBot } from './modules/UserBotModule/UserBot';
import { createApp } from './app';
import { getDb, closeDb } from './db/database';
import { logger } from './utils/logger';

const PORT = Number(process.env.PORT) || 3000;
const sessionString = process.env.SESSION_STRING;

if (!sessionString) {
  logger.error('SESSION_STRING не задан в .env. Сначала выполните: npm run generate-session');
  process.exit(1);
}

async function main() {
  // Инициализируем БД сразу, чтобы упасть на старте, если с ней что-то не так,
  // а не посреди первого запроса пользователя.
  getDb();

  const userBot = new UserBot(sessionString as string);
  await userBot.init();
  logger.info('Telegram userbot подключён');

  const app = createApp(userBot);

  const server = app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    logger.info(`Сервер запущен: ${url}`);
    if (!process.env.NO_AUTO_OPEN) {
      import('open')
        .then((mod) => mod.default(url))
        .catch(() => logger.warn(`Не удалось открыть браузер автоматически. Откройте вручную: ${url}`));
    }
  });

  const shutdown = async () => {
    logger.info('Останавливаюсь...');
    server.close();
    await userBot.close();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error('Не удалось запустить сервер:', error);
  process.exit(1);
});
