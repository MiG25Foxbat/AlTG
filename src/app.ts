import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import {
  listChannels,
  upsertChannel,
  setChannelActive,
  removeChannel,
  normalizeChannelUsername,
} from './db/channelsRepo';
import { findUserByUsername, registerUser, getUserById, UsernameTakenError } from './db/usersRepo';
import { hashPassword, verifyPassword } from './utils/crypto';
import { createSessionToken, verifySessionToken, parseCookies, SESSION_COOKIE_NAME } from './utils/session';
import { analyzeTopic } from './modules/AiModule/analyzeService';
import { GeminiConfigError, GeminiQuotaError } from './modules/AiModule/geminiClient';
import { InvalidTimeWindowError, TIME_WINDOW_OPTIONS } from './utils/time';
import { IUserBotReader } from './modules/UserBotModule/IUserBotReader';
import { logger } from './utils/logger';

interface AuthedRequest extends Request {
  userId?: number;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;

function validateCredentials(username: unknown, password: unknown): string | null {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    return 'Логин: 3–32 символа, латинские буквы, цифры и «_»';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`;
  }
  return null;
}

function setSessionCookie(res: Response, userId: number) {
  const { token, maxAgeMs } = createSessionToken(userId);
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: maxAgeMs,
    path: '/',
  });
}

/**
 * Собирает Express-приложение без побочных эффектов (не слушает порт,
 * не трогает process.env, не подключается к Telegram сама). userId
 * теперь приходит не «один на всё приложение» (как было до логина), а
 * из подписанной сессионной куки на каждый запрос — resolveUserId ниже.
 */
export async function createApp(userBot: IUserBotReader) {
  const app = express();
  app.use(express.json());

  // Читает и проверяет сессионную куку, кладёт userId в req, если сессия
  // валидна. Сама по себе не блокирует запрос — это делает requireAuth
  // на конкретных роутах, чтобы /api/register и /api/login оставались
  // публичными, а /api/time-windows не тянул за собой требование входа.
  app.use((req: AuthedRequest, _res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const userId = verifySessionToken(cookies[SESSION_COOKIE_NAME]);
    if (userId) req.userId = userId;
    next();
  });

  function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
    if (!req.userId) {
      return res.status(401).json({ error: 'Нужно войти в аккаунт' });
    }
    next();
  }

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // --- Аутентификация ---

  app.post('/api/register', async (req: Request, res: Response) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const validationError = validateCredentials(username, password);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    let userId: number;
    try {
      const passwordHash = await hashPassword(password);
      userId = await registerUser(username, passwordHash);
    } catch (error: any) {
      if (error instanceof UsernameTakenError) {
        return res.status(409).json({ error: error.message });
      }
      throw error;
    }

    setSessionCookie(res, userId);
    res.status(201).json({ id: userId, username });
  });

  app.post('/api/login', async (req: Request, res: Response) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password) {
      return res.status(400).json({ error: 'Введите логин и пароль' });
    }

    const user = await findUserByUsername(username);
    const passwordOk = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !passwordOk) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    setSessionCookie(res, user.id);
    res.json({ id: user.id, username });
  });

  app.post('/api/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.status(204).end();
  });

  app.get('/api/me', async (req: AuthedRequest, res: Response) => {
    const user = req.userId ? await getUserById(req.userId) : undefined;
    if (!user) {
      return res.status(401).json({ error: 'Не авторизован' });
    }
    res.json(user);
  });

  // --- Каналы (требуют входа — список каналов принадлежит аккаунту) ---

  app.get('/api/channels', requireAuth, async (req: AuthedRequest, res) => {
    res.json(await listChannels(req.userId!));
  });

  app.post('/api/channels', requireAuth, async (req: AuthedRequest, res: Response) => {
    const raw = String(req.body?.username || '');
    let username: string;
    try {
      username = normalizeChannelUsername(raw);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }

    const existing = (await listChannels(req.userId!)).find((c) => c.username === username);
    if (existing) {
      return res.status(409).json({ error: `Канал ${username} уже добавлен` });
    }

    const resolved = await userBot.resolveChannel(username);
    if (!resolved) {
      return res.status(404).json({
        error: `Канал ${username} не найден или недоступен для чтения (учтите: пока поддерживаются только открытые каналы)`,
      });
    }

    const channel = await upsertChannel(req.userId!, username, resolved.title);
    res.status(201).json(channel);
  });

  app.patch('/api/channels/:username', requireAuth, async (req: AuthedRequest, res: Response) => {
    const username = normalizeChannelUsername(String(req.params.username));
    const isActive = Boolean(req.body?.isActive);
    const updated = await setChannelActive(req.userId!, username, isActive);
    if (!updated) {
      return res.status(404).json({ error: `Канал ${username} не найден` });
    }
    res.json(updated);
  });

  app.delete('/api/channels/:username', requireAuth, async (req: AuthedRequest, res: Response) => {
    const username = normalizeChannelUsername(String(req.params.username));
    const removed = await removeChannel(req.userId!, username);
    if (!removed) {
      return res.status(404).json({ error: `Канал ${username} не найден` });
    }
    res.status(204).end();
  });

  // --- Настройки для интерфейса (публично — статичный список, не тянет вход) ---

  app.get('/api/time-windows', (_req, res) => {
    res.json(TIME_WINDOW_OPTIONS);
  });

  // --- Основное действие: получить + отфильтровать + суммаризировать ---

  app.post('/api/analyze', requireAuth, async (req: AuthedRequest, res: Response) => {
    const topic = String(req.body?.topic || '').trim();
    const windowMinutes = Number(req.body?.windowMinutes);

    if (!topic) {
      return res.status(400).json({ error: 'Введите тему запроса' });
    }
    if ((await listChannels(req.userId!)).filter((c) => c.isActive).length === 0) {
      return res
        .status(400)
        .json({ error: 'Нет ни одного активного канала — добавьте канал во вкладке «Каналы»' });
    }

    const result = await analyzeTopic(userBot, req.userId!, topic, windowMinutes);
    res.json(result);
  });

  // --- Обработка ошибок ---
  // Express 5 сам пробрасывает сюда отклонённые промисы из async-хендлеров выше.
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
