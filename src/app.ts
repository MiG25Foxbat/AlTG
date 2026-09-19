import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import {
  listChannels,
  upsertChannel,
  setChannelActive,
  removeChannel,
  normalizeChannelUsername,
} from './db/channelsRepo';
import { getOrCreateSoleUser } from './db/usersRepo';
import { analyzeTopic } from './modules/AiModule/analyzeService';
import { GeminiConfigError, GeminiQuotaError } from './modules/AiModule/geminiClient';
import { InvalidTimeWindowError, TIME_WINDOW_OPTIONS } from './utils/time';
import { IUserBotReader } from './modules/UserBotModule/IUserBotReader';
import { logger } from './utils/logger';

/**
 * Собирает Express-приложение без побочных эффектов (не слушает порт,
 * не трогает process.env, не подключается к Telegram сама). userId
 * резолвится один раз здесь через getOrCreateSoleUser() — прототип
 * работает как один локальный оператор без экрана логина (см.
 * docs/tech-stack-final.md), но всё под капотом уже per-user-scoped.
 */
export async function createApp(userBot: IUserBotReader) {
  const userId = await getOrCreateSoleUser();

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // --- Каналы ---

  app.get('/api/channels', async (_req, res) => {
    res.json(await listChannels(userId));
  });

  app.post('/api/channels', async (req: Request, res: Response) => {
    const raw = String(req.body?.username || '');
    let username: string;
    try {
      username = normalizeChannelUsername(raw);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }

    const existing = (await listChannels(userId)).find((c) => c.username === username);
    if (existing) {
      return res.status(409).json({ error: `Канал ${username} уже добавлен` });
    }

    const resolved = await userBot.resolveChannel(username);
    if (!resolved) {
      return res.status(404).json({
        error: `Канал ${username} не найден или недоступен для чтения (учтите: пока поддерживаются только открытые каналы)`,
      });
    }

    const channel = await upsertChannel(userId, username, resolved.title);
    res.status(201).json(channel);
  });

  app.patch('/api/channels/:username', async (req: Request, res: Response) => {
    const username = normalizeChannelUsername(String(req.params.username));
    const isActive = Boolean(req.body?.isActive);
    const updated = await setChannelActive(userId, username, isActive);
    if (!updated) {
      return res.status(404).json({ error: `Канал ${username} не найден` });
    }
    res.json(updated);
  });

  app.delete('/api/channels/:username', async (req: Request, res: Response) => {
    const username = normalizeChannelUsername(String(req.params.username));
    const removed = await removeChannel(userId, username);
    if (!removed) {
      return res.status(404).json({ error: `Канал ${username} не найден` });
    }
    res.status(204).end();
  });

  // --- Настройки для интерфейса ---

  app.get('/api/time-windows', (_req, res) => {
    res.json(TIME_WINDOW_OPTIONS);
  });

  // --- Основное действие: получить + отфильтровать + суммаризировать ---

  app.post('/api/analyze', async (req: Request, res: Response) => {
    const topic = String(req.body?.topic || '').trim();
    const windowMinutes = Number(req.body?.windowMinutes);

    if (!topic) {
      return res.status(400).json({ error: 'Введите тему запроса' });
    }
    if ((await listChannels(userId)).filter((c) => c.isActive).length === 0) {
      return res
        .status(400)
        .json({ error: 'Нет ни одного активного канала — добавьте канал во вкладке «Каналы»' });
    }

    const result = await analyzeTopic(userBot, userId, topic, windowMinutes);
    res.json(result);
  });

  // --- Обработка ошибок ---
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof InvalidTimeWindowError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof GeminiConfigError) {
      return res.status(500).json({ error: err.message });
    }
    if (err instanceof GeminiQuotaError) {
      return res.status(429).json({ error: err.message });
    }
    logger.error('Необработанная ошибка API:', err);
    res.status(500).json({ error: err?.message || 'Внутренняя ошибка сервера' });
  });

  return app;
}
