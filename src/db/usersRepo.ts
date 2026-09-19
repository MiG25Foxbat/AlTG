import { getDb } from './database';

/**
 * Мост к многопользовательской схеме для системного Telegram-подключения
 * (см. bootstrap.ts): при самом первом запуске приложения, ещё до того как
 * появился хоть один зарегистрированный пользователь, создаёт единственную
 * системную строку в users, к которой bootstrap.ts привязывает аккаунт из
 * .env SESSION_STRING. После этого таблица больше не пуста, и функция
 * всегда возвращает эту же самую (первую по id) строку — не создаёт вторую.
 */
export async function getOrCreateSoleUser(): Promise<number> {
  const db = await getDb();
  const existing = await db.execute('SELECT id FROM users ORDER BY id LIMIT 1');
  if (existing.rows.length > 0) {
    return Number((existing.rows[0] as unknown as { id: number }).id);
  }
  const now = Math.floor(Date.now() / 1000);
  const result = await db.execute({
    sql: 'INSERT INTO users (created_at, status, last_active_at) VALUES (?, ?, ?)',
    args: [now, 'active', now],
  });
  return Number(result.lastInsertRowid);
}

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`Логин «${username}» уже занят`);
    this.name = 'UsernameTakenError';
  }
}

/** Данные пользователя для проверки логина — password_hash наружу дальше не идёт. */
export interface UserCredentials {
  id: number;
  passwordHash: string;
}

export async function findUserByUsername(username: string): Promise<UserCredentials | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT id, password_hash FROM users WHERE username = ?',
    args: [username],
  });
  const row = result.rows[0] as unknown as { id: number; password_hash: string } | undefined;
  return row ? { id: row.id, passwordHash: row.password_hash } : undefined;
}

export interface UserPublicInfo {
  id: number;
  username: string;
}

export async function getUserById(userId: number): Promise<UserPublicInfo | undefined> {
  const db = await getDb();
  const result = await db.execute({ sql: 'SELECT id, username FROM users WHERE id = ?', args: [userId] });
  const row = result.rows[0] as unknown as { id: number; username: string | null } | undefined;
  return row && row.username ? { id: row.id, username: row.username } : undefined;
}

/**
 * Регистрирует нового пользователя интерфейса (логин + хеш пароля).
 *
 * Особый случай: если в БД уже есть "осиротевшая" системная строка без
 * username (та самая единственная строка из getOrCreateSoleUser(), к
 * которой bootstrap.ts привязал текущий Telegram-аккаунт и под которой,
 * возможно, уже сохранены каналы прежнего однооператорского режима) — эту
 * строку "забирает" именно ПЕРВЫЙ зарегистрировавшийся, а не заводит
 * пустой аккаунт рядом. Иначе уже сохранённые каналы/Telegram-подключение
 * оказались бы недоступны ни одному логину. Все последующие регистрации
 * такую строку уже не найдут (у неё появится username) и создадут новую.
 */
export async function registerUser(username: string, passwordHash: string): Promise<number> {
  const db = await getDb();

  const taken = await db.execute({ sql: 'SELECT 1 FROM users WHERE username = ?', args: [username] });
  if (taken.rows.length > 0) {
    throw new UsernameTakenError(username);
  }

  const unclaimed = await db.execute('SELECT id FROM users WHERE username IS NULL ORDER BY id LIMIT 1');
  if (unclaimed.rows.length > 0) {
    const id = (unclaimed.rows[0] as unknown as { id: number }).id;
    await db.execute({
      sql: 'UPDATE users SET username = ?, password_hash = ? WHERE id = ?',
      args: [username, passwordHash, id],
    });
    return id;
  }

  const now = Math.floor(Date.now() / 1000);
  const result = await db.execute({
    sql: 'INSERT INTO users (created_at, status, last_active_at, username, password_hash) VALUES (?, ?, ?, ?, ?)',
    args: [now, 'active', now, username, passwordHash],
  });
  return Number(result.lastInsertRowid);
}
