import { Destination, markDestinationBlocked } from '../../db/destinationsRepo';
import {
  requeueStuck,
  listDueMessages,
  claimMessage,
  markSent,
  scheduleRetry,
  markFailed,
  postponeDestination,
} from '../../db/outboxRepo';
import { Notifier, SendResult } from './notifier';
import { logger } from '../../utils/logger';

/** Зависшие в sending дольше этого — обратно в pending. */
export const STUCK_AFTER_SEC = 5 * 60;
/** Паузы перед повторами обычных ошибок; повторы кончились — failed. */
export const RETRY_DELAYS_SEC = [30, 120, 600];
const BATCH = 100;

interface Rule {
  key: string;
  limit: number;
  windowMs: number;
}

/**
 * Скользящие окна в памяти процесса — достаточно, потому что отправщик
 * работает только в одном экземпляре (замок в service_locks).
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  /** Берёт слот сразу во всех правилах или ни в одном. */
  tryAcquire(rules: Rule[], nowMs: number): boolean {
    const fresh = rules.map((r) => (this.hits.get(r.key) ?? []).filter((t) => t > nowMs - r.windowMs));
    if (rules.some((r, i) => fresh[i].length >= r.limit)) return false;
    rules.forEach((r, i) => this.hits.set(r.key, [...fresh[i], nowMs]));
    return true;
  }
}

/** Лимиты Telegram: ~25/с на бота, 1/с в один чат, 20/мин в группу. */
export function limitsFor(destination: Destination): Rule[] {
  const rules: Rule[] = [{ key: 'global', limit: 25, windowMs: 1000 }];
  if (destination.chatId !== null) {
    rules.push({ key: `chat:${destination.chatId}`, limit: 1, windowMs: 1000 });
    if (destination.kind === 'telegram_group') {
      rules.push({ key: `group:${destination.chatId}`, limit: 20, windowMs: 60_000 });
    }
  }
  return rules;
}

/**
 * Один тик отправщика: вернуть зависшие, взять готовые к отправке, отправить
 * то, что пропускают лимиты (остальное — в следующий тик). 429 → ждать
 * retry_after весь чат; 403 → получатель заблокировал бота; прочее —
 * повторы с паузой, потом failed. Возвращает число отправленных.
 */
export async function processOutbox(
  notifier: Notifier,
  limiter: RateLimiter,
  clock: () => number = Date.now
): Promise<number> {
  const nowSec = () => Math.floor(clock() / 1000);
  await requeueStuck(nowSec() - STUCK_AFTER_SEC);

  const due = await listDueMessages(nowSec(), BATCH);
  const skipDestinations = new Set<number>(); // упёрлись в 429/403 в этом тике
  let sent = 0;

  for (const message of due) {
    const destId = message.destination.id;
    if (skipDestinations.has(destId)) continue;
    if (!limiter.tryAcquire(limitsFor(message.destination), clock())) continue;
    if (!(await claimMessage(message.id, nowSec()))) continue;

    let result: SendResult;
    try {
      result = await notifier.send(message.destination, message);
    } catch (error: any) {
      result = { ok: false, kind: 'error', message: error?.message || String(error) };
    }

    if (result.ok) {
      await markSent(message.id, nowSec());
      sent++;
    } else if (result.kind === 'retry_after') {
      await postponeDestination(destId, message.id, nowSec() + result.seconds);
      skipDestinations.add(destId);
    } else if (result.kind === 'blocked') {
      logger.warn(`Получатель #${destId} заблокировал бота — его очередь снята`);
      await markDestinationBlocked(destId);
      skipDestinations.add(destId);
    } else {
      const attempts = message.attempts + 1;
      if (attempts > RETRY_DELAYS_SEC.length) {
        logger.warn(`Сообщение #${message.id} не отправлено после ${attempts} попыток: ${result.message}`);
        await markFailed(message.id, attempts, result.message);
      } else {
        await scheduleRetry(message.id, attempts, nowSec() + RETRY_DELAYS_SEC[attempts - 1], result.message);
      }
    }
  }
  return sent;
}
