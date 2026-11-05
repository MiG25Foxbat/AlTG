# Халява: контракт команды

Источник истины для интерфейсов и владельцев файлов. Составлен главной сессией по коду ветки `freebies/1-sources-and-feed` (5 ноября 2026). Код и этот файл расходятся, прав код, расхождение пишется лиду. Менять контракт может только главная сессия, по просьбе владельца.

Время везде unix-секунды. Тексты для людей по-русски. Всё новое пишется по лестнице Ponytail из CLAUDE.md.

Связь в команде: у помощников нет SendMessage, есть только итоговый отчёт лиду. Поэтому «написать владельцу» значит написать это в отчёте лиду строкой «для <имя>: ...», лид передаёт. Лид запускает помощника снова своим сообщением.

## 1. Типы

Живут в `src/db/dealsRepo.ts` (владелец freebies-backend). Остальные импортируют оттуда, свои копии не заводят.

```ts
/** Магазины. Первый заход: goldapple и wildberries, остальное попадает в other. */
export const STORES = ['goldapple', 'wildberries', 'ozon', 'other'] as const;
export type StoreCode = (typeof STORES)[number];

export const CATEGORIES = ['beauty', 'fashion', 'pets', 'other'] as const;
export type CategoryCode = (typeof CATEGORIES)[number];

/** Подписи для интерфейса и бота. */
export const STORE_LABELS: Record<StoreCode, string> = {
  goldapple: 'Золотое яблоко', wildberries: 'Wildberries', ozon: 'Ozon', other: 'Другие магазины',
};
export const CATEGORY_LABELS: Record<CategoryCode, string> = {
  beauty: 'Красота', fashion: 'Мода', pets: 'Зоотовары', other: 'Другое',
};

export type SourceKind = 'rss' | 'html' | 'json' | 'telegram';

/** Считается от publishedAt. Живая: срок не вышел и (срок известен или прошло меньше 15 минут). Могла закончиться: срока нет и прошло больше 15 минут. */
export type DealStatus = 'live' | 'maybe_over' | 'expired';
export const DEAL_FRESH_SEC = 15 * 60;

export interface Source {
  id: number;
  /** Стабильный код из кода, по нему раннер находит разборщик: 'pepper', 'tg-goldapple' */
  key: string;
  kind: SourceKind;
  /** Для людей: «Pepper.ru» */
  title: string;
  /** Что опрашиваем: лента, страница, канал */
  url: string;
  /** Главная страница источника, ссылка «откуда пришло» */
  siteUrl: string;
  /** Свой интервал опроса, не меньше 60 */
  intervalSec: number;
  isActive: boolean;
  /** Неудачных проверок подряд; на 5 источник отключается сам */
  failCount: number;
  /** 'robots' | 'errors' | 'manual' | null */
  disabledReason: string | null;
  etag: string | null;
  lastModified: string | null;
  /** Следующая проверка с разбросом */
  nextCheckAt: number;
  lastCheckedAt: number | null;
  lastOkAt: number | null;
}

/** То, что отдаёт API и получает шаблон сообщения. */
export interface Deal {
  id: number;
  sourceId: number;
  sourceTitle: string;
  /** Главная страница источника, для подписи «откуда» */
  sourceUrl: string;
  store: StoreCode;
  category: CategoryCode;
  /** Без HTML, не длиннее 200 символов */
  title: string;
  /** Только http или https, проверяется при записи */
  url: string;
  promoCode: string | null;
  /** 1..99, если скидка в процентах */
  discountPercent: number | null;
  /** Как в источнике: «-30%», «500 ₽ на первый заказ» */
  discountText: string | null;
  expiresAt: number | null;
  /** Когда вышла в источнике; источник молчит, тогда время находки */
  publishedAt: number;
  foundAt: number;
  /** Считается при чтении, в базе не хранится */
  status: DealStatus;
}

export interface FreebiesSettings {
  /** Что показывать: null значит ещё не выбирал, интерфейс показывает выбор при первом входе */
  profile: 'news' | 'freebies' | 'both' | null;
  /** Слать акции в бота. По умолчанию false */
  alertsEnabled: boolean;
  /** Пусто значит все */
  stores: StoreCode[];
  categories: CategoryCode[];
  onlyWithPromo: boolean;
  /** 0 значит любая скидка, иначе не меньше, 0..90 */
  minDiscount: number;
  /** Халява пробивает тихие часы. По умолчанию false */
  breakQuiet: boolean;
  quietEnabled: boolean;
  quietFrom: string; // 'ЧЧ:ММ' МСК
  quietTo: string;
  /** 1..100 */
  maxPerDay: number;
}

export const DEFAULT_FREEBIES_SETTINGS: FreebiesSettings = {
  profile: null, alertsEnabled: false, stores: [], categories: [], onlyWithPromo: false,
  minDiscount: 0, breakQuiet: false, quietEnabled: true, quietFrom: '23:00', quietTo: '08:00', maxPerDay: 30,
};

/** Граница доверия, как sanitizeTopicSettings: на входе API и при чтении из базы. */
export function sanitizeFreebiesSettings(input: unknown): FreebiesSettings;

/** Карточка общей ленты: одна форма для поста канала и акции. */
export interface FeedItem {
  kind: 'post' | 'deal';
  /** 'post:<канал>:<messageId>' | 'deal:<id>' */
  id: string;
  /** Время поста или появления акции */
  at: number;
  /** Канал или магазин */
  title: string;
  /** Не длиннее 500 символов */
  text: string;
  /** t.me/... или страница акции */
  link: string;
  /** Откуда пришло: «@channel» или «Pepper.ru» */
  sourceLabel: string;
  /** Только для kind = 'deal' */
  deal?: Deal;
}
```

Сырые записи разборщика (внутри FreebiesModule, интерфейс для тестов):

```ts
export interface RawDeal {
  title: string;
  text: string;
  url: string;
  publishedAt: number | null;
}
/** Чистая функция, тестируется на сохранённых примерах из src/tests/fixtures/freebies/. */
export interface SourceAdapter {
  key: string;
  parse(body: string, contentType: string): RawDeal[];
}
```

## 2. Таблицы

Добавляются в `initDb()` в `src/db/database.ts` отдельным `db.batch([...], 'write')` из `CREATE TABLE IF NOT EXISTS` и `CREATE INDEX IF NOT EXISTS`, новые колонки потом только через `ensureColumn`. Так же идемпотентно, как остальная схема.

```sql
CREATE TABLE IF NOT EXISTS deal_sources (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  key              TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,
  url              TEXT NOT NULL,
  site_url         TEXT NOT NULL,
  interval_sec     INTEGER NOT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  fail_count       INTEGER NOT NULL DEFAULT 0,
  disabled_reason  TEXT,
  etag             TEXT,
  last_modified    TEXT,
  next_check_at    INTEGER NOT NULL DEFAULT 0,
  last_checked_at  INTEGER,
  last_ok_at       INTEGER
);

-- Защита от дублей: dedup_key UNIQUE, вставка INSERT OR IGNORE.
-- dedup_key = магазин + '|' + ПРОМОКОД в верхнем регистре; без промокода
-- магазин + '|' + адрес без query и # + '|' + первые 60 символов заголовка в нижнем регистре без лишних пробелов.
-- Одна акция с промокодом из двух источников одна запись, первым источником.
-- muted = 1: сохранена без рассылки. Так помечается всё, что найдено при первой
-- успешной проверке источника (last_ok_at IS NULL), иначе вся лента источника разошлась бы разом.
CREATE TABLE IF NOT EXISTS deals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id         INTEGER NOT NULL REFERENCES deal_sources(id) ON DELETE CASCADE,
  dedup_key         TEXT NOT NULL UNIQUE,
  store             TEXT NOT NULL,
  category          TEXT NOT NULL,
  title             TEXT NOT NULL,
  url               TEXT NOT NULL,
  promo_code        TEXT,
  discount_percent  INTEGER,
  discount_text     TEXT,
  expires_at        INTEGER,
  published_at      INTEGER NOT NULL,
  found_at          INTEGER NOT NULL,
  muted             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deals_found ON deals(found_at);

-- Одна строка на пользователя. Нет строки = DEFAULT_FREEBIES_SETTINGS.
CREATE TABLE IF NOT EXISTS freebies_settings (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_json  TEXT NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Отправленные и придержанные алерты по акциям. PK = одна акция одному пользователю один раз.
-- status: 'queued' ушло в outbox, 'held' ждёт hold_until, 'skipped' устарела, пока ждала.
CREATE TABLE IF NOT EXISTS deal_deliveries (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deal_id     INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  hold_until  INTEGER,
  created_at  INTEGER NOT NULL,
  queued_at   INTEGER,
  PRIMARY KEY (user_id, deal_id)
);
CREATE INDEX IF NOT EXISTS idx_deal_deliveries_held ON deal_deliveries(status, hold_until);
```

Срок жизни: акции старше 7 дней по `found_at` удаляются вместе с доставками (уборка раз в тик, как `cleanupAlertData`). Разбор не сохраняет записи с `publishedAt` старше суток. `RawDeal.publishedAt = null` значит `published_at = found_at`. ponytail: акция без даты, которая висит в источнике дольше 7 дней, после уборки вставится заново и может уйти повторно; понадобится, хранить `last_seen_at` и убирать по нему. Список источников лежит в коде FreebiesModule и при старте вписывается в `deal_sources` по `key`, состояние опроса при этом не сбрасывается.

Данные людей не сохраняются: ни авторы, ни ники, ни комментарии, ни личные голоса. В `deals` таких колонок нет, `RawDeal.text` в базу не пишется.

## 3. API для интерфейса

Все адреса за `requireAuth` в `src/app.ts`, ошибки `{ error: string }` с 400, 401 как у остальных. Ответы JSON.

| Метод | Адрес | Запрос | Ответ |
|---|---|---|---|
| GET | `/api/feed` | `?kind=all\|channels\|freebies&limit=50` (limit 1..100) | `{ items: FeedItem[] }` за сутки, новые сверху |
| GET | `/api/freebies/deals` | `?store=<код>&category=<код>&limit=50` (limit 1..100) | `{ deals: Deal[] }` за сутки, новые сверху |
| GET | `/api/freebies/settings` | | `{ settings: FreebiesSettings, stores: {code,label}[], categories: {code,label}[] }` |
| PATCH | `/api/freebies/settings` | часть полей `FreebiesSettings` | `{ settings: FreebiesSettings }` после sanitize |
| POST | `/api/freebies/preview` | `{ minutes?: 15..1440 }`, по умолчанию 60 | `{ results: DealPreview[], alertsEnabled: boolean, botLinked: boolean }` |
| GET | `/api/freebies/sources` | | `{ sources: {key,title,siteUrl,kind,isActive,disabledReason,lastOkAt}[], llmCalls: number }` |

```ts
export interface DealPreview {
  deal: Deal;
  wouldSend: boolean;
  /** Считается так, будто алерты включены и бот привязан; что это не так, видно из alertsEnabled и botLinked в ответе.
   *  ok: ушла бы сейчас; held: придержали бы до holdUntil; filtered: не по настройкам;
   *  expired: устарела для рассылки (срок вышел или published_at старше часа, одинаково в доставке и здесь);
   *  already_sent: уже уходила; muted: найдена при первом опросе источника, без рассылки */
  reason: 'ok' | 'held' | 'filtered' | 'expired' | 'already_sent' | 'muted';
  holdUntil: number | null;
  /** Готовый HTML сообщения, если wouldSend или held */
  message: string | null;
}
```

Правила ленты:
- `kind=channels` это уже сохранённые посты отслеживаемых каналов пользователя за сутки через `loadUnifiedPosts()`. Лента в Telegram не ходит.
- `kind=freebies` это акции за сутки по магазинам и категориям из настроек пользователя.
- `kind=all` это оба списка, склеенные по `at`.
- `/api/freebies/deals` фильтрует по параметрам запроса, без параметров отдаёт все магазины.
- Привязан ли бот, интерфейс берёт из существующего `GET /api/alerts/bot`.

## 4. Как акция доходит до человека

Существующие `outboxRepo`, `holdPolicy`, `notifier`, `sender`, `scheduler` не правятся. Новый код только в своих файлах.

1. Раннер `src/modules/FreebiesModule` под замком одного экземпляра. В `server.ts` рядом со `startWorker` стартует `startFreebiesWorker(deps)`, возвращает `stop()`. Тик раз в 15 секунд берёт источники, у которых `next_check_at <= now`.
2. Запрос к источнику (`kind` = rss, html, json): свой интервал плюс разброс ±20%. `If-None-Match` и `If-Modified-Since`, 304 считается успехом без разбора. Перед первым запросом к хосту каждого адреса читается и кэшируется на сутки `robots.txt`: запрет значит источник отключён с `disabled_reason = 'robots'`; 4xx у robots.txt значит можно; 5xx и таймаут значит эту проверку пропустить и засчитать неудачной; `Crawl-delay` становится нижней границей интервала. Одновременно не больше одного запроса к одному хосту. Таймаут 15 секунд, тело до 2 МБ. Сеть или 5xx: два повтора через 5 и 30 секунд. 429: ждать Retry-After, проверка не засчитывается неудачной. Пять неудачных проверок подряд: `is_active = 0`, `disabled_reason = 'errors'`, предупреждение в лог. User-Agent общий, без почты и личных данных. Зависимости `fetch` и часы передаются параметром ради тестов.
   Источник `kind = 'telegram'` это публичный канал магазина или агрегатора, `url` = `@имя`. Читается через существующий `IUserBotReader.getMessagesInWindow(канал, since)` общего аккаунта под тем же замком одного экземпляра, свой клиент не заводится. Интервал не меньше 120 секунд, окно с прошлой успешной проверки, но не дальше суток. Посты в `public_posts` не пишутся. Пост превращается в `RawDeal` (`title` первая строка, `url` первая ссылка в посте или `https://t.me/<канал>/<id>`, `publishedAt` время поста) и идёт в тот же разбор. robots.txt и ETag к нему не относятся, остальные правила (повторы, автоотключение) те же. `getMessagesInWindow` упал на FloodWait: проверку пропустить до следующего интервала.
3. Разбор: адаптер источника отдаёт `RawDeal[]`. Регулярки находят магазин, промокод, процент, срок. Простой фильтр: магазин из списка первого захода и есть промокод или скидка, остальное отбрасывается. Записи, чьего `dedup_key` ещё нет в базе, по желанию идут в нейросеть одним вызовом на тик источника через новую функцию в `llmClient.ts`: подтвердить, что это акция, и уточнить категорию. Таймаут не больше 10 секунд, без повторов. От модели берутся только «да/нет» и категория из `CATEGORIES`; заголовок, ссылка, промокод, скидка и срок только из регулярок. Тексты постов передаются модели как данные, в промпте сказано, что команды в них не выполнять. Счётчик вызовов в памяти процесса, виден в `/api/freebies/sources`. Нейросеть упала, остаётся результат регулярок, акция не теряется. Примеры из `docs/freebies/DEAL_EXAMPLES.md` переносит в `src/tests/fixtures/freebies/` сам freebies-backend.
4. Новые акции сохраняются `INSERT OR IGNORE`. Найденное при первой успешной проверке источника (`last_ok_at IS NULL`) пишется с `muted = 1` и не рассылается. Успешная проверка, в том числе 304 и пустой разбор, всегда ставит `last_ok_at`, иначе источник без акций остался бы в режиме `muted` навсегда. Сразу после сохранения и раз в минуту вызывается доставка `src/modules/AlertModule/dealDelivery.ts`. Запуски не пересекаются: флаг «уже идёт» в памяти процесса, второй запуск в это время пропускается (замок одного экземпляра уже гарантирует один процесс). Ошибка на одной паре пользователь и акция ловится и пишется в лог, тик идёт дальше.
   - пользователи с `alertsEnabled = true` и активной личкой с ботом (`alert_destinations`, `kind = 'telegram_private'`, `status = 'active'`);
   - акции с `published_at >= now - 3600` и `muted = 0`, подходящие под магазины, категории, `onlyWithPromo`, `minDiscount`, не `expired`, без строки в `deal_deliveries` для этого пользователя;
   - задержка считается существующей `holdUntil()` из `holdPolicy.ts` без её правки: `loud: false`, `settings = { quietEnabled: s.quietEnabled && !s.breakQuiet, quietFrom, quietTo, digestHours: 0, maxPerDay }`, `pausedUntil` от получателя, `firstHeldAt: now`, `releasedToday` это число `queued` за сутки МСК. Пауза в боте действует всегда, тихие часы пробиваются только при `breakQuiet`;
   - задержки нет: одним `db.batch` `enqueueStatements(destinationId, [buildDealMessage(deal, now)], false, now)` из `outboxRepo.ts` плюс `INSERT INTO deal_deliveries ... 'queued'`. Простой `INSERT` без `OR IGNORE`: если строка уже есть, весь batch падает и в очередь ничего не уходит, повтора нет;
   - задержка есть: строка `held` с `hold_until`. Выпуск раз в минуту пересчитывает задержку, устаревшую акцию (срок вышел, или срока нет и от `published_at` прошло больше часа) переводит в `skipped`, иначе ставит в очередь тем же batch и переводит в `queued`. Ночью халява без срока почти вся станет `skipped`: акции живут минуты. Интерфейс подписывает это у тихих часов: «ночью халява не копится, утром придёт только то, у чего срок ещё не вышел».
   - тесты обязательны: «первый опрос источника не шлёт», «одна акция одному пользователю один раз», «два запуска доставки подряд не дают дубля в outbox», «тихие часы держат, breakQuiet пробивает, пауза держит всегда».
5. Отправляет существующий `processOutbox` через `TelegramNotifier`, ничего нового. Звук включён: `disable_notification = false`.
6. Сухой прогон `POST /api/freebies/preview` идёт по тем же функциям отбора и задержки, ничего не пишет и не ставит в очередь.

Шаблон сообщения: `src/modules/AlertModule/dealMessage.ts` (владелец freebies-ui):

```ts
import { OutgoingPart } from './messageFormat';
import { Deal } from '../../db/dealsRepo';
/** Короткое HTML-сообщение не длиннее 4096: магазин и скидка, заголовок, промокод отдельной строкой в <code>,
 *  срок или «N мин назад», источник. Кнопка «Открыть» (url = deal.url). escapeHtml из messageFormat. */
export function buildDealMessage(deal: Deal, now: number): OutgoingPart;
```

Бот: `src/modules/BotModule/dealBot.ts` (владелец freebies-ui) по образцу `botActions.ts` без grammY, тестируется на in-memory базе. Команда `/freebies`, кнопки с `callback_data` на префиксе `fr:`, не длиннее 64 байт. Меняет настройки только через `getFreebiesSettings`/`updateFreebiesSettings` из `dealsRepo.ts`. Подключение в `bot.ts` делает тоже freebies-ui: `bot.command('freebies', ...)`, обработчик `bot.callbackQuery(/^fr:/, ...)` до общего `bot.on('callback_query:data')` и без `next()`, строка в `setMyCommands`.

Запуск в `server.ts`: `startFreebiesWorker` только после взятия замка, рядом со `startWorker`, его `stop()` в `shutdown`.

Функции `dealsRepo.ts`, на которые опираются интерфейс и бот:

```ts
export async function getFreebiesSettings(userId: number): Promise<FreebiesSettings>;
export async function updateFreebiesSettings(userId: number, patch: unknown, now: number): Promise<FreebiesSettings>;
export async function listRecentDeals(since: number, filter: { stores?: StoreCode[]; categories?: CategoryCode[] }, limit: number, now: number): Promise<Deal[]>;
```

## 5. Ownership

У каждого файла один владелец. Чужое не править, писать владельцу по имени. Все остальные файлы репозитория только читаются. Нужна правка в файле без владельца, писать лиду, лид назначит владельца и впишет сюда.

| Владелец | Файлы |
|---|---|
| главная сессия (team-lead) | `docs/freebies/CONTRACT.md`, `docs/freebies/STATUS.md`, `docs/freebies/mock-deals.json`, `docs/freebies/HANDOFF.md`, `docs/freebies/LAUNCH.md`, `CLAUDE.md`, `README.md`, `.gitignore`, `.claude/` |
| freebies-scout | `docs/freebies/SOURCES.md`, `docs/freebies/DEAL_EXAMPLES.md`, папка `.firecrawl/` |
| freebies-backend | папка `src/modules/FreebiesModule/`, `src/db/dealsRepo.ts`, `src/modules/AlertModule/dealDelivery.ts`, `src/modules/AiModule/llmClient.ts` (только новая функция для акций, старое не трогать), `src/tests/freebies*.test.ts`, папка `src/tests/fixtures/freebies/`, `src/freebiesDemo.ts` (демо-сервер: in-memory база, фейковый Telegram, без бота и без опроса, акции из примеров, только localhost; запуск `npm run demo:freebies`), общие `package.json`, `src/db/database.ts`, `src/app.ts`, `src/server.ts` |
| freebies-ui | папка `public/` целиком, `src/modules/AlertModule/dealMessage.ts`, `src/modules/BotModule/dealBot.ts`, `src/modules/BotModule/bot.ts` (только подключение `/freebies` и `fr:`), `src/tests/dealMessage.test.ts`, `src/tests/dealBot.test.ts` |
| freebies-reviewer | `docs/freebies/REVIEW.md` |

Пересечения:
- Тесты freebies-ui лежат вне маски `freebies*.test.ts`, поэтому у них один владелец. В `scripts.test` их дописывает freebies-backend по просьбе freebies-ui.
- `dealMessage.ts` и `dealBot.ts` импортируют типы и функции из `dealsRepo.ts`, поэтому freebies-backend делает `dealsRepo.ts` первым. До этого freebies-ui работает над `public/` на примерах.
- `dealDelivery.ts` импортирует `buildDealMessage` из файла freebies-ui. Сигнатура выше. freebies-ui делает шаблон сразу, как появится `dealsRepo.ts`; доставку freebies-backend делает последней.
- Коммитит лид по именам файлов, не `git add -A`: папка `data/` не коммитится.
- Для работы на примерах freebies-ui копирует нужное из `docs/freebies/mock-deals.json` в свой файл в `public/`, сам `mock-deals.json` не правит.
- Нужен новый адрес API, поле или функция в `dealsRepo.ts`, писать freebies-backend.

## 6. Примеры данных

`docs/freebies/mock-deals.json`: ответы `GET /api/freebies/deals`, `GET /api/feed?kind=all` и `GET /api/freebies/settings` в формате выше. Промокоды и ссылки в нём выдуманы, это не настоящие акции. Теперь это только документация формы ответов: `public/` его не использует, интерфейс работает на настоящих адресах.
