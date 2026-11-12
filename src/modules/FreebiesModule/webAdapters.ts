import { MONTH_NUMBER, mskTime } from './parse';
import { decodeEntities, htmlToText } from './tmeAdapter';
import { RawDeal, SourceAdapter } from './types';

/**
 * Адаптеры обычных сайтов (docs/freebies/SOURCES_WEB.md): официальные страницы акций магазинов и два агрегатора.
 * Регулярки, без DOM-библиотеки. Берём только название, ссылку, срок и дату: описания, плашки и картинки не копируем.
 * Нет времени публикации - publishedAt = null (станет временем находки). Ни одной карточки - ошибка разбора:
 * смена вёрстки или заглушка должны отключить источник, а не молчать.
 */

/** Конец дня по Москве; null, если такой даты нет. */
const endOfMskDay = (y: number, m: number, d: number) => mskTime(d, m, y, 23, 59, 59, 0);

/**
 * Ссылка из чужой страницы: относительная разрешается от base; null, если мусор или другой хост/схема.
 * Ссылка уходит человеку в алерт, поэтому только на сам сайт источника.
 */
function siteUrl(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return u.origin === new URL(base).origin ? u.href : null;
  } catch {
    return null;
  }
}

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`).exec(tag); // кавычки бывают и одинарные
  return m ? decodeEntities(m[1] ?? m[2]) : undefined;
};
const oneLine = (html: string) => htmlToText(html).replace(/\s+/g, ' ').trim();

/** Куски тела от open до ближайшего close (indexOf, а не [\s\S]*?: незакрытые теги не дают квадратичного разбора). */
function blocks(body: string, open: string, close: string): string[] {
  const out: string[] = [];
  for (let i = body.indexOf(open); i >= 0; ) {
    const j = body.indexOf(close, i);
    if (j < 0) break;
    out.push(body.slice(i, j));
    i = body.indexOf(open, j);
  }
  return out;
}

/** Запись; обратные кавычки из чужого текста убираем: в тексте ими помечены промокоды. */
function deal(title: string, url: string, rest: Partial<RawDeal> = {}): RawDeal {
  const clean = (s: string) => s.replace(/`/g, '').replace(/[^\S\n]+/g, ' '); // и неразрывные пробелы из вёрстки
  return { title: clean(title).trim(), text: clean(title), url, publishedAt: null, ...rest };
}

/** Страница акций без единой акции - не «пусто», а смена вёрстки или заглушка (SPA-оболочка): пусть считается неудачей. Дубли по ссылке - остаётся первая. */
function needCards(deals: RawDeal[]): RawDeal[] {
  if (deals.length === 0) throw new Error('на странице нет карточек (вёрстка изменилась или оболочка без данных)');
  return [...new Map(deals.filter((d) => d.title).map((d) => [d.url, d])).values()];
}

function walk(node: unknown, pick: (o: any) => boolean, out: any[] = []): any[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, pick, out));
  else if (node && typeof node === 'object') {
    if (pick(node)) out.push(node);
    Object.values(node).forEach((v) => walk(v, pick, out));
  }
  return out;
}

function nextData(body: string): unknown {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(body);
  if (!m) throw new Error('нет __NEXT_DATA__ (вёрстка изменилась или заглушка)');
  return JSON.parse(m[1]);
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Иль де Ботэ: объекты акций ищем по набору ключей, а не по пути; пункты меню без dateFrom не подходят. */
export const iledebeauteAdapter: SourceAdapter = {
  key: 'iledebeaute',
  parse(body) {
    const items = walk(nextData(body), (o) => typeof o.id === 'number' && isStr(o.code) && isStr(o.name) && isStr(o.url) && isStr(o.dateFrom));
    const result: RawDeal[] = [];
    for (const o of items) {
      const url = siteUrl(o.url, 'https://iledebeaute.ru/');
      if (!url) continue;
      const to = o.hasNoLimit ? NaN : Date.parse(o.dateTo);
      const d = deal(o.name, url, { expiresAt: Number.isFinite(to) ? Math.floor(to / 1000) : null });
      if (isStr(o.description)) d.text += '\n' + o.description.replace(/`/g, ''); // короткое описание: из него берётся «скидки до 70%»
      result.push(d);
    }
    return needCards(result);
  },
};

/** Четыре Лапы: название, срок (ДД-ММ-ГГГГ, конец дня по Москве), ссылка по коду. Плашку скидки не берём: скидка из названия. */
export const lapyAdapter: SourceAdapter = {
  key: '4lapy',
  parse(body) {
    const items = walk(nextData(body), (o) => isStr(o.code) && isStr(o.name) && isStr(o.dateActiveFrom) && o.active === true);
    const result: RawDeal[] = [];
    for (const o of items) {
      const url = siteUrl(`/shares/${encodeURIComponent(o.code)}/`, 'https://4lapy.ru/');
      const to = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(o.dateActiveTo));
      if (url) result.push({ ...deal(o.name, url), expiresAt: to ? endOfMskDay(+to[3], +to[2], +to[1]) : null });
    }
    return needCards(result);
  },
};

/** Подружка: a.grid-cell со ссылкой на /actions/ и data-title; ссылки каталога и чужих хостов не берём. */
export const podrygkaAdapter: SourceAdapter = {
  key: 'podrygka',
  parse(body) {
    const result: RawDeal[] = [];
    for (const m of body.matchAll(/<a\b[^>]*>/g)) {
      // В живом ответе ссылки относительные от /actions/ («kd_x_nov2026/»), у Firecrawl были абсолютные.
      const url = siteUrl(attr(m[0], 'href'), 'https://www.podrygka.ru/actions/');
      const title = attr(m[0], 'data-title');
      if (url?.startsWith('https://www.podrygka.ru/actions/') && !url.includes('?') && title && /grid-cell/.test(attr(m[0], 'class') ?? '')) {
        result.push(deal(title, url));
      }
    }
    return needCards(result);
  },
};

/** Proactions RSS 2.0: только title, link, pubDate; описание не читаем. Дубли по ссылке. */
export const proactionsAdapter: SourceAdapter = {
  key: 'proactions',
  parse(body) {
    const tag = (item: string, name: string) =>
      decodeEntities((new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(item)?.[1] ?? '').replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')).trim();
    const result: RawDeal[] = [];
    for (const item of blocks(body, '<item>', '</item>')) {
      const url = siteUrl(tag(item, 'link'), 'https://proactions.ru/');
      const published = Date.parse(tag(item, 'pubDate'));
      if (url) result.push(deal(tag(item, 'title'), url, { publishedAt: Number.isFinite(published) ? Math.floor(published / 1000) : null }));
    }
    return needCards(result);
  },
};

/**
 * Пробник.ру: article.postBox > h2 > a и дата «10 Ноя 2026 года» в div.info. Времени нет, поэтому
 * publishedAt - конец того дня по Москве: сегодняшняя и вчерашняя запись проходят правило «не старше суток»,
 * более старые отбрасываются как обычно.
 */
export const probnickAdapter: SourceAdapter = {
  key: 'probnick',
  parse(body) {
    const result: RawDeal[] = [];
    for (const article of blocks(body, '<article class="postBox', '</article>')) {
      const link = /<h2>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/h2>/.exec(article);
      const url = link && siteUrl(attr(link[1], 'href'), 'https://probnick.ru/');
      if (!link || !url) continue;
      const date = /<div class="info">\s*(\d{1,2})\s+(\p{L}+)\s+(\d{4})/u.exec(article);
      const month = date ? MONTH_NUMBER[date[2].toLowerCase().slice(0, 3)] : undefined;
      result.push(deal(oneLine(link[2]), url, { publishedAt: date && month ? endOfMskDay(+date[3], month, +date[1]) : null }));
    }
    return needCards(result);
  },
};
