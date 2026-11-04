import {
  Source,
  cleanupDeals,
  deferSource,
  disableSource,
  listDueSources,
  markSourceFailed,
  markSourceOk,
  upsertSources,
} from '../../db/dealsRepo';
import { logger } from '../../utils/logger';
import { classifyDeals, hasLlmKeys } from '../AiModule/llmClient';
import { Classify, ingestRawDeals } from './ingest';
import { ALLOW_ALL, Robots, parseRobots } from './robots';
import { SOURCES, SourceConfig, sourceDefs } from './sources';
import { freebiesStats } from './stats';

/**
 * Раннер источников халявы (docs/freebies/CONTRACT.md, п. 4). Тик раз в 15 секунд берёт источники с
 * next_check_at <= now и проверяет их ПО ОЧЕРЕДИ: так к одному хосту никогда не идут два запроса сразу
 * (ponytail: когда появятся источники на разных хостах и тормоза одного начнут задерживать другие,
 * нужна очередь на хост). Повторы после сбоя не спят, а переносят next_check_at на 5 и 30 секунд.
 */

/** Общий User-Agent: честно называем себя, без почты и личных данных. */
export const USER_AGENT = 'gram-pervonah-freebies/1.0';
const TICK_MS = 15_000;
const TIMEOUT_MS = 15_000;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_FAILS = 5;
const RETRY_DELAYS_SEC = [5, 30];
const ROBOTS_TTL_SEC = 24 * 3600;
const MAX_REDIRECTS = 3;
const MAX_RETRY_AFTER_SEC = 3600;
const CLEANUP_EVERY_SEC = 600;

export interface RunnerDeps {
  fetch: typeof fetch;
  /** unix-секунды */
  now: () => number;
  random: () => number;
  /** Нет - нейросеть не используется */
  classify?: Classify;
  /** Вызывается после сохранения новых акций (доставка) */
  afterSave?: (dealIds: number[]) => Promise<void>;
  /** По умолчанию SOURCES */
  sources?: SourceConfig[];
}

type Outcome =
  | { type: 'ok'; status: number; body: string; contentType: string; etag: string | null; lastModified: string | null }
  | { type: 'retry'; reason: string }
  | { type: 'fail'; status: number | null; reason: string }
  | { type: 'limited'; waitSec: number | null };

class TooBig extends Error {}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw new TooBig('ответ больше 2 МБ');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function retryAfterSec(res: Response, now: number): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const seconds = Number(h);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at / 1000 - now) : null;
}

export function createFreebiesRunner(deps: RunnerDeps) {
  const configs = new Map((deps.sources ?? SOURCES).map((c) => [c.key, c]));
  const robotsCache = new Map<string, { robots: Robots; until: number }>();
  const retries = new Map<number, number>();
  let lastCleanup = 0;

  /** Один запрос: таймаут 15 с, тело до 2 МБ, переходы только внутри того же хоста. */
  async function request(url: URL, headers: Record<string, string>): Promise<Outcome> {
    try {
      let current = url;
      for (let hop = 0; ; hop++) {
        const res = await deps.fetch(current.href, {
          headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers },
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && res.status !== 304 && location) {
          await res.body?.cancel().catch(() => {});
          const next = new URL(location, current);
          if (next.origin !== url.origin || hop >= MAX_REDIRECTS) return { type: 'fail', status: res.status, reason: 'переадресация на другой адрес' };
          current = next;
          continue;
        }
        if (res.status === 429) return { type: 'limited', waitSec: retryAfterSec(res, deps.now()) };
        if (res.status >= 500) return { type: 'retry', reason: `ошибка ${res.status}` };
        if (res.status !== 304 && !res.ok) return { type: 'fail', status: res.status, reason: `ошибка ${res.status}` };
        return {
          type: 'ok',
          status: res.status,
          body: res.status === 304 ? '' : await readCapped(res),
          contentType: res.headers.get('content-type') ?? '',
          etag: res.headers.get('etag'),
          lastModified: res.headers.get('last-modified'),
        };
      }
    } catch (error: any) {
      if (error instanceof TooBig) return { type: 'fail', status: null, reason: error.message };
      return { type: 'retry', reason: `сеть: ${error?.cause?.code || error?.name || error?.message || error}` };
    }
  }

  /** robots.txt хоста с кэшем на сутки: 4xx - можно всё, 5xx и сеть - Outcome с проблемой. */
  async function robotsFor(url: URL, now: number): Promise<Robots | Outcome> {
    const hit = robotsCache.get(url.origin);
    if (hit && hit.until > now) return hit.robots;
    const out = await request(new URL('/robots.txt', url.origin), {});
    let robots: Robots;
    if (out.type === 'ok') robots = parseRobots(out.body, USER_AGENT);
    else if (out.type === 'fail') robots = ALLOW_ALL;
    else return out;
    robotsCache.set(url.origin, { robots, until: now + ROBOTS_TTL_SEC });
    return robots;
  }

  /** Следующая проверка: свой интервал (не меньше Crawl-delay) с разбросом +-20%. */
  const nextAt = (source: Source, now: number, crawlDelay: number | null) =>
    now + Math.round(Math.max(source.intervalSec, crawlDelay ?? 0) * (0.8 + 0.4 * deps.random()));

  async function fail(source: Source, now: number, reason: string, crawlDelay: number | null = null) {
    retries.delete(source.id);
    const disabled = await markSourceFailed(source.id, now, nextAt(source, now, crawlDelay), MAX_FAILS);
    logger.warn(`Халява: ${source.key}: ${reason}${disabled ? ` - источник отключён после ${MAX_FAILS} неудач подряд` : ''}`);
  }

  /** Сбой сети или 5xx: два повтора через 5 и 30 секунд, потом неудача. */
  async function retryOrFail(source: Source, now: number, reason: string) {
    const n = retries.get(source.id) ?? 0;
    if (n < RETRY_DELAYS_SEC.length) {
      retries.set(source.id, n + 1);
      await deferSource(source.id, now, now + RETRY_DELAYS_SEC[n]);
      return;
    }
    await fail(source, now, reason);
  }

  async function defer429(source: Source, now: number, waitSec: number | null) {
    retries.delete(source.id);
    const wait = Math.min(MAX_RETRY_AFTER_SEC, Math.max(waitSec ?? 0, source.intervalSec));
    await deferSource(source.id, now, now + Math.ceil(wait));
  }

  async function check(source: Source): Promise<void> {
    const now = deps.now();
    const config = configs.get(source.key);
    if (!config) return fail(source, now, 'нет разборщика для этого ключа');
    const url = new URL(source.url);

    const robots = await robotsFor(url, now);
    if (!('allows' in robots)) {
      if (robots.type === 'limited') return defer429(source, now, robots.waitSec);
      return fail(source, now, 'robots.txt не прочитан');
    }
    if (!robots.allows(url.pathname + url.search)) {
      await disableSource(source.id, 'robots', now);
      logger.warn(`Халява: ${source.key}: robots.txt запрещает опрос - источник отключён`);
      return;
    }

    const headers: Record<string, string> = {};
    if (source.etag) headers['If-None-Match'] = source.etag;
    if (source.lastModified) headers['If-Modified-Since'] = source.lastModified;
    const out = await request(url, headers);
    if (out.type === 'limited') return defer429(source, now, out.waitSec);
    if (out.type === 'retry') return retryOrFail(source, now, out.reason);
    if (out.type === 'fail') return fail(source, now, out.reason, robots.crawlDelay);

    let saved: number[] = [];
    if (out.status !== 304) {
      try {
        const raws = config.adapter.parse(out.body, out.contentType);
        saved = await ingestRawDeals(source.id, raws, config.defaults, source.lastOkAt === null, now, deps.classify);
      } catch (error: any) {
        return fail(source, now, `разбор: ${error?.message || error}`, robots.crawlDelay);
      }
    }
    // Успех всегда ставит last_ok_at (и при 304, и при пустом разборе) - иначе источник вечно был бы «первым опросом».
    retries.delete(source.id);
    await markSourceOk(source.id, now, nextAt(source, now, robots.crawlDelay), out.etag, out.lastModified);
    if (saved.length > 0) {
      await deps.afterSave?.(saved).catch((error) => logger.error('Халява: доставка после сохранения не удалась', error));
    }
  }

  return {
    async tick(): Promise<void> {
      const now = deps.now();
      for (const source of await listDueSources(now)) {
        try {
          await check(source);
        } catch (error) {
          logger.error(`Халява: ${source.key}: ошибка проверки`, error);
          await deferSource(source.id, now, now + source.intervalSec).catch(() => {});
        }
      }
      if (now - lastCleanup >= CLEANUP_EVERY_SEC) {
        lastCleanup = now;
        await cleanupDeals(now);
      }
    },
  };
}

/** Нейросеть только если задан ключ; каждый вызов считается (виден в /api/freebies/sources). */
const countedClassify: Classify = async (items) => {
  if (!hasLlmKeys()) return null;
  freebiesStats.llmCalls++;
  return classifyDeals(items);
};

/** Фоновый цикл раннера под замком одного экземпляра. Тики не накладываются. Возвращает stop(). */
export function startFreebiesWorker(deps: Partial<RunnerDeps> = {}): () => void {
  const runner = createFreebiesRunner({
    fetch: (...args) => fetch(...args),
    now: () => Math.floor(Date.now() / 1000),
    random: Math.random,
    classify: countedClassify,
    ...deps,
  });
  let stopped = false;
  let ready = false;
  let timer: NodeJS.Timeout;
  const run = async () => {
    try {
      if (!ready) {
        await upsertSources(sourceDefs());
        ready = true;
      }
      await runner.tick();
    } catch (error) {
      logger.error('Халява: ошибка тика', error);
    }
    if (!stopped) timer = setTimeout(run, TICK_MS);
  };
  timer = setTimeout(run, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
