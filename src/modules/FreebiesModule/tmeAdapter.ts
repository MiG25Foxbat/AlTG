import { RawDeal, SourceAdapter } from './types';

/**
 * Веб-превью публичного канала https://t.me/s/<канал>. Берём из каждого сообщения только
 * data-post, текст (div.js-message_text) и время из time[datetime] (UTC). Автор, имя владельца,
 * "Forwarded from", ответы, реакции и просмотры не читаются - это не наши данные.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Символ по коду; больше 0x10FFFF - null (сущность остаётся как есть, а не RangeError на чужой странице). */
const codePoint = (n: number) => (n <= 0x10ffff ? String.fromCodePoint(n) : null);

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codePoint(parseInt(h, 16)) ?? m)
    .replace(/&#(\d+);/g, (m, d) => codePoint(Number(d)) ?? m)
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** HTML текста сообщения -> простой текст; <code> становится `код`, <br> и блоки - переводы строк. */
export function htmlToText(html: string): string {
  const text = decodeEntities(
    html
      .replace(/<tg-emoji[\s\S]*?<\/tg-emoji>/gi, '')
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => '`' + inner.replace(/<[^>]*>/g, '').trim() + '`')
      .replace(/<br\s*\/?>|<\/?(?:blockquote|div|p)[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  );
  return text
    .replace(/[\p{Extended_Pictographic}‍️]/gu, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !/^forwarded from\b/i.test(line))
    .join('\n');
}

function hostsOf(html: string): string[] {
  const hosts = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    try {
      const host = new URL(decodeEntities(m[1])).hostname;
      if (host !== 't.me') hosts.add(host);
    } catch {
      // не ссылка - пропускаем
    }
  }
  return [...hosts];
}

export const tmeAdapter: SourceAdapter = {
  key: 'tme',
  parse(body) {
    const marks = [...body.matchAll(/data-post="([^"]+)"/g)];
    const result: RawDeal[] = [];
    marks.forEach((mark, i) => {
      const chunk = body.slice(mark.index, marks[i + 1]?.index ?? body.length);
      const textHtml = /<div class="tgme_widget_message_text[^"]*js-message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(chunk)?.[1];
      const time = /<time[^>]*datetime="([^"]+)"/.exec(chunk)?.[1];
      const publishedAt = time ? Date.parse(time) / 1000 : NaN;
      // Без текста (одна картинка) или без времени - не акция: свежесть не проверить.
      if (!textHtml || !Number.isFinite(publishedAt) || !/^[\w]+\/\d+$/.test(mark[1])) return;
      const text = htmlToText(textHtml);
      if (!text) return;
      result.push({
        title: text.split('\n')[0].replace(/`/g, '').replace(/[\s:]+$/, ''),
        text,
        // Партнёрскую ссылку из текста не берём: ведём на сам пост.
        url: `https://t.me/${mark[1]}`,
        publishedAt: Math.floor(publishedAt),
        hosts: hostsOf(textHtml),
      });
    });
    return result;
  },
};
