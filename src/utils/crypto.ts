import { randomBytes, createCipheriv, createDecipheriv, createHmac, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // рекомендованная длина IV для GCM
const PASSWORD_SALT_LENGTH = 16;
const PASSWORD_KEY_LENGTH = 64;

/**
 * Шифрование чувствительных полей (session_string, phone_number) перед
 * записью в БД — см. docs/tech-stack-final.md, раздел 5.4. AES-256-GCM
 * через встроенный node:crypto: ничего дополнительного ставить не нужно,
 * шифр с аутентификацией защищает и от подмены зашифрованных данных, не
 * только от чтения (decrypt бросает, если ciphertext/authTag повреждены).
 */
function loadKey(): Buffer {
  const raw = process.env.SESSION_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'SESSION_ENCRYPTION_KEY не задан в .env — сгенерируйте: openssl rand -base64 32'
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `SESSION_ENCRYPTION_KEY должен декодироваться в 32 байта, получено ${key.length}`
    );
  }
  return key;
}

/** Шифрует строку в формат "iv:authTag:ciphertext" (все части в base64). */
export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Расшифровывает строку из encrypt(). Бросает при повреждении/подмене данных. */
export function decrypt(payload: string): string {
  const key = loadKey();
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Повреждённый формат зашифрованных данных (ожидалось iv:authTag:ciphertext)');
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/**
 * Ключ, производный от SESSION_ENCRYPTION_KEY для конкретной цели (HMAC
 * с уникальным `purpose` вместо самого секрета) — так подпись веб-сессии
 * (см. utils/session.ts) не использует напрямую ключ, которым шифруются
 * session_string/phone_number: компрометация одного назначения не даёт
 * материала для другого, а заводить второй обязательный секрет в .env
 * ради этого не нужно.
 */
export function deriveKey(purpose: string): Buffer {
  return createHmac('sha256', loadKey()).update(purpose).digest();
}

/**
 * Хеширует пароль для хранения в БД: scrypt (встроен в node:crypto,
 * ничего дополнительного ставить не нужно) со случайной солью на пароль.
 * Формат — "salt:hash" (обе части в base64).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PASSWORD_SALT_LENGTH);
  const derived = (await scryptAsync(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
  return `${salt.toString('base64')}:${derived.toString('base64')}`;
}

/** Сверяет пароль с хешем из hashPassword() — таймингово-безопасное сравнение. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [saltB64, expectedB64] = hash.split(':');
  if (!saltB64 || !expectedB64) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(expectedB64, 'base64');
  const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
