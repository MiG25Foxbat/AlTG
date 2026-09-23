import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { Api } from 'teleproto/tl';
import { SessionPasswordNeededError } from 'teleproto/errors';
import { upsertAccount, getDecryptedAccount, deleteAccount } from '../../db/telegramAccountsRepo';
import { logger } from '../../utils/logger';

// Читаем API_ID/API_HASH напрямую из process.env, а не из ../../config/botConfig —
// тот модуль на импорте сам дёргает dotenv.config() и бросает, если переменных
// нет; неожиданный побочный эффект для модуля, который просто хочет два значения
// (в частности, в тестах это перезатирало process.env, выставленный тестом вручную).
const API_CREDENTIALS = { apiId: Number(process.env.API_ID), apiHash: process.env.API_HASH! };
const PENDING_TTL_MS = 5 * 60 * 1000; // 5 минут на ввод кода/пароля — см. docs/tech-stack-final.md, 5.5

interface PendingConnect {
  client: TelegramClient;
  phone: string;
  phoneCodeHash: string;
  createdAt: number;
}

/**
 * Временные артефакты первичной авторизации (phone_code_hash и живое
 * MTProto-соединение, на котором она была начата) — только в памяти
 * процесса, с TTL и автоочисткой, никогда в БД (docs/tech-stack-final.md,
 * 5.5). На один инстанс сервера этого достаточно; при нескольких
 * инстансах тот же паттерн переехал бы в Redis без изменения логики.
 */
const pending = new Map<number, PendingConnect>();

setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of pending) {
    if (now - entry.createdAt > PENDING_TTL_MS) {
      entry.client.disconnect().catch(() => {});
      pending.delete(userId);
    }
  }
}, 60_000).unref();

function takePending(userId: number): PendingConnect | undefined {
  const entry = pending.get(userId);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    entry.client.disconnect().catch(() => {});
    pending.delete(userId);
    return undefined;
  }
  return entry;
}

/** Понятные сообщения для самых частых ошибок MTProto при входе. */
function describeAuthError(error: any): string {
  const code = error?.errorMessage || error?.message || '';
  if (/PHONE_NUMBER_INVALID/.test(code)) return 'Неверный формат номера телефона';
  if (/PHONE_CODE_INVALID/.test(code)) return 'Неверный код подтверждения';
  if (/PHONE_CODE_EXPIRED/.test(code)) return 'Код истёк — начните подключение заново';
  if (/PASSWORD_HASH_INVALID/.test(code)) return 'Неверный пароль двухфакторной аутентификации';
  if (/FLOOD/.test(code)) return 'Telegram временно ограничил попытки — подождите и повторите';
  return code || 'Не удалось подключить Telegram-аккаунт';
}

export type ConnectResult =
  | { status: 'connected'; telegramUserId: number; phoneNumber: string }
  | { status: 'needs_password'; hint?: string };

/** Шаг 1: отправляет код подтверждения на номер телефона. */
export async function startConnect(userId: number, phone: string): Promise<{ isCodeViaApp: boolean }> {
  cancelConnect(userId); // если была незавершённая попытка — не плодим живые соединения

  const client = new TelegramClient(new StringSession(''), API_CREDENTIALS.apiId, API_CREDENTIALS.apiHash, {
    connectionRetries: 3,
  });
  try {
    await client.connect();
    const { phoneCodeHash, isCodeViaApp } = await client.sendCode(API_CREDENTIALS, phone);
    pending.set(userId, { client, phone, phoneCodeHash, createdAt: Date.now() });
    return { isCodeViaApp };
  } catch (error: any) {
    await client.disconnect().catch(() => {});
    throw new Error(describeAuthError(error));
  }
}

/** Шаг 2: код из SMS/приложения. Может потребовать шаг 3 (пароль), если включена 2FA. */
export async function submitCode(userId: number, code: string): Promise<ConnectResult> {
  const entry = takePending(userId);
  if (!entry) throw new Error('Сессия подключения истекла — начните заново с ввода номера');

  try {
    const result = await entry.client.invoke(
      new Api.auth.SignIn({ phoneNumber: entry.phone, phoneCodeHash: entry.phoneCodeHash, phoneCode: code })
    );
    if (result.className !== 'auth.Authorization') {
      throw new Error('Этот номер ещё не зарегистрирован в Telegram');
    }
    return finalizeConnect(userId, entry);
  } catch (error: any) {
    if (error instanceof SessionPasswordNeededError) {
      return { status: 'needs_password' };
    }
    entry.client.disconnect().catch(() => {});
    pending.delete(userId);
    throw new Error(describeAuthError(error));
  }
}

/** Шаг 3 (только если включена двухфакторная аутентификация). */
export async function submitPassword(userId: number, password: string): Promise<ConnectResult> {
  const entry = takePending(userId);
  if (!entry) throw new Error('Сессия подключения истекла — начните заново с ввода номера');

  try {
    await entry.client.signInWithPassword(API_CREDENTIALS, {
      password: async () => password,
      onError: async (err) => {
        throw err;
      },
    });
    return finalizeConnect(userId, entry);
  } catch (error: any) {
    throw new Error(describeAuthError(error));
  } finally {
    // Пароль — либо подошёл (finalizeConnect уже отключил и убрал pending),
    // либо нет — эту попытку в любом случае не переиспользовать повторно.
    if (pending.get(userId) === entry) {
      entry.client.disconnect().catch(() => {});
      pending.delete(userId);
    }
  }
}

async function finalizeConnect(userId: number, entry: PendingConnect): Promise<ConnectResult> {
  const me: any = await entry.client.getMe();
  const sessionString = entry.client.session.save() as unknown as string;
  const phoneNumber = String(me.phone || entry.phone);

  await upsertAccount(userId, { telegramUserId: Number(me.id.toString()), phoneNumber, sessionString });

  await entry.client.disconnect().catch(() => {});
  pending.delete(userId);
  logger.info(`Личный Telegram-аккаунт подключён для пользователя #${userId} (telegram_user_id=${me.id})`);
  return { status: 'connected', telegramUserId: Number(me.id.toString()), phoneNumber };
}

/** Отменяет незавершённую попытку подключения (новый заход, выход из аккаунта и т.п.). */
export function cancelConnect(userId: number): void {
  const entry = pending.get(userId);
  if (!entry) return;
  entry.client.disconnect().catch(() => {});
  pending.delete(userId);
}

/**
 * Поднимает клиент на сохранённой сессии пользователя ровно на один вызов
 * и гарантированно отключает его по завершении — расшифрованная сессия
 * не переживает этот вызов ни в какой переменной дольше него (5.5 дока).
 * undefined, если у пользователя нет подключённого личного аккаунта.
 */
export async function withPersonalClient<T>(
  userId: number,
  fn: (client: TelegramClient) => Promise<T>
): Promise<T | undefined> {
  const account = await getDecryptedAccount(userId);
  if (!account) return undefined;

  const client = new TelegramClient(
    new StringSession(account.sessionString),
    API_CREDENTIALS.apiId,
    API_CREDENTIALS.apiHash,
    { connectionRetries: 3 }
  );
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

export interface PrivateDialog {
  id: string;
  title: string;
}

/** Каналы/супергруппы без публичного @username, в которых уже состоит подключённый аккаунт. */
export async function listPrivateDialogs(userId: number): Promise<PrivateDialog[] | undefined> {
  return withPersonalClient(userId, async (client) => {
    const dialogs = await client.getDialogs({});
    return dialogs
      .filter((d) => (d.isChannel || d.isGroup) && !(d.entity as any)?.username)
      .map((d) => ({ id: d.id!.toString(), title: d.title || 'Без названия' }));
  });
}

/** Полностью отвязывает личный аккаунт: best-effort выход в Telegram + удаление записи из БД. */
export async function disconnectAccount(userId: number): Promise<void> {
  await withPersonalClient(userId, (client) => client.invoke(new Api.auth.LogOut())).catch((error) => {
    logger.warn(`Не удалось разлогинить Telegram-сессию при отключении (продолжаю удаление записи):`, error);
  });
  await deleteAccount(userId);
}
