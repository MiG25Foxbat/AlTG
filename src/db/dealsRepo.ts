import { getDb } from './database';

/**
 * Халява: типы, настройки пользователя, источники и акции (docs/freebies/CONTRACT.md).
 * Все времена - unix-секунды. Остальные модули импортируют типы отсюда.
 */

export const STORES = ['goldapple', 'wildberries', 'ozon', 'letual', 'iledebeaute', 'podrygka', '4lapy', 'other'] as const;
export type StoreCode = (typeof STORES)[number];

export const CATEGORIES = ['beauty', 'fashion', 'pets', 'contests', 'other'] as const;
export type CategoryCode = (typeof CATEGORIES)[number];

export const STORE_LABELS: Record<StoreCode, string> = {
  goldapple: 'Золотое яблоко',
  wildberries: 'Wildberries',
  ozon: 'Ozon',
  letual: 'Летуаль',
  iledebeaute: 'Иль де Ботэ',
  podrygka: 'Подружка',
  '4lapy': 'Четыре лапы',
  other: 'Другие магазины',
};
export const CATEGORY_LABELS: Record<CategoryCode, string> = {
  beauty: 'Красота',
  fashion: 'Мода',
  pets: 'Зоотовары',
  contests: 'Конкурсы и призы',
  other: 'Другое',
};

export type SourceKind = 'rss' | 'html' | 'json' | 'telegram';

/** Считается от publishedAt: живая, могла закончиться (срока нет и прошло больше 15 минут), срок вышел. */
export type DealStatus = 'live' | 'maybe_over' | 'expired';
export const DEAL_FRESH_SEC = 15 * 60;
/** Отключённый по ошибкам источник пробуется заново раз в сутки. */
export const DISABLED_RETRY_SEC = 24 * 3600;

/**
 * Источник, где акция живёт днями (официальные страницы магазинов), а не минутами (Telegram).
 * ponytail: эвристика по префиксу ключа; поле в deal_sources, если появятся быстрые 'web-' источники.
 */
export const isSlowSource = (key: string | undefined): boolean => !!key?.startsWith('web-');

const DAY = 86400;
/** Акции старше этого срока по found_at удаляются вместе с доставками. */
export const DEAL_KEEP_SEC = 7 * DAY;

export interface Source {
  id: number;
  key: string;
  kind: SourceKind;
  title: string;
  url: string;
  siteUrl: string;
  intervalSec: number;
  isActive: boolean;
  failCount: number;
  disabledReason: string | null;
  etag: string | null;
  lastModified: string | null;
  nextCheckAt: number;
  lastCheckedAt: number | null;
  lastOkAt: number | null;
}

export interface Deal {
  id: number;
  sourceId: number;
  sourceTitle: string;
  sourceUrl: string;
  sourceKey: string;
  store: StoreCode;
  category: CategoryCode;
  title: string;
  url: string;
  promoCode: string | null;
  discountPercent: number | null;
  discountText: string | null;
  expiresAt: number | null;
  publishedAt: number;
  foundAt: number;
  status: DealStatus;
}

export interface FreebiesSettings {
  profile: 'news' | 'freebies' | 'both' | null;
  alertsEnabled: boolean;
  stores: StoreCode[];
  categories: CategoryCode[];
  onlyWithPromo: boolean;
  minDiscount: number;
  breakQuiet: boolean;
  quietEnabled: boolean;
  quietFrom: string;
  quietTo: string;
  maxPerDay: number;
}

export const DEFAULT_FREEBIES_SETTINGS: FreebiesSettings = {
  profile: null,
  alertsEnabled: false,
  stores: [],
  categories: [],
  onlyWithPromo: false,
  minDiscount: 0,
  breakQuiet: false,
  quietEnabled: true,
  quietFrom: '23:00',
  quietTo: '08:00',
  maxPerDay: 30,
};

export interface FeedItem {
  kind: 'post' | 'deal';
  id: string;
  at: number;
  title: string;
  text: string;
  link: string;
  sourceLabel: string;
  deal?: Deal;
}

// --- Настройки ---

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function pickCodes<T extends string>(value: unknown, allowed: readonly T[], fallback: T[]): T[] {
  return Array.isArray(value) ? allowed.filter((code) => value.includes(code)) : fallback;
}

/**
 * Граница доверия: из запроса и БД берём только известные поля с допустимыми значениями.
 * Неверное или пропущенное значение заменяется значением из base (по умолчанию - дефолты;
 * при PATCH - текущие настройки пользователя, чтобы мусор не сбрасывал их).
 */
export function sanitizeFreebiesSettings(input: unknown, base: FreebiesSettings = DEFAULT_FREEBIES_SETTINGS): FreebiesSettings {
  const src: any = input && typeof input === 'object' ? input : {};
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const time = (v: unknown, fallback: string) => (typeof v === 'string' && TIME_RE.test(v) ? v : fallback);
  return {
    profile:
      src.profile === 'news' || src.profile === 'freebies' || src.profile === 'both' || src.profile === null
        ? src.profile
        : base.profile,
    alertsEnabled: bool(src.alertsEnabled, base.alertsEnabled),
    stores: pickCodes(src.stores, STORES, base.stores),
    categories: pickCodes(src.categories, CATEGORIES, base.categories),
    onlyWithPromo: bool(src.onlyWithPromo, base.onlyWithPromo),
    minDiscount: clampInt(src.minDiscount, 0, 90, base.minDiscount),
    breakQuiet: bool(src.breakQuiet, base.breakQuiet),
    quietEnabled: bool(src.quietEnabled, base.quietEnabled),
    quietFrom: time(src.quietFrom, base.quietFrom),
    quietTo: time(src.quietTo, base.quietTo),
    maxPerDay: clampInt(src.maxPerDay, 1, 100, base.maxPerDay),
  };
}

export function parseSettings(json: string | null | undefined): FreebiesSettings {
  try {
    return sanitizeFreebiesSettings(json ? JSON.parse(json) : null);
  } catch {
    return sanitizeFreebiesSettings(null);
  }
}

export async function getFreebiesSettings(userId: number): Promise<FreebiesSettings> {
  const db = await getDb();
  const r = await db.execute({ sql: 'SELECT settings_json FROM freebies_settings WHERE user_id = ?', args: [userId] });
  return parseSettings((r.rows[0] as any)?.settings_json);
}

/** Часть полей поверх текущих; всё проходит sanitize. */
export async function updateFreebiesSettings(userId: number, patch: unknown, now: number): Promise<FreebiesSettings> {
  const current = await getFreebiesSettings(userId);
  const part = patch && typeof patch === 'object' ? patch : {};
  const next = sanitizeFreebiesSettings(part, current);
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO freebies_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
    args: [userId, JSON.stringify(next), now],
  });
  return next;
}

// --- Акции ---

/** slow - медленный источник: без срока акция остаётся живой (isSlowSource). */
export function dealStatus(publishedAt: number, expiresAt: number | null, now: number, slow = false): DealStatus {
  if (expiresAt !== null) return expiresAt <= now ? 'expired' : 'live';
  return !slow && now - publishedAt > DEAL_FRESH_SEC ? 'maybe_over' : 'live';
}

/** Текст без HTML и лишних пробелов, по умолчанию как заголовок: не длиннее 200 символов. */
export function cleanTitle(title: string, max = 200): string {
  return String(title).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Только http и https; query и #-часть в ключе дубля не участвуют. */
function parseHttpUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Магазин + промокод в верхнем регистре; без промокода магазин + адрес без query и # + 60 символов заголовка. */
export function dedupKey(store: StoreCode, promoCode: string | null, url: string, title: string): string {
  if (promoCode) return `${store}|${promoCode.toUpperCase()}`;
  const u = parseHttpUrl(url);
  if (u) {
    u.search = '';
    u.hash = '';
  }
  return `${store}|${u ? u.toString() : url}|${cleanTitle(title).toLowerCase().slice(0, 60)}`;
}

export interface NewDeal {
  sourceId: number;
  store: StoreCode;
  category: CategoryCode;
  title: string;
  url: string;
  promoCode: string | null;
  discountPercent: number | null;
  discountText: string | null;
  expiresAt: number | null;
  /** null - источник молчит, берём время находки */
  publishedAt: number | null;
  /** Найдено при первой успешной проверке источника: сохранить, но не рассылать */
  muted: boolean;
}

const PROMO_RE = /^[\p{L}\p{N}_-]{3,32}$/u;

/** INSERT OR IGNORE. Возвращает id новой акции, null - дубль или запись не прошла проверку. */
export async function saveDeal(deal: NewDeal, now: number): Promise<number | null> {
  const title = cleanTitle(deal.title);
  const url = parseHttpUrl(deal.url);
  if (!title || !url || !(STORES as readonly string[]).includes(deal.store) || !(CATEGORIES as readonly string[]).includes(deal.category)) {
    return null;
  }
  const promo = deal.promoCode && PROMO_RE.test(deal.promoCode.trim()) ? deal.promoCode.trim() : null;
  const percent = deal.discountPercent !== null && deal.discountPercent >= 1 && deal.discountPercent <= 99 ? Math.round(deal.discountPercent) : null;
  const db = await getDb();
  const r = await db.execute({
    sql: `INSERT OR IGNORE INTO deals (source_id, dedup_key, store, category, title, url, promo_code, discount_percent,
                                       discount_text, expires_at, published_at, found_at, muted)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      deal.sourceId,
      dedupKey(deal.store, promo, url.toString(), title),
      deal.store,
      deal.category,
      title,
      url.toString(),
      promo,
      percent,
      cleanTitle(deal.discountText ?? '', 100) || null,
      deal.expiresAt,
      deal.publishedAt ?? now,
      now,
      deal.muted ? 1 : 0,
    ],
  });
  return r.rowsAffected === 1 ? Number(r.lastInsertRowid) : null;
}

/** Какие из ключей уже есть в базе - нейросеть спрашиваем только про остальные. */
export async function existingDedupKeys(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const db = await getDb();
  const r = await db.execute({
    sql: `SELECT dedup_key FROM deals WHERE dedup_key IN (${keys.map(() => '?').join(',')})`,
    args: keys,
  });
  return new Set((r.rows as any[]).map((row) => row.dedup_key as string));
}

export const DEAL_SELECT = `SELECT d.id, d.source_id, s.title AS source_title, s.site_url, s.key AS source_key, d.store, d.category, d.title, d.url,
       d.promo_code, d.discount_percent, d.discount_text, d.expires_at, d.published_at, d.found_at, d.muted
  FROM deals d JOIN deal_sources s ON s.id = d.source_id`;

export function dealFromRow(r: any, now: number): Deal {
  return {
    id: r.id,
    sourceId: r.source_id,
    sourceTitle: r.source_title,
    sourceUrl: r.site_url,
    sourceKey: r.source_key,
    store: r.store,
    category: r.category,
    title: r.title,
    url: r.url,
    promoCode: r.promo_code,
    discountPercent: r.discount_percent,
    discountText: r.discount_text,
    expiresAt: r.expires_at,
    publishedAt: r.published_at,
    foundAt: r.found_at,
    status: dealStatus(r.published_at, r.expires_at, now, isSlowSource(r.source_key)),
  };
}

/** Акции, найденные не раньше since (в том числе без рассылки), новые сверху. Пустой фильтр - все. */
export async function listRecentDeals(
  since: number,
  filter: { stores?: StoreCode[]; categories?: CategoryCode[] },
  limit: number,
  now: number
): Promise<Deal[]> {
  const where = ['d.found_at >= ?'];
  const args: (string | number)[] = [since];
  for (const [column, codes] of [['d.store', filter.stores], ['d.category', filter.categories]] as const) {
    if (codes && codes.length > 0) {
      where.push(`${column} IN (${codes.map(() => '?').join(',')})`);
      args.push(...codes);
    }
  }
  const db = await getDb();
  const r = await db.execute({
    sql: `${DEAL_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.found_at DESC, d.id DESC LIMIT ?`,
    args: [...args, Math.max(1, Math.min(100, Math.floor(limit)))],
  });
  return (r.rows as any[]).map((row) => dealFromRow(row, now));
}

/** Старьё: акции старше 7 дней по found_at; доставки уходят каскадом. */
export async function cleanupDeals(now: number): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: 'DELETE FROM deals WHERE found_at < ?', args: [now - DEAL_KEEP_SEC] });
}

// --- Источники ---

export interface SourceDef {
  key: string;
  kind: SourceKind;
  title: string;
  url: string;
  siteUrl: string;
  intervalSec: number;
}

/** Вписывает список источников из кода по key; состояние опроса не сбрасывается. */
export async function upsertSources(defs: SourceDef[]): Promise<void> {
  if (defs.length === 0) return;
  const db = await getDb();
  await db.batch(
    defs.map((d) => ({
      sql: `INSERT INTO deal_sources (key, kind, title, url, site_url, interval_sec) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, title = excluded.title, url = excluded.url,
              site_url = excluded.site_url, interval_sec = excluded.interval_sec`,
      args: [d.key, d.kind, d.title, d.url, d.siteUrl, Math.max(60, d.intervalSec)],
    })),
    'write'
  );
}

export function sourceFromRow(r: any): Source {
  return {
    id: r.id,
    key: r.key,
    kind: r.kind,
    title: r.title,
    url: r.url,
    siteUrl: r.site_url,
    intervalSec: r.interval_sec,
    isActive: r.is_active === 1,
    failCount: r.fail_count,
    disabledReason: r.disabled_reason,
    etag: r.etag,
    lastModified: r.last_modified,
    nextCheckAt: r.next_check_at,
    lastCheckedAt: r.last_checked_at,
    lastOkAt: r.last_ok_at,
  };
}

export async function listSources(): Promise<Source[]> {
  const db = await getDb();
  const r = await db.execute('SELECT * FROM deal_sources ORDER BY id');
  return (r.rows as any[]).map(sourceFromRow);
}

/** Источники, которым пора на проверку, самые давние первыми: активные и отключённые по ошибкам (раз в сутки проба). */
export async function listDueSources(now: number): Promise<Source[]> {
  const db = await getDb();
  const r = await db.execute({
    sql: "SELECT * FROM deal_sources WHERE (is_active = 1 OR disabled_reason = 'errors') AND next_check_at <= ? ORDER BY next_check_at, id",
    args: [now],
  });
  return (r.rows as any[]).map(sourceFromRow);
}

/** Успешная проверка (в том числе 304 и пустой разбор): сбрасывает ошибки, ставит last_ok_at, включает источник обратно. */
export async function markSourceOk(
  id: number,
  now: number,
  nextCheckAt: number,
  etag: string | null,
  lastModified: string | null
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE deal_sources SET fail_count = 0, is_active = 1, disabled_reason = NULL, last_ok_at = ?, last_checked_at = ?, next_check_at = ?,
            etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified) WHERE id = ?`,
    args: [now, now, nextCheckAt, etag, lastModified, id],
  });
}

/** Неудачная проверка; на maxFails подряд источник отключается сам (следующая проба через сутки). Возвращает true, если отключён. */
export async function markSourceFailed(id: number, now: number, nextCheckAt: number, maxFails: number): Promise<boolean> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE deal_sources SET fail_count = fail_count + 1, last_checked_at = ?,
            next_check_at = CASE WHEN fail_count + 1 >= ? THEN ? ELSE ? END,
            is_active = CASE WHEN fail_count + 1 >= ? THEN 0 ELSE is_active END,
            disabled_reason = CASE WHEN fail_count + 1 >= ? THEN 'errors' ELSE disabled_reason END WHERE id = ?`,
    args: [now, maxFails, now + DISABLED_RETRY_SEC, nextCheckAt, maxFails, maxFails, id],
  });
  const r = await db.execute({ sql: 'SELECT is_active FROM deal_sources WHERE id = ?', args: [id] });
  return (r.rows[0] as any)?.is_active === 0;
}

/** Отложить проверку, не засчитывая неудачу (повтор через 5/30 с, 429). */
export async function deferSource(id: number, now: number, nextCheckAt: number): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: 'UPDATE deal_sources SET last_checked_at = ?, next_check_at = ? WHERE id = ?', args: [now, nextCheckAt, id] });
}

export async function disableSource(id: number, reason: 'robots' | 'errors', now: number): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE deal_sources SET is_active = 0, disabled_reason = ?, last_checked_at = ? WHERE id = ?',
    args: [reason, now, id],
  });
}

/** Акции по id (для выпуска придержанных). */
export async function getDealsByIds(ids: number[], now: number): Promise<Deal[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const r = await db.execute({ sql: `${DEAL_SELECT} WHERE d.id IN (${ids.map(() => '?').join(',')})`, args: ids });
  return (r.rows as any[]).map((row) => dealFromRow(row, now));
}
