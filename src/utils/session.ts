import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveKey } from './crypto';

export const SESSION_COOKIE_NAME = 'session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 дней — «зашёл один раз, дальше просто открываю»

function sign(payload: string): string {
  return createHmac('sha256', deriveKey('web-session')).update(payload).digest('base64url');
}

/** Подписанный токен вида "userId.expiry.signature" — кладётся в HTTP-only куку. */
export function createSessionToken(userId: number): { token: string; maxAgeMs: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${userId}.${expiresAt}`;
  return { token: `${payload}.${sign(payload)}`, maxAgeMs: SESSION_TTL_SECONDS * 1000 };
}

/** Проверяет токен из куки: подпись, срок действия. Возвращает userId или null. */
export function verifySessionToken(token: string | undefined): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userIdRaw, expiresAtRaw, signature] = parts;
  const payload = `${userIdRaw}.${expiresAtRaw}`;
  const expected = sign(payload);

  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return null;
  }
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return null;
  }
  const userId = Number(userIdRaw);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

/**
 * Разбор заголовка Cookie вручную — без cookie-parser: он делает ровно
 * то же самое для одного нужного нам имени куки, добавлять зависимость
 * ради этого незачем.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}
