import { CATEGORIES, CategoryCode, dedupKey, existingDedupKeys, saveDeal } from '../../db/dealsRepo';
import { DealVerdict } from '../AiModule/llmClient';
import { logger } from '../../utils/logger';
import { ParseDefaults, selectDeals } from './parse';
import { RawDeal } from './types';

/** Максимум записей в один вызов нейросети. Остальные остаются с результатом регулярок. */
const LLM_BATCH = 30;
const LLM_TEXT_CHARS = 300;

/**
 * Ключи записей, которые нейросеть признала не акцией: в базу они не попадают, а канал показывает те же
 * посты на каждом опросе, и без памяти их спрашивали бы снова и снова. ponytail: память процесса,
 * после перезапуска каждую спросят один раз; хранить в базе, если перезапуски станут частыми.
 */
const rejectedKeys = new Set<string>();
const REJECTED_MAX = 2000;

export type Classify = (items: { index: number; text: string }[]) => Promise<DealVerdict[] | null>;

/**
 * Записи источника -> акции в базе. Регулярки и простой фильтр, дубли по dedup_key отбрасываются до
 * нейросети; нейросеть (если передана) вызывается один раз на пачку новых записей и может только
 * отсеять не-акцию или поправить категорию. Упала - остаётся результат регулярок.
 * muted = первая успешная проверка источника: сохраняем без рассылки. Возвращает id новых акций.
 */
export async function ingestRawDeals(
  sourceId: number,
  raws: RawDeal[],
  defaults: ParseDefaults,
  muted: boolean,
  now: number,
  classify?: Classify
): Promise<number[]> {
  const textByUrl = new Map(raws.map((r) => [r.url, r.text.replace(/`/g, '')]));
  const keyed = new Map<string, ReturnType<typeof selectDeals>[number]>();
  for (const d of selectDeals(raws, defaults, now)) {
    const key = dedupKey(d.store, d.promoCode, d.url, d.title);
    if (!keyed.has(key)) keyed.set(key, d);
  }
  const existing = await existingDedupKeys([...keyed.keys()]);
  const fresh0 = [...keyed.entries()].filter(([key]) => !existing.has(key) && !rejectedKeys.has(key));
  let fresh = fresh0.map(([, d]) => d);

  // Нейросеть не зовём при первой (muted) проверке источника (эти акции не рассылаются) и для доверенных источников.
  if (classify && !muted && !defaults.trusted && fresh.length > 0) {
    try {
      const batch = fresh.slice(0, LLM_BATCH);
      const verdicts = await classify(batch.map((d, index) => ({ index, text: (textByUrl.get(d.url) ?? d.title).slice(0, LLM_TEXT_CHARS) })));
      if (verdicts) {
        const byIndex = new Map(verdicts.map((v) => [v.index, v]));
        fresh = fresh.flatMap((d, i) => {
          const v = byIndex.get(i);
          if (!v) return [d];
          if (!v.isDeal) {
            if (rejectedKeys.size >= REJECTED_MAX) rejectedKeys.clear();
            rejectedKeys.add(fresh0[i][0]);
            return [];
          }
          return [(CATEGORIES as readonly string[]).includes(v.category ?? '') ? { ...d, category: v.category as CategoryCode } : d];
        });
      }
    } catch (error: any) {
      logger.warn(`Халява: нейросеть не ответила, остаётся разбор по правилам (${error?.message || error})`);
    }
  }

  const saved: number[] = [];
  for (const d of fresh) {
    const id = await saveDeal({ ...d, sourceId, muted }, now);
    if (id !== null) saved.push(id);
  }
  return saved;
}
