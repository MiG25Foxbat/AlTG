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

let db: Client | null = null;

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
 */
export async function getDb(): Promise<Client> {
  if (db) return db;

  const dbPath = process.env.DB_PATH || './data/app.db';
  const url =
    process.env.TURSO_DATABASE_URL || (dbPath === ':memory:' ? ':memory:' : `file:${dbPath}`);
  if (!process.env.TURSO_DATABASE_URL && dbPath !== ':memory:') {
    ensureDirExists(dbPath);
  }

  db = createClient({
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
        last_active_at INTEGER
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

  logger.info(`БД готова (libSQL): ${process.env.TURSO_DATABASE_URL ? 'Turso (remote)' : url}`);
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
