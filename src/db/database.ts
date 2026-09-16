import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

function ensureDirExists(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let db: DatabaseSync | null = null;

/**
 * Возвращает singleton-соединение с SQLite и гарантирует, что схема создана.
 * Используется встроенный в Node модуль node:sqlite (Node 22.13+/23.4+, без
 * флагов) — никакой нативной сборки при npm install не требуется, в отличие
 * от better-sqlite3, для которого на Windows без Visual Studio Build Tools
 * npm install падает на компиляции.
 */
export function getDb(): DatabaseSync {
  if (db) return db;

  const dbPath = process.env.DB_PATH || './data/app.db';
  if (dbPath !== ':memory:') {
    ensureDirExists(dbPath);
  }
  db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA journal_mode = WAL'); // на :memory: — безвредный no-op

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      username   TEXT PRIMARY KEY,
      title      TEXT,
      added_at   INTEGER NOT NULL,
      is_active  INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS posts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_username  TEXT NOT NULL REFERENCES channels(username) ON DELETE CASCADE,
      message_id        INTEGER NOT NULL,
      text              TEXT NOT NULL,
      posted_at         INTEGER NOT NULL,
      fetched_at        INTEGER NOT NULL,
      UNIQUE(channel_username, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_posts_posted_at ON posts(posted_at);
    CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel_username);
  `);

  logger.info(`SQLite готова: ${dbPath}`);
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
