import { createClient, Client } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

function ensureDirExists(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let dbPromise: Promise<Client> | null = null;

/**
 * Возвращает singleton-клиент БД (Turso/libSQL) и гарантирует, что новая
 * многопользовательская схема создана. `url`: TURSO_DATABASE_URL (+
 * TURSO_AUTH_TOKEN) для прода, иначе локальный файл DB_PATH (или
 * ':memory:' в тестах) — переключение окружением, без раздвоения кода
 * между dev и prod (см. docs/tech-stack-final.md, раздел 5.2).
 *
 * concurrency: 1 — намеренно, не для экономии ресурсов: local-file режим
 * @libsql/client держит пул до 20 соединений по умолчанию, а
 * "PRAGMA foreign_keys = ON" применяется только к тому соединению, на
 * котором была выполнена — на пуле >1 это не гарантирует ON DELETE
 * CASCADE на каждом запросе. Один коннект убирает риск целиком; для
 * нагрузки одного локального процесса это не бутылочное горлышко.
 *
 * Кэшируется именно Promise, а не разрешённый клиент: если кэшировать
 * клиент, то конкурентный вызов, пришедший между `createClient()` и
 * концом `await db.batch(...)` (создание схемы), пройдёт мимо проверки
 * "клиент уже есть" и получит клиент с ещё не созданными таблицами.
 * Кэш промиса гарантирует, что все вызовы — и параллельные тоже —
 * ждут одного и того же завершения инициализации.
 */
export async function getDb(): Promise<Client> {
  if (dbPromise) return dbPromise;

  dbPromise = initDb();
  return dbPromise;
}

async function initDb(): Promise<Client> {
  const dbPath = process.env.DB_PATH || './data/app.db';
  const url =
    process.env.TURSO_DATABASE_URL || (dbPath === ':memory:' ? ':memory:' : `file:${dbPath}`);
  if (!process.env.TURSO_DATABASE_URL && dbPath !== ':memory:') {
    ensureDirExists(dbPath);
  }

  const db = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
    concurrency: 1,
  });

  await db.execute('PRAGMA foreign_keys = ON');

  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS users (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at     INTEGER NOT NULL,
        status         TEXT NOT NULL DEFAULT 'active',
        last_active_at INTEGER,
        username       TEXT,
        password_hash  TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS telegram_accounts (
        id                        INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id                   INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        telegram_user_id          INTEGER NOT NULL UNIQUE,
        phone_number_encrypted    TEXT NOT NULL,
        session_string_encrypted  TEXT NOT NULL,
        session_status            TEXT NOT NULL DEFAULT 'active',
        connected_at              INTEGER NOT NULL,
        session_last_used_at      INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS topics (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label       TEXT NOT NULL,
        is_active   INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        last_run_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS user_channels (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel_identifier TEXT NOT NULL,
        channel_title      TEXT,
        is_private         INTEGER NOT NULL DEFAULT 0,
        is_active          INTEGER NOT NULL DEFAULT 1,
        added_at           INTEGER NOT NULL,
        UNIQUE(user_id, channel_identifier)
      )`,
      `CREATE TABLE IF NOT EXISTS public_posts (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_username  TEXT NOT NULL,
        message_id        INTEGER NOT NULL,
        text              TEXT NOT NULL,
        posted_at         INTEGER NOT NULL,
        fetched_at        INTEGER NOT NULL,
        UNIQUE(channel_username, message_id)
      )`,
      `CREATE TABLE IF NOT EXISTS private_posts (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel_identifier TEXT NOT NULL,
        message_id         INTEGER NOT NULL,
        text               TEXT NOT NULL,
        posted_at          INTEGER NOT NULL,
        fetched_at         INTEGER NOT NULL,
        UNIQUE(user_id, channel_identifier, message_id)
      )`,
      `CREATE TABLE IF NOT EXISTS activity_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_type   TEXT NOT NULL,
        detail       TEXT,
        occurred_at  INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id, occurred_at)`,
      `CREATE INDEX IF NOT EXISTS idx_public_posts_posted_at ON public_posts(posted_at)`,
      `CREATE INDEX IF NOT EXISTS idx_public_posts_channel ON public_posts(channel_username)`,
    ],
    'write'
  );

  await ensureUsersAuthColumns(db);

  logger.info(`БД готова (libSQL): ${process.env.TURSO_DATABASE_URL ? 'Turso (remote)' : url}`);
  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` не добавляет колонки в уже существующую
 * таблицу — на инстансах, где `users` создана до появления логина,
 * `username`/`password_hash` нужно добавить отдельно через ALTER TABLE.
 * Идемпотентно: проверяет `PRAGMA table_info`, добавляет только то, чего
 * не хватает. UNIQUE-индекс на username безопасен с множеством NULL —
 * SQLite/libSQL считает каждый NULL уникальным сам по себе.
 */
async function ensureUsersAuthColumns(db: Client): Promise<void> {
  const info = await db.execute('PRAGMA table_info(users)');
  const existingColumns = new Set(
    (info.rows as unknown as { name: string }[]).map((row) => row.name)
  );

  if (!existingColumns.has('username')) {
    await db.execute('ALTER TABLE users ADD COLUMN username TEXT');
  }
  if (!existingColumns.has('password_hash')) {
    await db.execute('ALTER TABLE users ADD COLUMN password_hash TEXT');
  }
  await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');
}

export function closeDb() {
  if (!dbPromise) return;
  const pending = dbPromise;
  dbPromise = null;
  pending.then((client) => client.close()).catch(() => {});
}
