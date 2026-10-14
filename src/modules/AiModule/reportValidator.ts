import { URGENCY_LEVELS, Urgency } from '../../db/alertsRepo';

/**
 * Проверка пунктов алерта (ТЗ п. 8): модели не верим на слово. Пункт проходит,
 * только если он подтверждается постами, на которые сам ссылается:
 * - все source_ids — среди переданных модели;
 * - дословная цитата реально есть в одном из этих постов (без учёта регистра и пробелов);
 * - каждое число из текста пункта есть среди чисел этих постов (по значению).
 * Не прошёл — выкидываем (вызывающий логирует причину); не прошёл ни один —
 * отчёт не шлём.
 */

export interface ValidItem<P> {
  text: string;
  urgency: Urgency;
  sources: P[];
}

export interface RejectedItem {
  item: unknown;
  reason: string;
}

const MAX_ITEM_CHARS = 1000;
/** Цитата из пары слов ничего не подтверждает — короче можно только весь пост целиком. */
const MIN_QUOTE_CHARS = 10;

export function normalizeForQuote(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

const GROUP_SEP = /[   ]/g;
// «1 000 000» (разряды через пробел/неразрывный пробел) или просто цифры; дробная часть через «,» или «.».
const NUMBER_RE = /\d{1,3}(?:[   ]\d{3})+(?!\d)(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;

const toNumber = (raw: string) => Number(raw.replace(GROUP_SEP, '').replace(',', '.'));

/** Числа текста по значению: «1,5» = «1.5», «1 000» = 1000. */
export function extractNumbers(text: string): number[] {
  return (text.match(NUMBER_RE) ?? []).map(toNumber);
}

/**
 * Числа поста: кроме слитного значения ещё и каждая группа разрядов отдельно —
 * «между 1 и 2 300» может значить и 2300, и «2» с «300». Строже нельзя без
 * понимания смысла, а пропустить настоящее число хуже.
 */
function postNumbers(text: string): number[] {
  return (text.match(NUMBER_RE) ?? []).flatMap((raw) => {
    const parts = raw.split(GROUP_SEP);
    return parts.length > 1 ? [toNumber(raw), ...parts.map(toNumber)] : [toNumber(raw)];
  });
}

/** Причина отказа строкой или проверенный пункт. */
function checkItem<P extends { text: string }>(item: any, posts: P[]): ValidItem<P> | string {
  const text = typeof item?.text === 'string' ? item.text.trim() : '';
  if (!text) return 'пустой текст';
  if (text.length > MAX_ITEM_CHARS) return 'слишком длинный текст';

  const ids: unknown = item?.source_ids;
  if (!Array.isArray(ids) || ids.length === 0) return 'нет источников';
  if (!ids.every((id) => Number.isInteger(id) && id >= 0 && id < posts.length)) {
    return `source_ids не из переданных постов: ${JSON.stringify(ids)}`;
  }
  const sources = [...new Set(ids as number[])].map((id) => posts[id]);
  const cited = sources.map((p) => normalizeForQuote(p.text));

  const quote = typeof item?.quote === 'string' ? normalizeForQuote(item.quote) : '';
  if (!quote) return 'нет цитаты';
  if (!cited.some((t) => t.includes(quote))) return 'цитаты нет в постах-источниках';
  if (quote.length < MIN_QUOTE_CHARS && !cited.includes(quote)) return 'цитата слишком короткая';

  const known = new Set(sources.flatMap((p) => postNumbers(p.text)));
  const foreign = extractNumbers(text).filter((n) => !known.has(n));
  if (foreign.length > 0) return `числа не из постов-источников: ${foreign.join(', ')}`;

  const urgency: Urgency = URGENCY_LEVELS.includes(item?.urgency) ? item.urgency : 'normal';
  return { text, urgency, sources };
}

/** posts — ровно те посты и в том порядке, что ушли модели (source_ids — индексы в нём). */
export function validateReportItems<P extends { text: string }>(
  raw: unknown[],
  posts: P[]
): { valid: ValidItem<P>[]; rejected: RejectedItem[] } {
  const valid: ValidItem<P>[] = [];
  const rejected: RejectedItem[] = [];
  for (const item of raw) {
    const result = checkItem(item, posts);
    if (typeof result === 'string') rejected.push({ item, reason: result });
    else valid.push(result);
  }
  return { valid, rejected };
}

/** Срочность отчёта = максимум по прошедшим проверку пунктам. */
export function maxUrgency(levels: Urgency[]): Urgency {
  return levels.reduce<Urgency>(
    (max, u) => (URGENCY_LEVELS.indexOf(u) > URGENCY_LEVELS.indexOf(max) ? u : max),
    'normal'
  );
}
