import { CategoryCode, NewDeal, StoreCode } from '../../db/dealsRepo';
import { RawDeal } from './types';

/**
 * Разбор записи на акции: магазин, промокод, скидка, срок - регулярками, без нейросети.
 * Пост с несколькими промокодами даёт несколько акций (у каждого кода своя часть текста).
 * Чистые функции, время передаётся параметром.
 */

export interface ParseDefaults {
  store?: StoreCode;
  category?: CategoryCode;
  /** Официальная страница акций или лента конкурсов: каждая запись - акция, скидка и промокод не обязательны, нейросеть не зовём */
  trusted?: boolean;
}
export type ParsedDeal = Omit<NewDeal, 'sourceId' | 'muted'>;

const DAY = 86400;
const MSK = 3 * 3600;

// --- Магазин ---

// \b в JS не работает с кириллицей, границы слова - через look-around.
const L = '(?<![\\p{L}\\d])';
const R = '(?![\\p{L}\\d])';
const STORE_WORDS: [StoreCode, string][] = [
  ['goldapple', `золот\\p{L}*\\s+яблок|${L}зя${R}|gold\\s?apple`],
  ['wildberries', `${L}wb${R}|wildberries|вайлд?берр?из`],
  ['ozon', `${L}(?:ozon|озон)${R}`],
  ['letual', `${L}(?:л[еэ]туал\\p{L}*|letu)${R}`],
  ['iledebeaute', `${L}(?:иль\\s+де\\s+бот\\p{L}*|iledebeaute)${R}`],
  ['podrygka', `${L}(?:подружк\\p{L}*|podrygka)${R}`],
  ['4lapy', `${L}(?:(?:четыре|4)\\s+лап\\p{L}*|4lapy)${R}`],
  ['rivegauche', `${L}(?:рив\\s+гош\\p{L}*|rive\\s?gauche)${R}`],
  ['detmir', `${L}(?:детск\\p{L}*\\s+мир\\p{L}*|detmir)${R}`],
  ['lamoda', `${L}(?:lamoda|ламод\\p{L}*)${R}`],
  ['yandexmarket', `${L}(?:яндекс\\s?маркет\\p{L}*|market\\.yandex)`],
];
const STORE_HOSTS: [StoreCode, RegExp][] = [
  ['goldapple', /goldapple|gldppl/i],
  ['wildberries', /wildberries|(^|\.)wb\.ru$/i],
  ['ozon', /ozon/i],
  ['letual', /(^|\.)letu\.ru$/i],
  ['iledebeaute', /iledebeaute/i],
  ['podrygka', /podrygka/i],
  ['4lapy', /4lapy/i],
  ['rivegauche', /rivegauche/i],
  ['detmir', /detmir/i],
  ['lamoda', /lamoda/i],
  ['yandexmarket', /market\.yandex|yandex\.market/i],
];

function storeMentions(text: string): { store: StoreCode; at: number }[] {
  const found: { store: StoreCode; at: number }[] = [];
  for (const [store, pattern] of STORE_WORDS) {
    for (const m of text.matchAll(new RegExp(pattern, 'giu'))) found.push({ store, at: m.index! });
  }
  return found.sort((a, b) => a.at - b.at);
}

// --- Категория ---

const CATEGORY_WORDS: [CategoryCode, RegExp][] = [
  ['pets', /корм|кошк|кошач|(?<!\p{L})кот(?!\p{L})|собак|питомц|(?<!\p{L})зоо/iu],
  ['beauty', /косметик|уход|парфюм|помад|крем|красот|макияж|beauty|шампун/i],
  ['kids', /детск|ребён|ребен|малыш|игрушк|подгузник/i],
  ['fashion', /обув|одежд|кроссовк|платье|куртк|сумк|джинс|футболк/i],
];

function categoryFor(text: string, fallback?: CategoryCode): CategoryCode {
  return CATEGORY_WORDS.find(([, re]) => re.test(text))?.[0] ?? fallback ?? 'other';
}

// --- Промокод ---

const CODE_TOKEN = /^[\p{L}\p{N}_-]{3,32}$/u;
/** Слово про код или процент рядом: иначе слова в <code> - не промокоды (ответы викторин, пример 11). */
const PROMO_HINT = /промокод|промик|(?<!\p{L})код|купон|\d\s*%/iu;
const QUIZ = /ответ|викторин/i;
/** Слова в <code>, которые сами называют промокод, а не являются им. */
const NOT_A_CODE = /^(?:промокод|промик|код|купон)\p{L}*$/iu;
/** Служебные слова, которые после «промокод» бывают заглавными («ПРОМОКОД ТОЛЬКО СЕГОДНЯ»): слово целиком, не код. */
const STOP = /^(?:для|вс[её]х|всем|все|при|только|вас|вам|тебе|наш\p{L}*|ваш\p{L}*|бесплатн\p{L}*|скидк\p{L}*|подарок|сегодня|сейчас|здесь|внутри|ниже)$/iu;

// --- Скидка ---

const DASHES = '-–—−';
// Фраза скидки до конца предложения; точка внутри слова («М.Косметик», «5.11») её не обрывает.
const PERCENT = new RegExp(`[${DASHES}]?\\s*(\\d{1,2})\\s*%(?:[^\\n.;]|\\.(?=\\S))*`, 'g');
const RUBLES = /\d[\d ]{0,8}\s?(?:₽|руб\p{L}*)(?:[^\n.;]|\.(?=\S))*/giu;
// Разряды через пробел или неразрывный пробел: «1 000 бонусов», «10 000».
const BONUS = /(\d{1,3}(?:[  ]\d{3})+|\d{2,5})\s*бонус\p{L}*/iu;

function cleanClause(s: string): string {
  return s
    .replace(/\s+(?:до|по)\s+\d.*$/i, '')
    .replace(/[\s,!:–—-]+$/, '')
    .trim();
}

function parseDiscount(s: string, allowRubles: boolean): { percent: number | null; text: string } | null {
  const clauses: string[] = [];
  let percent = 0;
  for (const m of s.matchAll(PERCENT)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 99) {
      percent = Math.max(percent, n);
      const clause = cleanClause(m[0]);
      if (!clauses.includes(clause)) clauses.push(clause);
    }
  }
  if (percent) return { percent, text: clauses.join(', ').slice(0, 100) };
  if (allowRubles || /скидк/i.test(s)) {
    const rub = s.match(RUBLES)?.[0];
    if (rub) return { percent: null, text: cleanClause(rub).slice(0, 100) };
  }
  const bonus = BONUS.exec(s);
  return bonus ? { percent: null, text: `${bonus[1].replace(/\s/g, ' ')} бонусов` } : null;
}

// --- Срок (МСК) ---

const MONTH = 'янв|фев|мар|апр|ма[яй]|июн|июл|авг|сен|окт|ноя|дек';
export const MONTH_NUMBER: Record<string, number> = { янв: 1, фев: 2, мар: 3, апр: 4, мая: 5, май: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12 };

/** День, месяц и время по Москве -> unix; null, если даты не существует. Год не указан: от даты публикации. */
export function mskTime(day: number, month: number, year: number | undefined, h: number, mi: number, sec: number, ref: number): number | null {
  const at = (y: number) => {
    const d = new Date(Date.UTC(y, month - 1, day, h, mi, sec));
    return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d.getTime() / 1000 - MSK : null;
  };
  if (year !== undefined) return at(year);
  const y = new Date((ref + MSK) * 1000).getUTCFullYear();
  const ts = at(y);
  // «до 5 января» в декабрьском посте - следующий год.
  return ts !== null && ts < ref - 60 * DAY ? at(y + 1) : ts;
}

const endOfMskDay = (t: number) => Math.floor((t + MSK) / DAY) * DAY + DAY - 1 - MSK;

/** Срок из текста: «до 5 ноября», «до 5.11», «до 24.10.2026 23:59», «до 10:00 31.10», «до 23:59», «ещё 2 часа», «только сегодня». */
export function parseExpiry(s: string, ref: number): number | null {
  let m: RegExpExecArray | null;
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  if ((m = /(\d{1,2}):(\d{2})\s+(?:\p{L}+\s+)?(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?/u.exec(s))) {
    return mskTime(+m[3], +m[4], num(m[5]), +m[1], +m[2], 0, ref);
  }
  if ((m = /(?:до|по)\s+(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})/iu.exec(s))) {
    return mskTime(+m[1], +m[2], num(m[3]), +m[4], +m[5], 0, ref);
  }
  if ((m = new RegExp(`(?:до|по|только|включительно)\\s+(\\d{1,2})\\s+(${MONTH})\\p{L}*\\.?(?:\\s+(\\d{4}))?`, 'iu').exec(s))) {
    return mskTime(+m[1], MONTH_NUMBER[m[2].toLowerCase()], num(m[3]), 23, 59, 59, ref);
  }
  if ((m = /(?:до|по)\s+(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?!\d)/iu.exec(s))) {
    return mskTime(+m[1], +m[2], num(m[3]), 23, 59, 59, ref);
  }
  if ((m = /до\s+(\d{1,2}):(\d{2})/iu.exec(s))) {
    const day = new Date((ref + MSK) * 1000);
    const ts = mskTime(day.getUTCDate(), day.getUTCMonth() + 1, day.getUTCFullYear(), +m[1], +m[2], 0, ref);
    return ts === null ? null : ts <= ref ? ts + DAY : ts;
  }
  if ((m = /(?:ещё|еще|осталось)\s+(\d{1,3})\s*(час|мин)/iu.exec(s))) {
    return ref + +m[1] * (m[2] === 'час' ? 3600 : 60);
  }
  return /только\s+сегодня|до\s+конца\s+дня/iu.test(s) ? endOfMskDay(ref) : null;
}

// --- Сборка ---

interface CodeAt {
  code: string;
  start: number;
  end: number;
}

function findCodes(text: string): CodeAt[] {
  if (!PROMO_HINT.test(text) || QUIZ.test(text)) return [];
  const codes: CodeAt[] = [];
  for (const m of text.matchAll(/`([^`\n]{2,40})`/g)) {
    const code = m[1].trim();
    if (CODE_TOKEN.test(code) && /\p{L}/u.test(code) && !NOT_A_CODE.test(code) && !codes.some((c) => c.code.toUpperCase() === code.toUpperCase())) {
      codes.push({ code, start: m.index!, end: m.index! + m[0].length });
    }
  }
  // Официальные каналы пишут код без <code>: «промокод ЧЁРНЫЙ». Только ЗАГЛАВНЫЙ токен сразу за словом: «промокод на скидку» кодом не считается.
  if (codes.length === 0) {
    for (const m of text.matchAll(/промокод\p{L}*[\s:]*[«"“]?/giu)) {
      const at = m.index! + m[0].length;
      const code = /^[\p{Lu}\d][\p{Lu}\d-]{2,19}(?![\p{L}\d])/u.exec(text.slice(at))?.[0];
      if (code && /\p{L}/u.test(code) && !NOT_A_CODE.test(code) && !STOP.test(code) && !codes.some((c) => c.code === code)) codes.push({ code, start: at, end: at + code.length });
    }
  }
  return codes;
}

/** Магазин для куска текста: ближайшее упоминание перед кодом, затем любое в посте, ссылки, магазин источника. */
function pickStore(before: string, whole: string, hosts: string[], defaults: ParseDefaults): StoreCode {
  // Доверенный источник знает свой магазин: упоминание другого в названии его не меняет.
  if (defaults.trusted && defaults.store) return defaults.store;
  const near = storeMentions(before).pop();
  if (near) return near.store;
  const any = storeMentions(whole)[0];
  if (any) return any.store;
  for (const host of hosts) {
    const hit = STORE_HOSTS.find(([, re]) => re.test(host));
    if (hit) return hit[0];
  }
  return defaults.store ?? 'other';
}

/** Одна запись источника -> акции (может быть ноль, одна или несколько). Фильтров по свежести и магазину здесь нет. */
export function extractDeals(raw: RawDeal, defaults: ParseDefaults, now: number): ParsedDeal[] {
  const publishedAt = Math.min(raw.publishedAt ?? now, now);
  const title = raw.title.replace(/`/g, '').trim() || raw.text.replace(/`/g, '').split('\n')[0];
  const plain = raw.text.replace(/`/g, '');
  // Золотое яблоко - магазин косметики: без других подсказок категория красота.
  const category = (store: StoreCode) =>
    defaults.trusted && defaults.category ? defaults.category : categoryFor(plain, defaults.category ?? (store === 'goldapple' ? 'beauty' : undefined));
  const common = { title, url: raw.url, publishedAt };
  const hosts = raw.hosts ?? [];
  const codes = findCodes(raw.text);

  if (codes.length === 0) {
    const d = parseDiscount(plain, false);
    // Доверенному источнику скидка не нужна: акция есть сама по себе.
    if (!d && !defaults.trusted) return [];
    const store = pickStore(plain, plain, hosts, defaults);
    return [
      {
        ...common,
        category: category(store),
        store,
        promoCode: null,
        discountPercent: d?.percent ?? null,
        discountText: d?.text ?? null,
        expiresAt: raw.expiresAt ?? parseExpiry(plain, publishedAt),
      },
    ];
  }

  const strip = (s: string) => s.replace(/`/g, '');
  const pre = strip(raw.text.slice(0, codes[0].start));
  return codes.map((c, i) => {
    const after = strip(raw.text.slice(c.end, codes[i + 1]?.start ?? raw.text.length));
    const before = strip(raw.text.slice(codes[i - 1]?.end ?? 0, c.start));
    const d = parseDiscount(after, true) ?? parseDiscount(pre, true);
    const store = pickStore(before, plain, hosts, defaults);
    return {
      ...common,
      category: category(store),
      store,
      promoCode: c.code,
      discountPercent: d?.percent ?? null,
      discountText: d?.text ?? null,
      expiresAt: raw.expiresAt ?? parseExpiry(after, publishedAt) ?? parseExpiry(pre, publishedAt),
    };
  });
}

/**
 * Простой фильтр: свежая, срок не вышел; доверенный источник - всё подряд, остальные - распознанный магазин
 * и промокод или скидка.
 */
export function selectDeals(raws: RawDeal[], defaults: ParseDefaults, now: number): ParsedDeal[] {
  return raws
    .filter((r) => r.publishedAt === null || now - r.publishedAt <= DAY)
    .sort((a, b) => (a.publishedAt ?? now) - (b.publishedAt ?? now))
    .flatMap((r) => extractDeals(r, defaults, now))
    .filter(
      (d) =>
        (defaults.trusted || (d.store !== 'other' && (d.promoCode !== null || d.discountPercent !== null || d.discountText !== null))) &&
        (d.expiresAt === null || d.expiresAt > now)
    );
}
