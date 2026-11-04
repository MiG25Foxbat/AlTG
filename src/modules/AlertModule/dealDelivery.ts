import {
  Deal,
  DEAL_SELECT,
  FreebiesSettings,
  dealFromRow,
  getDealsByIds,
  parseSettings,
} from '../../db/dealsRepo';
import { getDb } from '../../db/database';
import { enqueueStatements } from '../../db/outboxRepo';
import { logger } from '../../utils/logger';
import { holdUntil, mskDayStart } from './holdPolicy';
import { buildDealMessage } from './dealMessage';

/**
 * Как акция доходит до человека (docs/freebies/CONTRACT.md, п. 4): отбор, задержка существующей holdUntil(),
 * один db.batch на очередь и строку deal_deliveries, выпуск придержанных. Отправляет processOutbox, не мы.
 * Время - unix-секунды, передаётся параметром.
 */

/** Рассылается только свежее: опубликовано не раньше часа назад. */
export const DELIVER_WINDOW_SEC = 3600;

/** Одно правило «устарела» для рассылки и сухого прогона: срок вышел или от публикации больше часа. */
export function isStaleForDelivery(deal: Pick<Deal, 'publishedAt' | 'expiresAt'>, now: number): boolean {
  return (deal.expiresAt !== null && deal.expiresAt <= now) || deal.publishedAt < now - DELIVER_WINDOW_SEC;
}

/** Магазины, категории, «только с промокодом» и минимальная скидка из настроек. */
export function matchesSettings(deal: Deal, s: FreebiesSettings): boolean {
  if (s.stores.length > 0 && !s.stores.includes(deal.store)) return false;
  if (s.categories.length > 0 && !s.categories.includes(deal.category)) return false;
  if (s.onlyWithPromo && deal.promoCode === null) return false;
  return s.minDiscount === 0 || (deal.discountPercent !== null && deal.discountPercent >= s.minDiscount);
}

export interface Recipient {
  userId: number;
  destinationId: number;
  pausedUntil: number | null;
  settings: FreebiesSettings;
}

/** Получатели: активная личка с ботом; settings - как есть (alertsEnabled решает вызывающий). */
async function loadRecipient(where: string, args: (string | number)[]): Promise<Recipient[]> {
  const db = await getDb();
  const r = await db.execute({
    sql: `SELECT d.id AS destinationId, d.user_id AS userId, d.paused_until AS pausedUntil, f.settings_json
          FROM alert_destinations d LEFT JOIN freebies_settings f ON f.user_id = d.user_id
          WHERE d.kind = 'telegram_private' AND d.status = 'active' ${where}`,
    args,
  });
  return (r.rows as any[]).map((row) => ({
    userId: row.userId,
    destinationId: row.destinationId,
    pausedUntil: row.pausedUntil,
    settings: parseSettings(row.settings_json),
  }));
}

/** Сколько акций пользователю уже ушло в очередь сегодня (сутки по Москве) - от этого дневной лимит. */
async function releasedToday(userId: number, now: number): Promise<number> {
  const db = await getDb();
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM deal_deliveries WHERE user_id = ? AND status = 'queued' AND queued_at >= ?`,
    args: [userId, mskDayStart(now)],
  });
  return Number((r.rows[0] as any).n);
}

/** Когда можно отправить: <= now - сразу. Пауза бота действует всегда, тихие часы пробиваются при breakQuiet. */
export function holdFor(s: FreebiesSettings, pausedUntil: number | null, now: number, released: number): number {
  return holdUntil({
    now,
    loud: false,
    settings: { quietEnabled: s.quietEnabled && !s.breakQuiet, quietFrom: s.quietFrom, quietTo: s.quietTo, digestHours: 0, maxPerDay: s.maxPerDay },
    pausedUntil,
    firstHeldAt: now,
    releasedToday: released,
  });
}

/** Свежие, не заглушённые (muted = 0) акции, старые первыми: так порядок в чате совпадает с порядком выхода. */
async function listDeliverable(now: number): Promise<Deal[]> {
  const db = await getDb();
  const r = await db.execute({
    sql: `${DEAL_SELECT} WHERE d.published_at >= ? AND d.muted = 0 ORDER BY d.published_at, d.id`,
    args: [now - DELIVER_WINDOW_SEC],
  });
  return (r.rows as any[]).map((row) => dealFromRow(row, now)).filter((d) => !isStaleForDelivery(d, now));
}

async function sentDealIds(userId: number): Promise<Set<number>> {
  const db = await getDb();
  const r = await db.execute({ sql: 'SELECT deal_id FROM deal_deliveries WHERE user_id = ?', args: [userId] });
  return new Set((r.rows as any[]).map((row) => row.deal_id as number));
}

/** Акция уходит в очередь: одним batch сообщение в outbox и строка 'queued' (или апдейт held -> queued). */
async function queueDeal(rec: Recipient, deal: Deal, now: number, fromHeld: boolean): Promise<void> {
  const db = await getDb();
  const mark = fromHeld
    ? { sql: `UPDATE deal_deliveries SET status = 'queued', queued_at = ? WHERE user_id = ? AND deal_id = ? AND status = 'held'`, args: [now, rec.userId, deal.id] }
    : { sql: `INSERT INTO deal_deliveries (user_id, deal_id, status, created_at, queued_at) VALUES (?, ?, 'queued', ?, ?)`, args: [rec.userId, deal.id, now, now] };
  await db.batch([...enqueueStatements(rec.destinationId, [buildDealMessage(deal, now)], false, now), mark], 'write');
}

async function holdDeal(rec: Recipient, deal: Deal, until: number, now: number): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO deal_deliveries (user_id, deal_id, status, hold_until, created_at) VALUES (?, ?, 'held', ?, ?)`,
    args: [rec.userId, deal.id, until, now],
  });
}

let running = false;

/**
 * Один проход: новые акции -> получателям (сразу или придержать), потом выпуск придержанных.
 * Запуски не пересекаются: пока идёт один, второй пропускается (дойдёт минутный тик). Ошибка на одной
 * паре пользователь-акция пишется в лог, остальные идут дальше. Простой INSERT без OR IGNORE: если
 * строка уже есть, весь batch падает и в очередь ничего не уходит.
 */
export async function deliverDeals(now: number): Promise<void> {
  if (running) return;
  running = true;
  try {
    const deals = await listDeliverable(now);
    const recipients = (await loadRecipient('', [])).filter((r) => r.settings.alertsEnabled);
    for (const rec of recipients) {
      const sent = deals.length > 0 ? await sentDealIds(rec.userId) : new Set<number>();
      let released = await releasedToday(rec.userId, now);
      for (const deal of deals) {
        if (sent.has(deal.id) || !matchesSettings(deal, rec.settings)) continue;
        try {
          const until = holdFor(rec.settings, rec.pausedUntil, now, released);
          if (until <= now) {
            await queueDeal(rec, deal, now, false);
            released++;
          } else {
            await holdDeal(rec, deal, until, now);
          }
        } catch (error) {
          logger.error(`Халява: акция ${deal.id} пользователю ${rec.userId} не поставлена`, error);
        }
      }
    }
    await releaseHeld(now);
  } finally {
    running = false;
  }
}

/** Придержанные: пересчитать задержку; устарела или больше не подходит - skipped, пора - в очередь. */
async function releaseHeld(now: number): Promise<void> {
  const db = await getDb();
  const held = (await db.execute(`SELECT user_id, deal_id FROM deal_deliveries WHERE status = 'held' ORDER BY created_at, deal_id`)).rows as any[];
  if (held.length === 0) return;
  const deals = new Map((await getDealsByIds([...new Set(held.map((h) => h.deal_id as number))], now)).map((d) => [d.id, d]));
  const recipients = new Map<number, Recipient | null>();
  const releasedByUser = new Map<number, number>();
  for (const h of held) {
    try {
      const deal = deals.get(h.deal_id);
      if (!recipients.has(h.user_id)) recipients.set(h.user_id, (await loadRecipient('AND d.user_id = ?', [h.user_id]))[0] ?? null);
      const rec = recipients.get(h.user_id);
      if (!releasedByUser.has(h.user_id)) releasedByUser.set(h.user_id, await releasedToday(h.user_id, now));
      const skip = !deal || !rec || !rec.settings.alertsEnabled || isStaleForDelivery(deal, now) || !matchesSettings(deal, rec.settings);
      if (skip) {
        await db.execute({ sql: `UPDATE deal_deliveries SET status = 'skipped' WHERE user_id = ? AND deal_id = ? AND status = 'held'`, args: [h.user_id, h.deal_id] });
        continue;
      }
      const until = holdFor(rec.settings, rec.pausedUntil, now, releasedByUser.get(h.user_id)!);
      if (until <= now) {
        await queueDeal(rec, deal, now, true);
        releasedByUser.set(h.user_id, releasedByUser.get(h.user_id)! + 1);
      } else {
        await db.execute({ sql: `UPDATE deal_deliveries SET hold_until = ? WHERE user_id = ? AND deal_id = ? AND status = 'held'`, args: [until, h.user_id, h.deal_id] });
      }
    } catch (error) {
      logger.error(`Халява: придержанная акция ${h.deal_id} пользователя ${h.user_id} не выпущена`, error);
    }
  }
}

export interface DealPreview {
  deal: Deal;
  wouldSend: boolean;
  reason: 'ok' | 'held' | 'filtered' | 'expired' | 'already_sent' | 'muted';
  holdUntil: number | null;
  message: string | null;
}

export interface PreviewResult {
  results: DealPreview[];
  alertsEnabled: boolean;
  botLinked: boolean;
}

/**
 * Сухой прогон: те же отбор и задержка, что у deliverDeals, но так, будто алерты включены и бот привязан.
 * Ничего не пишет. Акции за последние minutes минут (по времени находки), новые сверху.
 */
export async function previewDeals(userId: number, settings: FreebiesSettings, minutes: number, now: number): Promise<PreviewResult> {
  const db = await getDb();
  const rec = (await loadRecipient('AND d.user_id = ?', [userId]))[0] ?? null;
  const rows = (
    await db.execute({ sql: `${DEAL_SELECT} WHERE d.found_at >= ? ORDER BY d.published_at, d.id`, args: [now - minutes * 60] })
  ).rows as any[];
  const sent = await sentDealIds(userId);
  let released = await releasedToday(userId, now);
  const results: DealPreview[] = rows.map((row) => {
    const deal = dealFromRow(row, now);
    const base = { deal, wouldSend: false, holdUntil: null, message: null };
    if (row.muted === 1) return { ...base, reason: 'muted' as const };
    if (sent.has(deal.id)) return { ...base, reason: 'already_sent' as const };
    if (isStaleForDelivery(deal, now)) return { ...base, reason: 'expired' as const };
    if (!matchesSettings(deal, settings)) return { ...base, reason: 'filtered' as const };
    const until = holdFor(settings, rec?.pausedUntil ?? null, now, released);
    const message = buildDealMessage(deal, now).text;
    if (until <= now) {
      released++;
      return { ...base, wouldSend: true, reason: 'ok' as const, message };
    }
    return { ...base, reason: 'held' as const, holdUntil: until, message };
  });
  return { results: results.reverse(), alertsEnabled: settings.alertsEnabled, botLinked: rec !== null };
}
