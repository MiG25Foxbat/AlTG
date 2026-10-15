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

  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS channel_groups (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        is_active  INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )`,
      // Куда доставлять алерты. Сейчас только личка с ботом; группа компании
      // (chat_id + thread_id) и почта — новые kind + один класс Notifier.
      // paused_until — пауза из бота: глушит всё, что идёт этому получателю.
      `CREATE TABLE IF NOT EXISTS alert_destinations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL,
        chat_id      INTEGER,
        thread_id    INTEGER,
        email        TEXT,
        status       TEXT NOT NULL DEFAULT 'active',
        paused_until INTEGER,
        created_at   INTEGER NOT NULL
      )`,
      // Один личный чат на пользователя и один пользователь на личный чат.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_destinations_private_user
         ON alert_destinations(user_id) WHERE kind = 'telegram_private'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_destinations_private_chat
         ON alert_destinations(chat_id) WHERE kind = 'telegram_private'`,
      // Одноразовые токены для t.me/<бот>?start=<токен>: в БД, а не в памяти —
      // процесс на Render засыпает. Храним только хеш.
      `CREATE TABLE IF NOT EXISTS bot_link_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        used_at    INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS alert_reports (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id   INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        urgency    TEXT NOT NULL,
        loud       INTEGER NOT NULL DEFAULT 0,
        items_json TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'held',
        hold_until INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_alert_reports_held ON alert_reports(status, hold_until)`,
      // Все посты, обработанные подпиской, а не только отправленные —
      // чтобы нерелевантное не уходило в LLM повторно. report_id не NULL = попал в отчёт.
      `CREATE TABLE IF NOT EXISTS topic_seen_posts (
        topic_id           INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        channel_identifier TEXT NOT NULL,
        message_id         INTEGER NOT NULL,
        report_id          INTEGER,
        seen_at            INTEGER NOT NULL,
        PRIMARY KEY (topic_id, channel_identifier, message_id)
      )`,
      `CREATE TABLE IF NOT EXISTS outbox (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        destination_id       INTEGER NOT NULL REFERENCES alert_destinations(id) ON DELETE CASCADE,
        text_html            TEXT NOT NULL,
        disable_notification INTEGER NOT NULL DEFAULT 0,
        reply_markup_json    TEXT,
        status               TEXT NOT NULL DEFAULT 'pending',
        attempts             INTEGER NOT NULL DEFAULT 0,
        next_attempt_at      INTEGER NOT NULL,
        locked_at            INTEGER,
        last_error           TEXT,
        created_at           INTEGER NOT NULL,
        sent_at              INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_attempt_at)`,
      `CREATE TABLE IF NOT EXISTS alert_feedback (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        topic_id   INTEGER REFERENCES topics(id) ON DELETE SET NULL,
        report_id  INTEGER,
        action     TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      // Замок одного экземпляра: MTProto-клиенты и планировщик — только в
      // процессе, держащем lease (при деплое старый и новый инстанс живут вместе).
      `CREATE TABLE IF NOT EXISTS service_locks (
        name       TEXT PRIMARY KEY,
        owner      TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
    ],
    'write'
  );
  await ensureColumn(db, 'user_channels', 'group_id', 'INTEGER REFERENCES channel_groups(id) ON DELETE SET NULL');
  // Подписка = строка topics (тема) + свои настройки. settings_json NULL = дефолты.
  await ensureColumn(db, 'topics', 'settings_json', 'TEXT');
  // NULL = личный чат пользователя с ботом; группа компании — явная ссылка.
  await ensureColumn(db, 'topics', 'destination_id', 'INTEGER REFERENCES alert_destinations(id) ON DELETE SET NULL');
  // До какого момента посты подписки уже разобраны — двигается только при успешной проверке
  // (last_run_at — любая попытка, по нему считается расписание).
  await ensureColumn(db, 'topics', 'checked_until', 'INTEGER');
  // Когда отчёт ушёл в очередь; один выпуск = одно сообщение, по ним считается дневной лимит.
  await ensureColumn(db, 'alert_reports', 'released_at', 'INTEGER');
  await ensureColumn(db, 'telegram_accounts', 'reauth_notified_at', 'INTEGER');
  await migrateAlertSettingsToTopics(db);
  // Единственное место, где определено «канал реально мониторится»: включён
  // сам канал И (он без группы ИЛИ его группа включена). Все выборки постов
  // и списки каналов для опроса идут через этот view, а не повторяют условие.
  await db.execute(`CREATE VIEW IF NOT EXISTS monitored_channels AS
    SELECT uc.* FROM user_channels uc
    LEFT JOIN channel_groups g ON g.id = uc.group_id
    WHERE uc.is_active = 1 AND (uc.group_id IS NULL OR g.is_active = 1)`);

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
  await ensureColumn(db, 'users', 'username', 'TEXT');
  await ensureColumn(db, 'users', 'password_hash', 'TEXT');
  await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');
}

/**
 * Раньше настройки алертов были одни на пользователя (alert_settings), теперь
 * у каждой подписки (строки topics) свои: разово копирует настройки
 * пользователя в каждую его тему и удаляет старую таблицу — повторно не
 * срабатывает. Старый общий выключатель складывается с вкл/выкл темы (то,
 * что было выключено, не начинает внезапно приходить); дайджест «раз в день
 * в ЧЧ:ММ» становится «раз в 24 часа». Остальные поля совпадают по именам,
 * лишнее отбросит sanitizeTopicSettings при чтении.
 */
export async function migrateAlertSettingsToTopics(db: Client): Promise<void> {
  const legacy = await db.execute(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'alert_settings'`);
  if (legacy.rows.length === 0) return;
  await db.batch(
    [
      `UPDATE topics SET
         is_active = is_active AND COALESCE(
           (SELECT json_extract(a.settings_json, '$.enabled') FROM alert_settings a WHERE a.user_id = topics.user_id), 0),
         settings_json = (
           SELECT json_set(a.settings_json, '$.digestHours',
                           CASE json_extract(a.settings_json, '$.mode') WHEN 'digest' THEN 24 ELSE 0 END)
           FROM alert_settings a WHERE a.user_id = topics.user_id)
       WHERE settings_json IS NULL`,
      'DROP TABLE alert_settings',
    ],
    'write'
  );
}

/** Идемпотентный ADD COLUMN: SQLite не умеет `ADD COLUMN IF NOT EXISTS`. */
async function ensureColumn(db: Client, table: string, column: string, definition: string): Promise<void> {
  const info = await db.execute(`PRAGMA table_info(${table})`);
  const exists = (info.rows as unknown as { name: string }[]).some((row) => row.name === column);
  if (!exists) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function closeDb() {
  if (!dbPromise) return;
  const pending = dbPromise;
  dbPromise = null;
  pending.then((client) => client.close()).catch(() => {});
}
