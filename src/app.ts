import path from 'path';
import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  listChannels,
  upsertChannel,
  setChannelActive,
  removeChannel,
  normalizeChannelUsername,
  parseChannelParam,
  countMonitoredChannels,
} from './db/channelsRepo';
import { listGroups, createGroup, updateGroup, deleteGroup, setChannelGroup, normalizeGroupName } from './db/groupsRepo';
import { listTopics, addTopic, updateTopic, deleteTopic, resolveTopicChannels } from './db/alertsRepo';
import { findUserByUsername, registerUser, getUserById, UsernameTakenError } from './db/usersRepo';
import { hasAccount as hasTelegramAccount } from './db/telegramAccountsRepo';
import { createLinkToken, getLinkByUser } from './db/destinationsRepo';
import { WEBHOOK_PATH } from './modules/BotModule/bot';
import { hashPassword, verifyPassword } from './utils/crypto';
import { createSessionToken, verifySessionToken, parseCookies, SESSION_COOKIE_NAME } from './utils/session';
import {
  startConnect,
  submitCode,
  submitPassword,
  cancelConnect,
  disconnectAccount,
  listPrivateDialogs,
} from './modules/UserBotModule/personalAccount';
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
export interface AppBotOptions {
  username: string;
  /** Только в режиме webhook */
  webhookHandler?: RequestHandler;
}

export async function createApp(userBot: IUserBotReader, bot?: AppBotOptions) {
  const app = express();
  app.use(express.json());
  // Telegram → бот. Подлинность проверяет сам обработчик по secret_token.
  if (bot?.webhookHandler) app.post(WEBHOOK_PATH, bot.webhookHandler);

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

  // Тело — любое из полей: isActive (вкл/выкл мониторинг), groupId (number | null).
  app.patch('/api/channels/:username', requireAuth, async (req: AuthedRequest, res: Response) => {
    const username = parseChannelParam(String(req.params.username));
    if (req.body && 'groupId' in req.body) {
      const groupId = req.body.groupId === null ? null : Number(req.body.groupId);
      if (groupId !== null && !Number.isInteger(groupId)) {
        return res.status(400).json({ error: 'Некорректная группа' });
      }
      if (!(await setChannelGroup(req.userId!, username, groupId))) {
        return res.status(404).json({ error: 'Канал или группа не найдены' });
      }
    }
    if (req.body && 'isActive' in req.body) {
      await setChannelActive(req.userId!, username, Boolean(req.body.isActive));
    }
    const updated = (await listChannels(req.userId!)).find((c) => c.username === username);
    if (!updated) {
      return res.status(404).json({ error: `Канал ${username} не найден` });
    }
    res.json(updated);
  });

  app.delete('/api/channels/:username', requireAuth, async (req: AuthedRequest, res: Response) => {
    const username = parseChannelParam(String(req.params.username));
    const removed = await removeChannel(req.userId!, username);
    if (!removed) {
      return res.status(404).json({ error: `Канал ${username} не найден` });
    }
    res.status(204).end();
  });

  // --- Личный Telegram-аккаунт (для чтения приватных каналов пользователя) ---
  // Риск ограничений от Telegram не нулевой при автоматизации через личный
  // аккаунт (docs/tech-stack-final.md, раздел 3) — предупреждение об этом
  // показывается в интерфейсе перед подключением, не только в коде.

  app.get('/api/telegram/status', requireAuth, async (req: AuthedRequest, res: Response) => {
    res.json({ connected: await hasTelegramAccount(req.userId!) });
  });

  app.post('/api/telegram/connect/start', requireAuth, async (req: AuthedRequest, res: Response) => {
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
    if (!/^\+?\d{7,15}$/.test(phone)) {
      return res.status(400).json({ error: 'Введите номер телефона в международном формате, например +79991234567' });
    }
    try {
      res.json(await startConnect(req.userId!, phone));
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/telegram/connect/code', requireAuth, async (req: AuthedRequest, res: Response) => {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!code) {
      return res.status(400).json({ error: 'Введите код подтверждения' });
    }
    try {
      res.json(await submitCode(req.userId!, code));
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/telegram/connect/password', requireAuth, async (req: AuthedRequest, res: Response) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password) {
      return res.status(400).json({ error: 'Введите пароль двухфакторной аутентификации' });
    }
    try {
      res.json(await submitPassword(req.userId!, password));
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/telegram/connect/cancel', requireAuth, (req: AuthedRequest, res: Response) => {
    cancelConnect(req.userId!);
    res.status(204).end();
  });

  app.post('/api/telegram/disconnect', requireAuth, async (req: AuthedRequest, res: Response) => {
    await disconnectAccount(req.userId!);
    res.status(204).end();
  });

  app.get('/api/telegram/private-dialogs', requireAuth, async (req: AuthedRequest, res: Response) => {
    const dialogs = await listPrivateDialogs(req.userId!);
    if (!dialogs) {
      return res.status(409).json({ error: 'Сначала подключите личный Telegram-аккаунт' });
    }
    res.json(dialogs);
  });

  app.post('/api/channels/private', requireAuth, async (req: AuthedRequest, res: Response) => {
    const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : null;
    if (!id) {
      return res.status(400).json({ error: 'Не указан канал' });
    }
    const existing = (await listChannels(req.userId!)).find((c) => c.username === id);
    if (existing) {
      return res.status(409).json({ error: 'Этот канал уже добавлен' });
    }
    const channel = await upsertChannel(req.userId!, id, title, true);
    res.status(201).json(channel);
  });

  // --- Группы каналов ---

  const idParam = (req: Request) => Number(req.params.id);

  app.get('/api/groups', requireAuth, async (req: AuthedRequest, res: Response) => {
    res.json(await listGroups(req.userId!));
  });

  app.post('/api/groups', requireAuth, async (req: AuthedRequest, res: Response) => {
    let name: string;
    try {
      name = normalizeGroupName(req.body?.name);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
    res.status(201).json(await createGroup(req.userId!, name));
  });

  app.patch('/api/groups/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
    const patch: { name?: string; isActive?: boolean } = {};
    try {
      if (req.body && 'name' in req.body) patch.name = normalizeGroupName(req.body.name);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
    if (req.body && 'isActive' in req.body) patch.isActive = Boolean(req.body.isActive);
    const group = await updateGroup(req.userId!, idParam(req), patch);
    if (!group) return res.status(404).json({ error: 'Группа не найдена' });
    res.json(group);
  });

  app.delete('/api/groups/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
    if (!(await deleteGroup(req.userId!, idParam(req)))) {
      return res.status(404).json({ error: 'Группа не найдена' });
    }
    res.status(204).end();
  });

  // --- Алерты: подписки (тема + свои настройки). Доставка — см. планировщик ---

  app.get('/api/alerts/topics', requireAuth, async (req: AuthedRequest, res: Response) => {
    res.json(await listTopics(req.userId!));
  });

  app.post('/api/alerts/topics', requireAuth, async (req: AuthedRequest, res: Response) => {
    try {
      res.status(201).json(await addTopic(req.userId!, req.body?.label, req.body?.settings));
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.patch('/api/alerts/topics/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
    const { label, isActive, settings } = req.body ?? {};
    let topic;
    try {
      topic = await updateTopic(req.userId!, idParam(req), { label, isActive, settings });
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
    if (!topic) return res.status(404).json({ error: 'Тема не найдена' });
    res.json(topic);
  });

  app.delete('/api/alerts/topics/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
    if (!(await deleteTopic(req.userId!, idParam(req)))) {
      return res.status(404).json({ error: 'Тема не найдена' });
    }
    res.status(204).end();
  });

  // --- Привязка бота: статус и одноразовая ссылка t.me/<бот>?start=<токен> (15 минут) ---

  app.get('/api/alerts/bot', requireAuth, async (req: AuthedRequest, res: Response) => {
    const link = await getLinkByUser(req.userId!);
    res.json({
      configured: Boolean(bot),
      botUsername: bot?.username ?? null,
      linked: Boolean(link),
      status: link?.status ?? null,
      pausedUntil: link?.pausedUntil ?? null,
    });
  });

  app.post('/api/alerts/bot-link', requireAuth, async (req: AuthedRequest, res: Response) => {
    if (!bot) return res.status(503).json({ error: 'Бот не настроен на сервере (нет TELEGRAM_BOT_TOKEN)' });
    const token = await createLinkToken(req.userId!, Math.floor(Date.now() / 1000));
    res.json({ url: `https://t.me/${bot.username}?start=${token}` });
  });

  /**
   * «Что пришло бы сейчас»: поиск по каждой активной подписке за окно = её
   * интервал, с её областью каналов и порогом minMatches. Ничего не отправляет.
   * ponytail: последовательно по темам, каждая фетчит сама; на общий конвейер
   * планировщика (один fetch на пользователя) переводится на этапе 6.
   */
  app.post('/api/alerts/preview', requireAuth, async (req: AuthedRequest, res: Response) => {
    const userId = req.userId!;
    const activeTopics = (await listTopics(userId)).filter((t) => t.isActive);
    if (activeTopics.length === 0) {
      return res.status(400).json({ error: 'Добавьте хотя бы одну активную тему' });
    }

    const results = [];
    for (const topic of activeTopics) {
      try {
        const onlyChannels = await resolveTopicChannels(userId, topic.settings);
        if (onlyChannels && onlyChannels.size === 0) {
          results.push({ topic: topic.label, wouldSend: false, error: 'В выбранных группах/каналах нет каналов' });
          continue;
        }
        const result = await analyzeTopic(userBot, userId, topic.label, topic.settings.intervalMinutes, onlyChannels);
        results.push({ topic: topic.label, wouldSend: result.items.length >= topic.settings.minMatches, result });
      } catch (error: any) {
        results.push({ topic: topic.label, wouldSend: false, error: error?.message || 'Ошибка анализа' });
      }
    }
    res.json({ results });
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
    if ((await countMonitoredChannels(req.userId!)) === 0) {
      return res
        .status(400)
        .json({ error: 'Нет ни одного активного канала — добавьте или включите канал во вкладке «Каналы»' });
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
