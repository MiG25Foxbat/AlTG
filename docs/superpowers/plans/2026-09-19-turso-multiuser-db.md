# Переход на Turso + teleproto: многопользовательская схема БД

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести БД прототипа с однопользовательского `node:sqlite` на честно многопользовательскую схему поверх `@libsql/client` (Turso/libSQL) с зашифрованными `session_string`/`phone_number`, перенести существующие данные из старых `channels`/`posts` в новые таблицы, и заменить архивированную зависимость `telegram` на её поддерживаемый форк `teleproto`.

**Architecture:** Сначала изолированные, независимо проверяемые куски (замена `telegram`→`teleproto`; модуль шифрования) — они не зависят от БД и де-рискуются первыми. Затем замена движка БД (`node:sqlite`→`@libsql/client`) и новая 6-таблочная схема — это меняет весь слой БД с синхронного на асинхронный, поэтому репозитории (`channelsRepo`, `postsRepo`) переписываются с добавлением `userId`-скоупинга. Затем — «мост» к многопользовательской модели без экрана логина: при старте сервера создаётся единственный `users`-row, к нему привязывается текущий Telegram-аккаунт из `.env` (через реальный `client.getMe()`, не заглушка), и старые `channels`/`posts` переносятся в новые таблицы. Наконец — перемонтировать `app.ts`/сервисы на новые асинхронные репозитории и обновить документацию. HTTP-контракт и фронтенд (`public/`) не меняются; экран логина/переключение аккаунтов сознательно не добавляются в этом заходе (подтверждено с пользователем).

**Tech Stack:** TypeScript, Node.js ≥22.13, Express 5, `@libsql/client` (Turso/libSQL), `teleproto` (форк GramJS), `node:crypto` (AES-256-GCM), `node:test`.

**Spec:** `docs/tech-stack-final.md` (разделы 3 и 5 — источник схемы, шифрования и рационале миграции teleproto). Общий контекст — `docs/project-context.md`, текущее состояние — корневой `CLAUDE.md`.

## Global Constraints

- Node.js ≥22.13, TypeScript, `ts-node` в dev, `tsc`→`dist/` в проде — без изменений.
- БД — `@libsql/client`, `url`: `file:${DB_PATH}` (dev/test, `DB_PATH` по умолчанию `./data/app.db`, `:memory:` в тестах передаётся как есть) или `TURSO_DATABASE_URL`+`TURSO_AUTH_TOKEN` (прод, когда появится реальная Turso-база) — переключение окружением, без раздвоения кода.
- `telegram` (GramJS) заменяется на `teleproto` — тот же публичный API, тот же формат session string; импорты `from "telegram"` (и подпути `/sessions`, `/tl`) → `from "teleproto"`.
- `session_string` и `phone_number` — только в зашифрованном виде: AES-256-GCM через `node:crypto`, формат `iv:authTag:ciphertext` (все части в base64), ключ — 32-байтный секрет в `SESSION_ENCRYPTION_KEY` (переменная окружения, никогда в БД/git).
- `SESSION_STRING`, `GEMINI_API_KEY`, `SESSION_ENCRYPTION_KEY` никогда не попадают в коммиты, документы или вывод команд в чат/лог — при диагностике маскировать значения.
- Тесты запускаются явным списком файлов в `package.json` → `scripts.test` (без discovery) — каждый новый тестовый файл обязательно дописывается туда.
- HTTP-контракт `app.ts` (пути, форма JSON-ответов) и фронтенд `public/` не меняются — только то, что происходит под капотом.
- Не добавлять экран логина/переключение аккаунтов/UI для второго Telegram-аккаунта — подтверждённое решение на этот заход.

---

## Предварительная проверка (сделана при подготовке плана — не переделывать)

- `teleproto` существует на npm (актуальная версия `1.229.0`), `npm view telegram deprecated` подтверждает архивацию и рекомендацию перехода именно на `teleproto` — ровно как в `docs/tech-stack-final.md`.
- `@libsql/client` не требует нативной сборки на Windows — бинарники (`@libsql/win32-x64-msvc` и др.) идут прекомпилированными как `optionalDependencies` пакета `libsql`, грабля как с `better-sqlite3` не повторится.
- **Риск, не описанный в спеке явно:** `node:sqlite` (`DatabaseSync`) — синхронный API, `@libsql/client` — полностью асинхронный (`Promise`-based). Это значит, что переход — не только смена схемы, а обязательный async-рефакторинг всего слоя БД и всех его вызывающих (`app.ts`, `fetchService.ts`, `analyzeService.ts`, `server.ts`). План это учитывает (Задачи 5, 6, 8).
- **Второй риск, тоже не описанный в спеке:** local-file режим `@libsql/client` держит пул до 20 соединений по умолчанию (не одно, как `node:sqlite`/`better-sqlite3`). `PRAGMA foreign_keys = ON`, выполненная через `execute()`, применяется только к тому соединению, на котором была выполнена — на пуле >1 это не гарантирует `ON DELETE CASCADE` на каждом запросе. Решение — `concurrency: 1` в конфиге клиента (Задача 3): одно соединение убирает риск целиком, а для нагрузки этого прототипа (один локальный процесс) это не бутылочное горлышко.
- Реальные данные для проверки миграции уже есть: в текущей `data/app.db` — 3 канала (`@markettwits`, `@selfinvestor`, `@cbonds`) и 3 поста. Задача 9 включает прогон миграции на копии этого файла.
- Подтверждено с пользователем: (1) в этом заходе — только БД, без экрана логина, один пользователь создаётся автоматически из текущего `.env`; (2) Turso-аккаунт создать не могу (создание аккаунта на внешнем сервисе) — работаем через локальный файл, прод-переключение на реальную Turso — когда пользователь сам создаст базу.

---

### Task 1: Замена зависимости `telegram` → `teleproto`

**Files:**
- Modify: `package.json`
- Modify: `src/modules/UserBotModule/UserBot.ts:1-3`
- Modify: `src/modules/UserBotModule/interfaces/IUserBot.ts:1`
- Modify: `src/generateSession.ts:1-2`

**Interfaces:**
- Consumes: ничего нового.
- Produces: `TelegramClient`, `StringSession`, `Api` теперь импортируются из `teleproto` — эти три имени использует Задача 7 (`bootstrap.ts` импортирует тип `TelegramClient` из `teleproto`).

- [ ] **Step 1: Зафиксировать зелёный baseline перед изменениями**

Run: `npm test`
Expected: все 28 тестов проходят (это база для сравнения после замены зависимости).

- [ ] **Step 2: Заменить зависимость в package.json**

```bash
npm uninstall telegram
npm install teleproto
```

- [ ] **Step 3: Заменить импорты в трёх файлах**

`src/modules/UserBotModule/UserBot.ts`, было:
```ts
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
```
стало:
```ts
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { Api } from 'teleproto/tl';
```

`src/modules/UserBotModule/interfaces/IUserBot.ts`, было:
```ts
import { TelegramClient } from 'telegram';
```
стало:
```ts
import { TelegramClient } from 'teleproto';
```

`src/generateSession.ts`, было:
```ts
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
```
стало:
```ts
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
```

- [ ] **Step 4: Проверить типы и живые вызовы `sendReadAcknowledge`**

Run: `npx tsc --noEmit`
Expected: без ошибок. Если новый TL-layer ужесточит типы — поправить точечно на месте ошибки.

Run: `grep -rn "sendReadAcknowledge" src/`
Expected: пусто (уже проверено при подготовке плана — метод нигде не вызывается вживую, только в закомментированном блоке реакций/комментариев в `UserBot.ts`). Закомментированный код не трогать без отдельного запроса — он не компилируется и не исполняется.

- [ ] **Step 5: Прогнать тесты**

Run: `npm test`
Expected: те же 28/28 зелёных — `teleproto` заявлен обратно совместимым, реальных вызовов Telegram в тестах нет (используется `IUserBotReader`-фейк).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/modules/UserBotModule/UserBot.ts src/modules/UserBotModule/interfaces/IUserBot.ts src/generateSession.ts
git commit -m "chore: заменить архивированный telegram (GramJS) на teleproto"
```

---

### Task 2: Модуль шифрования (`src/utils/crypto.ts`)

**Files:**
- Create: `src/utils/crypto.ts`
- Create: `src/tests/crypto.test.ts`
- Modify: `package.json` (добавить файл в `scripts.test`)

**Interfaces:**
- Consumes: `process.env.SESSION_ENCRYPTION_KEY` (base64, 32 байта).
- Produces: `encrypt(plaintext: string): string`, `decrypt(payload: string): string` — используются в Задаче 4 (`telegramAccountsRepo.ts`).

- [ ] **Step 1: Написать падающий тест**

Создать `src/tests/crypto.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { encrypt, decrypt } from '../utils/crypto';

test('encrypt/decrypt: round-trip возвращает исходную строку', () => {
  const original = '1BQANOTEuMTA4LjU2LjE7NTk3MDpFQzY4QzMzMD_example_session_string';
  const payload = encrypt(original);
  assert.notEqual(payload, original);
  assert.equal(decrypt(payload), original);
});

test('encrypt: формат — три base64-части через двоеточие (iv:authTag:ciphertext)', () => {
  const payload = encrypt('test-value');
  const parts = payload.split(':');
  assert.equal(parts.length, 3);
  for (const part of parts) {
    assert.doesNotThrow(() => Buffer.from(part, 'base64'));
  }
});

test('decrypt: испорченный ciphertext бросает ошибку, а не возвращает мусор', () => {
  const payload = encrypt('secret-value');
  const [iv, authTag] = payload.split(':');
  const tampered = `${iv}:${authTag}:${Buffer.from('garbage-data').toString('base64')}`;
  assert.throws(() => decrypt(tampered));
});

test('decrypt: неверный ключ бросает ошибку вместо молчаливо неверного результата', () => {
  const payload = encrypt('secret-value');
  process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  assert.throws(() => decrypt(payload));
});

test('encrypt: без SESSION_ENCRYPTION_KEY бросает понятную ошибку', () => {
  const saved = process.env.SESSION_ENCRYPTION_KEY;
  delete process.env.SESSION_ENCRYPTION_KEY;
  assert.throws(() => encrypt('x'), /SESSION_ENCRYPTION_KEY/);
  process.env.SESSION_ENCRYPTION_KEY = saved;
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `node --require ts-node/register --test src/tests/crypto.test.ts`
Expected: FAIL — `Cannot find module '../utils/crypto'`.

- [ ] **Step 3: Реализовать `src/utils/crypto.ts`**

```ts
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // рекомендованная длина IV для GCM

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
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `node --require ts-node/register --test src/tests/crypto.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Добавить файл в `package.json` → `scripts.test`**

```json
"test": "node --require ts-node/register --test src/tests/keywordFilter.test.ts src/tests/time.test.ts src/tests/windowMessages.test.ts src/tests/api.test.ts src/tests/crypto.test.ts"
```

- [ ] **Step 6: Commit**

```bash
git add src/utils/crypto.ts src/tests/crypto.test.ts package.json
git commit -m "feat: модуль шифрования AES-256-GCM для чувствительных полей"
```

---

### Task 3: Движок БД — `@libsql/client` и новая схема (`database.ts`)

**Files:**
- Modify: `src/db/database.ts`
- Create: `src/tests/database.test.ts`
- Modify: `package.json` (зависимость + `scripts.test`)

**Interfaces:**
- Consumes: ничего из предыдущих задач.
- Produces: `getDb(): Promise<Client>` (тип `Client` из `@libsql/client`), `closeDb(): void`. Используется во всех последующих задачах (4–8) — везде, где раньше был синхронный `getDb(): DatabaseSync`, теперь `await getDb()`.

- [ ] **Step 1: Установить зависимость**

```bash
npm install @libsql/client
```

- [ ] **Step 2: Написать падающий тест схемы**

Создать `src/tests/database.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import { getDb, closeDb } from '../db/database';

test('getDb: создаёt все таблицы новой многопользовательской схемы', async () => {
  const db = await getDb();
  const result = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
  );
  const names = result.rows.map((row) => (row as unknown as { name: string }).name);
  for (const expected of [
    'activity_log',
    'private_posts',
    'public_posts',
    'telegram_accounts',
    'topics',
    'user_channels',
    'users',
  ]) {
    assert.ok(names.includes(expected), `таблица ${expected} должна существовать`);
  }
  closeDb();
});

test('getDb: возвращает один и тот же singleton-клиент при повторном вызове', async () => {
  const db1 = await getDb();
  const db2 = await getDb();
  assert.equal(db1, db2);
  closeDb();
});
```

- [ ] **Step 3: Запустить тест и убедиться, что он падает**

Run: `node --require ts-node/register --test src/tests/database.test.ts`
Expected: FAIL — старая схема не содержит `users`/`telegram_accounts`/и т.д.

- [ ] **Step 4: Переписать `src/db/database.ts`**

```ts
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
```

Примечание: старые таблицы `channels`/`posts` здесь больше не создаются и не трогаются — их перенос и удаление отдельно делает `migrateLegacyData()` (Задача 7), чтобы schema-инициализация и одноразовая миграция данных не были смешаны в одной функции.

- [ ] **Step 5: Запустить тест и убедиться, что он проходит**

Run: `node --require ts-node/register --test src/tests/database.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 6: Добавить файл в `package.json` → `scripts.test`**

```json
"test": "node --require ts-node/register --test src/tests/keywordFilter.test.ts src/tests/time.test.ts src/tests/windowMessages.test.ts src/tests/api.test.ts src/tests/crypto.test.ts src/tests/database.test.ts"
```

(`src/tests/api.test.ts` на этом шаге ещё падает — чинится в Задаче 8, это ожидаемо и не блокирует коммит текущей задачи.)

- [ ] **Step 7: Commit**

```bash
git add src/db/database.ts src/tests/database.test.ts package.json package-lock.json
git commit -m "feat: движок БД node:sqlite -> @libsql/client, новая многопользовательская схема"
```

---

### Task 4: `usersRepo.ts` и `telegramAccountsRepo.ts`

**Files:**
- Create: `src/db/usersRepo.ts`
- Create: `src/db/telegramAccountsRepo.ts`
- Create: `src/tests/accounts.test.ts`
- Modify: `package.json` (`scripts.test`)

**Interfaces:**
- Consumes: `getDb()` (Задача 3), `encrypt`/`decrypt` (Задача 2).
- Produces: `getOrCreateSoleUser(): Promise<number>`; `hasAccount(userId: number): Promise<boolean>`, `upsertAccount(userId: number, account: { telegramUserId: number; phoneNumber: string; sessionString: string }): Promise<void>`, `getDecryptedAccount(userId: number): Promise<DecryptedAccount | undefined>` где `DecryptedAccount = { telegramUserId: number; phoneNumber: string; sessionString: string }`. Используются в Задаче 7 (`bootstrap.ts`) и Задаче 8 (`app.ts`).

- [ ] **Step 1: Написать падающий тест**

Создать `src/tests/accounts.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.DB_PATH = ':memory:';
process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { closeDb } from '../db/database';
import { getOrCreateSoleUser } from '../db/usersRepo';
import { hasAccount, upsertAccount, getDecryptedAccount } from '../db/telegramAccountsRepo';

test('getOrCreateSoleUser: первый вызов создаёт пользователя, повторный возвращает того же', async () => {
  const id1 = await getOrCreateSoleUser();
  const id2 = await getOrCreateSoleUser();
  assert.equal(id1, id2);
  closeDb();
});

test('telegramAccountsRepo: upsert -> hasAccount -> getDecryptedAccount возвращает исходные значения', async () => {
  const userId = await getOrCreateSoleUser();
  assert.equal(await hasAccount(userId), false);

  await upsertAccount(userId, {
    telegramUserId: 123456789,
    phoneNumber: '79991234567',
    sessionString: 'FAKE_SESSION_STRING_VALUE',
  });

  assert.equal(await hasAccount(userId), true);

  const account = await getDecryptedAccount(userId);
  assert.deepEqual(account, {
    telegramUserId: 123456789,
    phoneNumber: '79991234567',
    sessionString: 'FAKE_SESSION_STRING_VALUE',
  });
  closeDb();
});

test('telegramAccountsRepo: повторный upsert для того же userId обновляет запись, а не дублирует', async () => {
  const userId = await getOrCreateSoleUser();
  await upsertAccount(userId, {
    telegramUserId: 111,
    phoneNumber: '111',
    sessionString: 'first',
  });
  await upsertAccount(userId, {
    telegramUserId: 222,
    phoneNumber: '222',
    sessionString: 'second',
  });
  const account = await getDecryptedAccount(userId);
  assert.equal(account?.sessionString, 'second');
  closeDb();
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `node --require ts-node/register --test src/tests/accounts.test.ts`
Expected: FAIL — модули ещё не существуют.

- [ ] **Step 3: Реализовать `src/db/usersRepo.ts`**

```ts
import { getDb } from './database';

/**
 * Прототип работает как один локальный оператор — полноценного экрана
 * входа ещё нет (см. docs/tech-stack-final.md, "Что сознательно не
 * входит в этот этап"). Эта функция — мост к многопользовательской схеме
 * без логина: если пользователей ещё нет, создаёт единственного; если
 * есть — возвращает первого (сейчас их всегда ровно один).
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
```

- [ ] **Step 4: Реализовать `src/db/telegramAccountsRepo.ts`**

```ts
import { getDb } from './database';
import { encrypt, decrypt } from '../utils/crypto';

export interface DecryptedAccount {
  telegramUserId: number;
  phoneNumber: string;
  sessionString: string;
}

/** Есть ли уже привязанный Telegram-аккаунт у этого пользователя. */
export async function hasAccount(userId: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT 1 FROM telegram_accounts WHERE user_id = ?',
    args: [userId],
  });
  return result.rows.length > 0;
}

/**
 * Сохраняет Telegram-аккаунт пользователя. session_string и phone_number
 * шифруются перед записью (docs/tech-stack-final.md, 5.4) — открытым
 * текстом в БД не попадают никогда. Один пользователь — один аккаунт
 * (UNIQUE user_id в схеме), повторный вызов обновляет запись.
 */
export async function upsertAccount(
  userId: number,
  account: { telegramUserId: number; phoneNumber: string; sessionString: string }
): Promise<void> {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: `INSERT INTO telegram_accounts
            (user_id, telegram_user_id, phone_number_encrypted, session_string_encrypted, connected_at, session_last_used_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            telegram_user_id = excluded.telegram_user_id,
            phone_number_encrypted = excluded.phone_number_encrypted,
            session_string_encrypted = excluded.session_string_encrypted,
            session_last_used_at = excluded.session_last_used_at`,
    args: [
      userId,
      account.telegramUserId,
      encrypt(account.phoneNumber),
      encrypt(account.sessionString),
      now,
      now,
    ],
  });
}

/**
 * Расшифровывает и возвращает аккаунт для одноразового использования
 * (например, создание клиента teleproto на один цикл чтения). Вызывающий
 * код не должен сохранять расшифрованные поля дольше одного вызова —
 * это по дизайну (5.5 дока), не гарантируется на уровне типов.
 */
export async function getDecryptedAccount(userId: number): Promise<DecryptedAccount | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT telegram_user_id, phone_number_encrypted, session_string_encrypted FROM telegram_accounts WHERE user_id = ?',
    args: [userId],
  });
  if (result.rows.length === 0) return undefined;
  const row = result.rows[0] as unknown as {
    telegram_user_id: number;
    phone_number_encrypted: string;
    session_string_encrypted: string;
  };
  return {
    telegramUserId: row.telegram_user_id,
    phoneNumber: decrypt(row.phone_number_encrypted),
    sessionString: decrypt(row.session_string_encrypted),
  };
}
```

- [ ] **Step 5: Запустить тест и убедиться, что он проходит**

Run: `node --require ts-node/register --test src/tests/accounts.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 6: Добавить файл в `package.json` → `scripts.test`**

```json
"test": "node --require ts-node/register --test src/tests/keywordFilter.test.ts src/tests/time.test.ts src/tests/windowMessages.test.ts src/tests/api.test.ts src/tests/crypto.test.ts src/tests/database.test.ts src/tests/accounts.test.ts"
```

- [ ] **Step 7: Commit**

```bash
git add src/db/usersRepo.ts src/db/telegramAccountsRepo.ts src/tests/accounts.test.ts package.json
git commit -m "feat: usersRepo и telegramAccountsRepo с шифрованием на границе записи/чтения"
```

---

### Task 5: `channelsRepo.ts` → `user_channels`

**Files:**
- Modify: `src/db/channelsRepo.ts`
- Create: `src/tests/channelsRepo.test.ts`
- Modify: `package.json` (`scripts.test`)

**Interfaces:**
- Consumes: `getDb()` (Задача 3), `getOrCreateSoleUser()` (Задача 4, только в тесте).
- Produces (все сигнатуры меняются — были синхронные без `userId`, стали асинхронные с `userId` первым параметром): `normalizeChannelUsername(raw: string): string` (без изменений, чистая функция), `listChannels(userId: number): Promise<ChannelDto[]>`, `listActiveChannelUsernames(userId: number): Promise<string[]>`, `getChannel(userId: number, identifier: string): Promise<ChannelDto | undefined>`, `upsertChannel(userId: number, identifier: string, title: string | null): Promise<ChannelDto>`, `setChannelActive(userId: number, identifier: string, isActive: boolean): Promise<ChannelDto | undefined>`, `removeChannel(userId: number, identifier: string): Promise<boolean>`. `ChannelDto` не меняется (`{ username, title, addedAt, isActive, isPrivate }`) — HTTP-контракт для `public/app.js` сохраняется, `isPrivate` — новое поле, безвредная добавка (фронтенд игнорирует незнакомые поля). Используются в Задаче 8 (`app.ts`, `fetchService.ts`, `analyzeService.ts`).

- [ ] **Step 1: Написать падающий тест**

Создать `src/tests/channelsRepo.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import { closeDb } from '../db/database';
import { getOrCreateSoleUser } from '../db/usersRepo';
import {
  listChannels,
  listActiveChannelUsernames,
  getChannel,
  upsertChannel,
  setChannelActive,
  removeChannel,
} from '../db/channelsRepo';

test('channelsRepo: полный цикл CRUD скопирован per-user', async () => {
  const userId = await getOrCreateSoleUser();

  assert.deepEqual(await listChannels(userId), []);

  const created = await upsertChannel(userId, '@testchan', 'Test Channel');
  assert.equal(created.username, '@testchan');
  assert.equal(created.title, 'Test Channel');
  assert.equal(created.isActive, true);
  assert.equal(created.isPrivate, false);

  assert.deepEqual(await listActiveChannelUsernames(userId), ['@testchan']);

  const fetched = await getChannel(userId, '@testchan');
  assert.equal(fetched?.title, 'Test Channel');

  const deactivated = await setChannelActive(userId, '@testchan', false);
  assert.equal(deactivated?.isActive, false);
  assert.deepEqual(await listActiveChannelUsernames(userId), []);

  const removed = await removeChannel(userId, '@testchan');
  assert.equal(removed, true);
  assert.deepEqual(await listChannels(userId), []);

  closeDb();
});

test('channelsRepo: один и тот же channel_identifier у двух разных user_id не конфликтует', async () => {
  const userA = await getOrCreateSoleUser();
  // getOrCreateSoleUser всегда возвращает один и тот же id в этом
  // прототипе — здесь вставляем второго пользователя напрямую, чтобы
  // проверить именно то, что защищает UNIQUE(user_id, channel_identifier).
  const { getDb } = await import('../db/database');
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const insertResult = await db.execute({
    sql: 'INSERT INTO users (created_at, status, last_active_at) VALUES (?, ?, ?)',
    args: [now, 'active', now],
  });
  const userB = Number(insertResult.lastInsertRowid);

  await upsertChannel(userA, '@shared', 'Shared A');
  await upsertChannel(userB, '@shared', 'Shared B');

  assert.equal((await getChannel(userA, '@shared'))?.title, 'Shared A');
  assert.equal((await getChannel(userB, '@shared'))?.title, 'Shared B');

  closeDb();
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `node --require ts-node/register --test src/tests/channelsRepo.test.ts`
Expected: FAIL — старые сигнатуры без `userId`, старая таблица `channels`.

- [ ] **Step 3: Переписать `src/db/channelsRepo.ts`**

```ts
import { getDb } from './database';

export interface ChannelRow {
  user_id: number;
  channel_identifier: string;
  channel_title: string | null;
  is_private: 0 | 1;
  is_active: 0 | 1;
  added_at: number;
}

export interface ChannelDto {
  username: string;
  title: string | null;
  addedAt: number;
  isActive: boolean;
  isPrivate: boolean;
}

function toDto(row: ChannelRow): ChannelDto {
  return {
    username: row.channel_identifier,
    title: row.channel_title,
    addedAt: row.added_at,
    isActive: row.is_active === 1,
    isPrivate: row.is_private === 1,
  };
}

/** Приводит ввод пользователя к единому формату: всегда с "@", без пробелов, без ссылки t.me/. */
export function normalizeChannelUsername(raw: string): string {
  let value = raw.trim();
  value = value.replace(/^https?:\/\/(t|telegram)\.me\//i, '');
  value = value.replace(/^@/, '');
  if (!value) {
    throw new Error('Пустое имя канала');
  }
  if (!/^[a-zA-Z0-9_]{4,64}$/.test(value)) {
    throw new Error('Похоже, это не имя публичного канала (пример: @channel_name)');
  }
  return `@${value}`;
}

export async function listChannels(userId: number): Promise<ChannelDto[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM user_channels WHERE user_id = ? ORDER BY added_at DESC',
    args: [userId],
  });
  return (result.rows as unknown as ChannelRow[]).map(toDto);
}

export async function listActiveChannelUsernames(userId: number): Promise<string[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT channel_identifier FROM user_channels WHERE user_id = ? AND is_active = 1',
    args: [userId],
  });
  return (result.rows as unknown as { channel_identifier: string }[]).map(
    (r) => r.channel_identifier
  );
}

export async function getChannel(
  userId: number,
  identifier: string
): Promise<ChannelDto | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM user_channels WHERE user_id = ? AND channel_identifier = ?',
    args: [userId, identifier],
  });
  const row = result.rows[0] as unknown as ChannelRow | undefined;
  return row ? toDto(row) : undefined;
}

export async function upsertChannel(
  userId: number,
  identifier: string,
  title: string | null
): Promise<ChannelDto> {
  const db = await getDb();
  const existing = await getChannel(userId, identifier);
  if (existing) {
    await db.execute({
      sql: 'UPDATE user_channels SET channel_title = COALESCE(?, channel_title) WHERE user_id = ? AND channel_identifier = ?',
      args: [title, userId, identifier],
    });
  } else {
    await db.execute({
      sql: 'INSERT INTO user_channels (user_id, channel_identifier, channel_title, added_at, is_active) VALUES (?, ?, ?, ?, 1)',
      args: [userId, identifier, title, Math.floor(Date.now() / 1000)],
    });
  }
  return (await getChannel(userId, identifier))!;
}

export async function setChannelActive(
  userId: number,
  identifier: string,
  isActive: boolean
): Promise<ChannelDto | undefined> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE user_channels SET is_active = ? WHERE user_id = ? AND channel_identifier = ?',
    args: [isActive ? 1 : 0, userId, identifier],
  });
  return getChannel(userId, identifier);
}

export async function removeChannel(userId: number, identifier: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'DELETE FROM user_channels WHERE user_id = ? AND channel_identifier = ?',
    args: [userId, identifier],
  });
  return result.rowsAffected > 0;
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `node --require ts-node/register --test src/tests/channelsRepo.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Добавить файл в `package.json` → `scripts.test`**

```json
"test": "node --require ts-node/register --test src/tests/keywordFilter.test.ts src/tests/time.test.ts src/tests/windowMessages.test.ts src/tests/api.test.ts src/tests/crypto.test.ts src/tests/database.test.ts src/tests/accounts.test.ts src/tests/channelsRepo.test.ts"
```

- [ ] **Step 6: Commit**

```bash
git add src/db/channelsRepo.ts src/tests/channelsRepo.test.ts package.json
git commit -m "refactor: channelsRepo на user_channels, async, per-user скоуп"
```

---

### Task 6: `postsRepo.ts` → `public_posts`

**Files:**
- Modify: `src/db/postsRepo.ts`
- Create: `src/tests/postsRepo.test.ts`
- Modify: `package.json` (`scripts.test`)

**Interfaces:**
- Consumes: `getDb()` (Задача 3), `getOrCreateSoleUser()`/`upsertChannel` (Задача 4/5, только в тесте).
- Produces: `insertPosts(posts: NewPost[]): Promise<number>` (без `userId` — общий кэш, как в спеке), `getPostsSince(userId: number, cutoffUnixSeconds: number, limit: number): Promise<PostRow[]>` (получил `userId` — фильтрация теперь через join на `user_channels`, потому что `is_active` переехал с канала в `user_channels`, а `public_posts` больше не хранит принадлежность каналу к какому-либо пользователю). Используются в Задаче 8.

- [ ] **Step 1: Написать падающий тест**

Создать `src/tests/postsRepo.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import { closeDb } from '../db/database';
import { getOrCreateSoleUser } from '../db/usersRepo';
import { upsertChannel, setChannelActive } from '../db/channelsRepo';
import { insertPosts, getPostsSince } from '../db/postsRepo';

test('postsRepo: insertPosts дедуплицирует по (channel, message_id), getPostsSince фильтрует по активным каналам пользователя', async () => {
  const userId = await getOrCreateSoleUser();
  await upsertChannel(userId, '@activechan', 'Active');
  await upsertChannel(userId, '@inactivechan', 'Inactive');
  await setChannelActive(userId, '@inactivechan', false);

  const now = Math.floor(Date.now() / 1000);
  const inserted = await insertPosts([
    { channelUsername: '@activechan', messageId: 1, text: 'первый', postedAt: now },
    { channelUsername: '@activechan', messageId: 2, text: 'второй', postedAt: now - 10 },
    { channelUsername: '@inactivechan', messageId: 1, text: 'из выключенного канала', postedAt: now },
  ]);
  assert.equal(inserted, 3);

  // повторная вставка тех же (channel, message_id) — дедуп, 0 новых строк
  const dedupInsert = await insertPosts([
    { channelUsername: '@activechan', messageId: 1, text: 'первый (повтор)', postedAt: now },
  ]);
  assert.equal(dedupInsert, 0);

  const posts = await getPostsSince(userId, now - 3600, 100);
  assert.equal(posts.length, 2); // не включает пост из @inactivechan
  assert.ok(posts.every((p) => p.channel_username === '@activechan'));
  assert.equal(posts[0].posted_at >= posts[posts.length - 1].posted_at, true); // новые первыми

  closeDb();
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `node --require ts-node/register --test src/tests/postsRepo.test.ts`
Expected: FAIL — старая таблица `posts`/`channels`, старая сигнатура `getPostsSince` без `userId`.

- [ ] **Step 3: Переписать `src/db/postsRepo.ts`**

```ts
import { getDb } from './database';

export interface PostRow {
  id: number;
  channel_username: string;
  message_id: number;
  text: string;
  posted_at: number;
  fetched_at: number;
}

export interface NewPost {
  channelUsername: string;
  messageId: number;
  text: string;
  postedAt: number;
}

/**
 * Вставляет посты пачкой в общий кэш public_posts (без userId — текст
 * одного и того же публичного поста одинаков для всех пользователей,
 * см. docs/tech-stack-final.md, раздел 5.3). Дубликаты (тот же канал +
 * message_id) тихо пропускаются благодаря UNIQUE-ограничению. batch()
 * оборачивает вставку в одну транзакцию сам — ручной BEGIN/COMMIT/
 * ROLLBACK, нужный для node:sqlite, здесь не требуется.
 */
export async function insertPosts(posts: NewPost[]): Promise<number> {
  if (posts.length === 0) return 0;
  const db = await getDb();
  const fetchedAt = Math.floor(Date.now() / 1000);

  const results = await db.batch(
    posts.map((post) => ({
      sql: `INSERT OR IGNORE INTO public_posts (channel_username, message_id, text, posted_at, fetched_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [post.channelUsername, post.messageId, post.text, post.postedAt, fetchedAt],
    })),
    'write'
  );
  return results.reduce((sum, r) => sum + r.rowsAffected, 0);
}

/**
 * Посты не старше cutoff (unix-секунды) из каналов, которые у ЭТОГО
 * пользователя активны — фильтр по активности теперь на user_channels
 * (per-user), не на public_posts (общий, без понятия "активен").
 */
export async function getPostsSince(
  userId: number,
  cutoffUnixSeconds: number,
  limit: number
): Promise<PostRow[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT public_posts.* FROM public_posts
          JOIN user_channels
            ON user_channels.channel_identifier = public_posts.channel_username
          WHERE user_channels.user_id = ?
            AND user_channels.is_active = 1
            AND public_posts.posted_at >= ?
          ORDER BY public_posts.posted_at DESC
          LIMIT ?`,
    args: [userId, cutoffUnixSeconds, limit],
  });
  return result.rows as unknown as PostRow[];
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `node --require ts-node/register --test src/tests/postsRepo.test.ts`
Expected: PASS, 1/1.

- [ ] **Step 5: Добавить файл в `package.json` → `scripts.test`**

```json
"test": "node --require ts-node/register --test src/tests/keywordFilter.test.ts src/tests/time.test.ts src/tests/windowMessages.test.ts src/tests/api.test.ts src/tests/crypto.test.ts src/tests/database.test.ts src/tests/accounts.test.ts src/tests/channelsRepo.test.ts src/tests/postsRepo.test.ts"
```

- [ ] **Step 6: Commit**

```bash
git add src/db/postsRepo.ts src/tests/postsRepo.test.ts package.json
git commit -m "refactor: postsRepo на public_posts, getPostsSince фильтрует через user_channels"
```

---

### Task 7: `bootstrap.ts` — единственный пользователь + перенос старых данных

**Files:**
- Create: `src/db/bootstrap.ts`
- Create: `src/tests/bootstrap.test.ts`
- Modify: `package.json` (`scripts.test`)

**Interfaces:**
- Consumes: `getDb()` (3), `getOrCreateSoleUser()`/`hasAccount()`/`upsertAccount()` (4), `listChannels()`/`getPostsSince()` (5, 6 — только в тесте, для проверки результата), тип `TelegramClient` из `teleproto` (1).
- Produces: `ensureDefaultUser(client: TelegramClient): Promise<number>`, `migrateLegacyData(userId: number): Promise<void>`. Используются в Задаче 8 (`server.ts`).

- [ ] **Step 1: Написать падающий тест**

Создать `src/tests/bootstrap.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.DB_PATH = ':memory:';
process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { getDb, closeDb } from '../db/database';
import { migrateLegacyData, ensureDefaultUser } from '../db/bootstrap';
import { getOrCreateSoleUser } from '../db/usersRepo';
import { getDecryptedAccount } from '../db/telegramAccountsRepo';
import { listChannels } from '../db/channelsRepo';
import { getPostsSince } from '../db/postsRepo';

test('migrateLegacyData: переносит старые channels/posts в новую схему и удаляет старые таблицы', async () => {
  const db = await getDb();
  await db.batch(
    [
      `CREATE TABLE channels (username TEXT PRIMARY KEY, title TEXT, added_at INTEGER NOT NULL, is_active INTEGER NOT NULL DEFAULT 1)`,
      `CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_username TEXT NOT NULL, message_id INTEGER NOT NULL, text TEXT NOT NULL, posted_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL, UNIQUE(channel_username, message_id))`,
      {
        sql: `INSERT INTO channels VALUES (?, ?, ?, ?)`,
        args: ['@oldchan', 'Old Channel', 1000, 1],
      },
      {
        sql: `INSERT INTO posts (channel_username, message_id, text, posted_at, fetched_at) VALUES (?, ?, ?, ?, ?)`,
        args: ['@oldchan', 1, 'привет', 2000, 2000],
      },
    ],
    'write'
  );

  const userId = await getOrCreateSoleUser();
  await migrateLegacyData(userId);

  const channels = await listChannels(userId);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].username, '@oldchan');

  const posts = await getPostsSince(userId, 0, 10);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, 'привет');

  const tables = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channels', 'posts')`
  );
  assert.equal(tables.rows.length, 0);

  await migrateLegacyData(userId); // повторный запуск — no-op, не падает и не дублирует
  assert.equal((await listChannels(userId)).length, 1);

  closeDb();
});

test('ensureDefaultUser: создаёт users+telegram_accounts из client.getMe(), повторный вызов — no-op', async () => {
  const fakeClient: any = {
    getMe: async () => ({ id: 987654321, phone: '79990001122' }),
    session: { save: () => 'FAKE_SESSION_STRING' },
  };

  const userId = await ensureDefaultUser(fakeClient);
  const account = await getDecryptedAccount(userId);
  assert.deepEqual(account, {
    telegramUserId: 987654321,
    phoneNumber: '79990001122',
    sessionString: 'FAKE_SESSION_STRING',
  });

  let calledAgain = false;
  const secondFakeClient: any = {
    getMe: async () => {
      calledAgain = true;
      return { id: 111, phone: '111' };
    },
    session: { save: () => 'SHOULD_NOT_BE_USED' },
  };
  const userIdAgain = await ensureDefaultUser(secondFakeClient);
  assert.equal(userIdAgain, userId);
  assert.equal(calledAgain, false); // аккаунт уже привязан — getMe() не должен вызываться повторно

  closeDb();
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `node --require ts-node/register --test src/tests/bootstrap.test.ts`
Expected: FAIL — `../db/bootstrap` не существует.

- [ ] **Step 3: Реализовать `src/db/bootstrap.ts`**

```ts
import type { TelegramClient } from 'teleproto';
import { getDb } from './database';
import { getOrCreateSoleUser } from './usersRepo';
import { hasAccount, upsertAccount } from './telegramAccountsRepo';
import { logger } from '../utils/logger';

/**
 * Однооператорский мост к многопользовательской схеме (см. usersRepo.ts):
 * при первом запуске создаёт единственный users-row и привязывает к нему
 * текущий Telegram-аккаунт из SESSION_STRING в .env, запросив реальные
 * phone/telegram_user_id через client.getMe() — не заглушку. При
 * повторных запусках — no-op, getMe() не вызывается снова.
 */
export async function ensureDefaultUser(client: TelegramClient): Promise<number> {
  const userId = await getOrCreateSoleUser();
  if (await hasAccount(userId)) {
    return userId;
  }

  const me: any = await client.getMe();
  const sessionString = client.session.save() as unknown as string;

  await upsertAccount(userId, {
    telegramUserId: Number(me.id.toString()),
    phoneNumber: String(me.phone || ''),
    sessionString,
  });
  logger.info(`Telegram-аккаунт привязан к пользователю #${userId} (telegram_user_id=${me.id})`);
  return userId;
}

/**
 * Одноразовый перенос старых однопользовательских таблиц channels/posts
 * в новые user_channels/public_posts. Идемпотентна: если старых таблиц
 * уже нет — ничего не делает. channels переносятся под userId (на этом
 * этапе пользователь один), posts — как есть в public_posts (общий кэш,
 * без привязки к пользователю).
 */
export async function migrateLegacyData(userId: number): Promise<void> {
  const db = await getDb();
  const legacyTables = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channels', 'posts')`
  );
  if (legacyTables.rows.length === 0) {
    return; // уже мигрировано или свежая БД — переносить нечего
  }

  const channels = await db.execute('SELECT username, title, added_at, is_active FROM channels');
  const posts = await db.execute(
    'SELECT channel_username, message_id, text, posted_at, fetched_at FROM posts'
  );

  const statements: { sql: string; args: unknown[] }[] = [];

  for (const row of channels.rows as unknown as {
    username: string;
    title: string | null;
    added_at: number;
    is_active: number;
  }[]) {
    statements.push({
      sql: `INSERT OR IGNORE INTO user_channels (user_id, channel_identifier, channel_title, is_active, added_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [userId, row.username, row.title, row.is_active, row.added_at],
    });
  }

  for (const row of posts.rows as unknown as {
    channel_username: string;
    message_id: number;
    text: string;
    posted_at: number;
    fetched_at: number;
  }[]) {
    statements.push({
      sql: `INSERT OR IGNORE INTO public_posts (channel_username, message_id, text, posted_at, fetched_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [row.channel_username, row.message_id, row.text, row.posted_at, row.fetched_at],
    });
  }

  statements.push({ sql: 'DROP TABLE posts', args: [] });
  statements.push({ sql: 'DROP TABLE channels', args: [] });

  await db.batch(statements, 'write');
  logger.info(
    `Миграция старой схемы: перенесено ${channels.rows.length} канал(ов) и ${posts.rows.length} пост(ов), старые таблицы удалены`
  );
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `node --require ts-node/register --test src/tests/bootstrap.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Добавить файл в `package.json` → `scripts.test`**

```json
"test": "node --require ts-node/register --test src/tests/keywordFilter.test.ts src/tests/time.test.ts src/tests/windowMessages.test.ts src/tests/api.test.ts src/tests/crypto.test.ts src/tests/database.test.ts src/tests/accounts.test.ts src/tests/channelsRepo.test.ts src/tests/postsRepo.test.ts src/tests/bootstrap.test.ts"
```

- [ ] **Step 6: Commit**

```bash
git add src/db/bootstrap.ts src/tests/bootstrap.test.ts package.json
git commit -m "feat: bootstrap единственного пользователя из .env + перенос старых channels/posts"
```

---

### Task 8: Подключить всё к `app.ts`/сервисам/`server.ts`, починить `api.test.ts`

**Files:**
- Modify: `src/app.ts`
- Modify: `src/modules/FetchModule/fetchService.ts`
- Modify: `src/modules/AiModule/analyzeService.ts`
- Modify: `src/server.ts`
- Modify: `src/tests/api.test.ts`

**Interfaces:**
- Consumes: всё из Задач 3–7.
- Produces: `createApp(userBot: IUserBotReader): Promise<Express>` (была синхронной — теперь `Promise`, единственное изменение сигнатуры, видимое извне модуля), `fetchRecentPosts(userBot, userId, cutoffUnixSeconds)`, `analyzeTopic(userBot, userId, topic, windowMinutes)` (обе получили `userId` вторым параметром).

- [ ] **Step 1: Обновить `src/tests/api.test.ts` под новую асинхронную `createApp`**

Изменить только функцию `startTestServer`, было:
```ts
async function startTestServer() {
  const fakeUserBot = new FakeUserBot();
  const app = createApp(fakeUserBot);
  const server = app.listen(0);
  ...
```
стало:
```ts
async function startTestServer() {
  const fakeUserBot = new FakeUserBot();
  const app = await createApp(fakeUserBot);
  const server = app.listen(0);
  ...
```
Остальной файл не меняется — весь сценарий идёт через HTTP (`fetch`), а не напрямую через репозитории, поэтому `userId`-скоуп для теста прозрачен (внутри `createApp` он резолвится через `getOrCreateSoleUser()` один раз).

- [ ] **Step 2: Запустить `api.test.ts` и убедиться, что он падает**

Run: `node --require ts-node/register --test src/tests/api.test.ts`
Expected: FAIL — `app.ts` ещё зовёт старые синхронные репозитории без `userId`.

- [ ] **Step 3: Переписать `src/app.ts`**

```ts
import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import {
  listChannels,
  upsertChannel,
  setChannelActive,
  removeChannel,
  normalizeChannelUsername,
} from './db/channelsRepo';
import { getOrCreateSoleUser } from './db/usersRepo';
import { analyzeTopic } from './modules/AiModule/analyzeService';
import { GeminiConfigError, GeminiQuotaError } from './modules/AiModule/geminiClient';
import { InvalidTimeWindowError, TIME_WINDOW_OPTIONS } from './utils/time';
import { IUserBotReader } from './modules/UserBotModule/IUserBotReader';
import { logger } from './utils/logger';

/**
 * Собирает Express-приложение без побочных эффектов (не слушает порт,
 * не трогает process.env, не подключается к Telegram сама). userId
 * резолвится один раз здесь через getOrCreateSoleUser() — прототип
 * работает как один локальный оператор без экрана логина (см.
 * docs/tech-stack-final.md), но всё под капотом уже per-user-scoped.
 */
export async function createApp(userBot: IUserBotReader) {
  const userId = await getOrCreateSoleUser();

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // --- Каналы ---

  app.get('/api/channels', async (_req, res) => {
    res.json(await listChannels(userId));
  });

  app.post('/api/channels', async (req: Request, res: Response) => {
    const raw = String(req.body?.username || '');
    let username: string;
    try {
      username = normalizeChannelUsername(raw);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }

    const existing = (await listChannels(userId)).find((c) => c.username === username);
    if (existing) {
      return res.status(409).json({ error: `Канал ${username} уже добавлен` });
    }

    const resolved = await userBot.resolveChannel(username);
    if (!resolved) {
      return res.status(404).json({
        error: `Канал ${username} не найден или недоступен для чтения (учтите: пока поддерживаются только открытые каналы)`,
      });
    }

    const channel = await upsertChannel(userId, username, resolved.title);
    res.status(201).json(channel);
  });

  app.patch('/api/channels/:username', async (req: Request, res: Response) => {
    const username = normalizeChannelUsername(String(req.params.username));
    const isActive = Boolean(req.body?.isActive);
    const updated = await setChannelActive(userId, username, isActive);
    if (!updated) {
      return res.status(404).json({ error: `Канал ${username} не найден` });
    }
    res.json(updated);
  });

  app.delete('/api/channels/:username', async (req: Request, res: Response) => {
    const username = normalizeChannelUsername(String(req.params.username));
    const removed = await removeChannel(userId, username);
    if (!removed) {
      return res.status(404).json({ error: `Канал ${username} не найден` });
    }
    res.status(204).end();
  });

  // --- Настройки для интерфейса ---

  app.get('/api/time-windows', (_req, res) => {
    res.json(TIME_WINDOW_OPTIONS);
  });

  // --- Основное действие: получить + отфильтровать + суммаризировать ---

  app.post('/api/analyze', async (req: Request, res: Response) => {
    const topic = String(req.body?.topic || '').trim();
    const windowMinutes = Number(req.body?.windowMinutes);

    if (!topic) {
      return res.status(400).json({ error: 'Введите тему запроса' });
    }
    if ((await listChannels(userId)).filter((c) => c.isActive).length === 0) {
      return res
        .status(400)
        .json({ error: 'Нет ни одного активного канала — добавьте канал во вкладке «Каналы»' });
    }

    const result = await analyzeTopic(userBot, userId, topic, windowMinutes);
    res.json(result);
  });

  // --- Обработка ошибок ---
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
```

- [ ] **Step 4: Обновить `src/modules/FetchModule/fetchService.ts`**

Изменить импорт и сигнатуру (добавить `userId` вторым параметром), было:
```ts
import { listActiveChannelUsernames } from '../../db/channelsRepo';
import { insertPosts } from '../../db/postsRepo';
...
export async function fetchRecentPosts(
  userBot: IUserBotReader,
  cutoffUnixSeconds: number
): Promise<ChannelFetchResult[]> {
  const channels = listActiveChannelUsernames();
```
стало:
```ts
import { listActiveChannelUsernames } from '../../db/channelsRepo';
import { insertPosts } from '../../db/postsRepo';
...
export async function fetchRecentPosts(
  userBot: IUserBotReader,
  userId: number,
  cutoffUnixSeconds: number
): Promise<ChannelFetchResult[]> {
  const channels = await listActiveChannelUsernames(userId);
```
И внутри цикла, было `const newCount = insertPosts(...)`, стало `const newCount = await insertPosts(...)` (сигнатура `insertPosts` не меняется — она без `userId`, см. Задачу 6).

- [ ] **Step 5: Обновить `src/modules/AiModule/analyzeService.ts`**

Было:
```ts
export async function analyzeTopic(
  userBot: IUserBotReader,
  topic: string,
  windowMinutes: number
): Promise<AnalyzeResult> {
  const startedAt = Date.now();
  const cutoff = windowMinutesToCutoff(windowMinutes);

  const fetchResults: ChannelFetchResult[] = await fetchRecentPosts(userBot, cutoff);
  ...
  const posts: PostRow[] = getPostsSince(cutoff, POSTS_FETCHED_FROM_DB_CAP);
  ...
  const channelTitles = new Map(listChannels().map((c) => [c.username, c.title]));
```
стало:
```ts
export async function analyzeTopic(
  userBot: IUserBotReader,
  userId: number,
  topic: string,
  windowMinutes: number
): Promise<AnalyzeResult> {
  const startedAt = Date.now();
  const cutoff = windowMinutesToCutoff(windowMinutes);

  const fetchResults: ChannelFetchResult[] = await fetchRecentPosts(userBot, userId, cutoff);
  ...
  const posts: PostRow[] = await getPostsSince(userId, cutoff, POSTS_FETCHED_FROM_DB_CAP);
  ...
  const channelTitles = new Map((await listChannels(userId)).map((c) => [c.username, c.title]));
```
(остальное тело функции — без изменений, только эти три места ссылались на репозитории).

- [ ] **Step 6: Обновить `src/server.ts`**

Было:
```ts
import { UserBot } from './modules/UserBotModule/UserBot';
import { createApp } from './app';
import { getDb, closeDb } from './db/database';
import { logger } from './utils/logger';
...
async function main() {
  getDb();

  const userBot = new UserBot(sessionString as string);
  await userBot.init();
  logger.info('Telegram userbot подключён');

  const app = createApp(userBot);

  const server = app.listen(PORT, () => {
```
стало:
```ts
import { UserBot } from './modules/UserBotModule/UserBot';
import { createApp } from './app';
import { getDb, closeDb } from './db/database';
import { ensureDefaultUser, migrateLegacyData } from './db/bootstrap';
import { logger } from './utils/logger';
...
async function main() {
  await getDb();

  const userBot = new UserBot(sessionString as string);
  await userBot.init();
  logger.info('Telegram userbot подключён');

  const userId = await ensureDefaultUser(userBot.client);
  await migrateLegacyData(userId);

  const app = await createApp(userBot);

  const server = app.listen(PORT, () => {
```
(`shutdown`/остальной файл — без изменений; `userBot.client` уже публичное поле в `UserBot.ts`, отдельно менять не нужно).

- [ ] **Step 7: Запустить тесты и убедиться, что всё проходит**

Run: `npm test`
Expected: все файлы из `scripts.test` зелёные (к этому моменту: `keywordFilter`, `time`, `windowMessages`, `api`, `crypto`, `database`, `accounts`, `channelsRepo`, `postsRepo`, `bootstrap` — 10 файлов).

Run: `npx tsc --noEmit`
Expected: без ошибок.

- [ ] **Step 8: Commit**

```bash
git add src/app.ts src/modules/FetchModule/fetchService.ts src/modules/AiModule/analyzeService.ts src/server.ts src/tests/api.test.ts
git commit -m "refactor: подключить app.ts/fetchService/analyzeService/server.ts к новой async БД и bootstrap"
```

---

### Task 9: Документация, `.env.example`, прогон на реальных данных

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:** нет новых — только документация и ручная проверка.

- [ ] **Step 1: Обновить `.env.example`**

Добавить в конец файла:
```
# --- Шифрование чувствительных полей в БД (обязательно) ---
# 32 байта в base64. Сгенерировать: openssl rand -base64 32
# Потеря ключа = безвозвратная потеря доступа ко всем сохранённым сессиям —
# храните бэкап отдельно (менеджер паролей и т.п.), не только в Render.
SESSION_ENCRYPTION_KEY=

# --- Turso / libSQL (необязательно) ---
# Без них используется локальный файл DB_PATH — ничего заполнять не нужно
# для разработки. Создать базу: `turso db create <name>` и токен —
# `turso db tokens create <name>` (turso CLI, https://docs.turso.tech/cli).
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
```

- [ ] **Step 2: Обновить `CLAUDE.md`**

В разделе «Стек и команды» заменить строку про БД, было:
```
- БД: **`node:sqlite`** (`DatabaseSync`), не `better-sqlite3` — сознательный
  выбор, см. раздел "Известные грабли" ниже
```
стало:
```
- БД: **`@libsql/client`** (Turso/libSQL) — многопользовательская схема
  (`users`/`telegram_accounts`/`topics`/`user_channels`/`public_posts`/
  `private_posts`/`activity_log`), подробности в `docs/tech-stack-final.md`.
  `url` — локальный файл (`DB_PATH`, по умолчанию) или `TURSO_DATABASE_URL`
  для прода; `telegram` (GramJS) заменён на `teleproto` (GramJS
  заархивирован, см. раздел "Известные грабли")
```

В разделе «Структура проекта» дописать в блок `db/`:
```
    database.ts             # getDb() — singleton @libsql/client, новая схема
    channelsRepo.ts          # CRUD user_channels + нормализация username
    postsRepo.ts               # вставка/выборка public_posts
    usersRepo.ts                 # getOrCreateSoleUser() — мост без экрана логина
    telegramAccountsRepo.ts        # CRUD telegram_accounts, шифрование на границе
    bootstrap.ts                     # ensureDefaultUser() + перенос старых channels/posts
```

В разделе «Известные грабли» — обновить пункт про GramJS (миграция сделана) и добавить новый про пул соединений:
```
- **`gram-js/gramjs` был заархивирован 14 июля 2026 года — сделано.**
  Зависимость заменена на `teleproto` (см. `docs/tech-stack-final.md`,
  раздел 3). Импорты `from "teleproto"`, формат session string тот же.
- **`@libsql/client` в local-file режиме держит пул до 20 соединений** —
  `PRAGMA foreign_keys = ON`, выполненная через `execute()`, применяется
  только к одному соединению из пула, а не ко всем. Решено передачей
  `concurrency: 1` в `createClient()` (см. `src/db/database.ts`) — один
  коннект гарантирует, что `ON DELETE CASCADE` в схеме реально работает.
  Не убирать `concurrency: 1` без замены на другой способ применить
  pragma ко всем соединениям пула.
```

В разделе «Правила безопасности с credentials» дописать `SESSION_ENCRYPTION_KEY` в общий список наравне с `SESSION_STRING`/`GEMINI_API_KEY` (та же строка "живут только в `.env`... никогда не появляются в коммитах").

- [ ] **Step 3: Обновить `README.md`**

Строки 16–19, было:
```
1. Node.js 22.13+ или 23.4+ (проверялось на 22 и 24). База — встроенный `node:sqlite`,
   отдельной установки/сборки СУБД не требует: никаких Visual Studio Build Tools
   на Windows, в отличие от `better-sqlite3`, с которого начинался этот файл
   и который на чистой Windows-машине без C++-тулчейна падает на `npm install`.
```
стало:
```
1. Node.js 22.13+ или 23.4+ (проверялось на 22 и 24). База — Turso/libSQL
   через `@libsql/client`: для разработки достаточно локального файла
   (`DB_PATH`, без сети и без затрат), для прода — переменные
   `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`. Бинарники прекомпилированы под
   все платформы (включая Windows) — как и раньше, без Visual Studio
   Build Tools.
```

Строка 32 (список переменных в блоке установки), было:
```
# открыть .env и заполнить: API_ID, API_HASH, SESSION_STRING, GEMINI_API_KEY
```
стало:
```
# открыть .env и заполнить: API_ID, API_HASH, SESSION_STRING, GEMINI_API_KEY, SESSION_ENCRYPTION_KEY
```

Строки 122–125 (структура проекта, блок `db/`), было:
```
  db/
    database.ts                   — подключение к SQLite, схема
    channelsRepo.ts                — CRUD каналов + нормализация username
    postsRepo.ts                   — вставка/выборка постов
```
стало:
```
  db/
    database.ts                   — подключение к Turso/libSQL, схема
    channelsRepo.ts                — CRUD user_channels + нормализация username
    postsRepo.ts                   — вставка/выборка public_posts
    usersRepo.ts                   — единственный пользователь-мост без логина
    telegramAccountsRepo.ts        — CRUD telegram_accounts, шифрование
    bootstrap.ts                   — привязка аккаунта + перенос старых данных
```

- [ ] **Step 4: Полный прогон тестов**

Run: `npm test`
Expected: все 10 тестовых файлов зелёные.

Run: `npx tsc --noEmit`
Expected: без ошибок.

- [ ] **Step 5: Прогон миграции на копии реальных данных**

```bash
cp data/app.db /tmp/app.db.pre-migration-backup 2>/dev/null || cp data/app.db data/app.db.backup
cp data/app.db data/app.migration-check.db
DB_PATH=./data/app.migration-check.db SESSION_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  node --require ts-node/register -e "
    require('dotenv').config();
    const { getDb, closeDb } = require('./src/db/database');
    const { getOrCreateSoleUser } = require('./src/db/usersRepo');
    const { migrateLegacyData } = require('./src/db/bootstrap');
    const { listChannels } = require('./src/db/channelsRepo');
    (async () => {
      await getDb();
      const userId = await getOrCreateSoleUser();
      await migrateLegacyData(userId);
      console.log('Каналов после миграции:', (await listChannels(userId)).length);
      closeDb();
    })();
  "
rm data/app.migration-check.db
```
Expected: «Каналов после миграции: 3» (реальные `@markettwits`, `@selfinvestor`, `@cbonds` из текущей `data/app.db`, проверено при подготовке плана). Файл `data/app.db.backup` — подстраховка, не удалять до первого успешного реального запуска `npm run dev` на новой схеме; `data/app.migration-check.db` — одноразовый, удаляется сразу после проверки.

- [ ] **Step 6: Commit**

```bash
git add .env.example CLAUDE.md README.md
git commit -m "docs: обновить README/CLAUDE.md под Turso/teleproto/шифрование"
```

---

## Что сознательно не входит в этот план

(Совпадает с `docs/tech-stack-final.md`, раздел 5.7, и подтверждено с пользователем при планировании.)

- Экран логина, magic-link реавторизация, переключение между несколькими Telegram-аккаунтами в UI — схема готова, интерфейса нет.
- Наполнение `topics` и `activity_log` реальной логикой (сохранение тем между запросами, запись событий health-мониторинга) — таблицы создаются по схеме и готовы, но `app.ts`/сервисы в них пока не пишут. Тема запроса остаётся одноразовым свободным текстом, как сейчас.
- `private_posts` реально не наполняется — чтение приватных каналов через MTProto в `UserBot`/`teleproto` не реализовано (отдельный пункт из «Что дальше» в `CLAUDE.md`).
- Реальное подключение к Turso (прод) — работаем на локальном файле; переключение — когда пользователь сам создаст базу через `turso` CLI и даст `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`.
- Текст предупреждения пользователю о риске ограничений Telegram-аккаунта — открытый вопрос самого дока (раздел 7), не спроектирован.

## Self-Review (проведено при подготовке плана)

1. **Покрытие спеки:** все 7 таблиц раздела 5.3 — Задача 3. Шифрование 5.4 — Задача 2 (алгоритм/формат) + Задача 4 (граница репозитория). Правило 5.5 (расшифровка только на время одного вызова) — `getDecryptedAccount` не кэширует, вызывающий код (Задача 7) использует результат немедленно и не сохраняет. Перенос данных 5.7 — Задача 7 (`migrateLegacyData`) + Задача 9 (прогон на реальных данных). Раздел 3 (teleproto) — Задача 1.
2. **Плейсхолдеры:** проверено — везде реальный код, реальные SQL-запросы, реальные тестовые ассерты; шагов вида "добавить обработку ошибок" без кода нет.
3. **Согласованность типов:** `ChannelDto` (Задача 5) используется без изменений в `app.ts`/`analyzeService.ts` (Задача 8); `DecryptedAccount` (Задача 4) — в `bootstrap.ts` (Задача 7); сигнатуры `fetchRecentPosts`/`analyzeTopic` с `userId` вторым параметром — согласованы между Задачей 8's `fetchService.ts`/`analyzeService.ts`/`app.ts`.
