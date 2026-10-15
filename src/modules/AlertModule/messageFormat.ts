import { Urgency } from '../../db/alertsRepo';
import { formatMoscowTime } from '../../utils/time';

/**
 * Сборка алерта в HTML для Bot API (ТЗ п. 9). Чистые функции: без сети и БД,
 * разметка кнопок — обычный JSON reply_markup, его же кладём в outbox.
 */

/** Лимит Telegram на текст сообщения. Меряем длину HTML — она не меньше видимой, так что с запасом. */
export const TELEGRAM_TEXT_LIMIT = 4096;
/** Больше ссылок под одним пунктом не показываем — иначе пункт может сам не влезть в сообщение. */
const MAX_LINKS_PER_ITEM = 5;

export interface MessageSource {
  channel: string;
  channelTitle: string | null;
  link: string;
  postedAt: number;
}

export interface MessageItem {
  text: string;
  urgency: Urgency;
  sources: MessageSource[];
}

export interface AlertMessageInput {
  topicId: number;
  topicLabel: string;
  /** Последний из склеенных отчётов — на него ссылается обратная связь */
  reportId: number;
  items: MessageItem[];
  /** unix-секунды, время в шапке */
  now: number;
  /** Личная сессия отвалилась, а в подписке есть приватные каналы — пометка внизу */
  privateChannelsPaused?: boolean;
  /** Сайт — для ссылки «переподключите аккаунт» */
  siteUrl?: string | null;
}

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data?: string; url?: string }[][];
}

export interface OutgoingPart {
  text: string;
  replyMarkup: InlineKeyboard | null;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const URGENCY_MARK: Record<Urgency, string> = { urgent: '🔴', important: '🟠', normal: '•' };

/**
 * callback_data ≤ 64 байт: «fb:<действие>:<topicId>[:<reportId>]».
 * nr — не релевантно, less — реже, off — отключить тему.
 */
export function feedbackKeyboard(topicId: number, reportId: number): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: 'Не релевантно', callback_data: `fb:nr:${topicId}:${reportId}` },
        { text: 'Реже', callback_data: `fb:less:${topicId}:${reportId}` },
      ],
      [{ text: 'Отключить тему', callback_data: `fb:off:${topicId}:${reportId}` }],
    ],
  };
}

/**
 * Экранированный текст не длиннее max: «&» превращается в «&amp;», поэтому
 * режем исходник, а не готовый HTML (иначе можно разрезать сущность).
 * ponytail: так пункт гарантированно влезает при обычных текстах; совсем
 * патологический (сплошные кавычки в теме и названиях) получит 400 от
 * Telegram и уйдёт в failed с ошибкой в логе.
 */
function escapeCapped(text: string, max: number): string {
  let raw = text;
  let html = escapeHtml(raw);
  while (html.length > max) {
    raw = raw.slice(0, Math.floor(raw.length * 0.8));
    html = escapeHtml(raw) + '…';
  }
  return html;
}

function formatItem(item: MessageItem): string {
  const shown = item.sources.slice(0, MAX_LINKS_PER_ITEM).map((s) => {
    const name = escapeCapped(s.channelTitle || s.channel, 64);
    return `<a href="${escapeHtml(s.link)}">${name} · ${formatMoscowTime(s.postedAt)}</a>`;
  });
  const more = item.sources.length - shown.length;
  const links = shown.join(' | ') + (more > 0 ? ` и ещё ${more}` : '');
  return `${URGENCY_MARK[item.urgency]} ${escapeCapped(item.text, 1500)}\n↳ ${links}`;
}

/**
 * Шапка (тема + время), пункты со ссылками на посты, при необходимости —
 * пометка про приватные каналы. Длиннее лимита — режем на части по пунктам
 * (пункт целиком в одной части); кнопки только под последней частью.
 */
export function buildAlertMessages(input: AlertMessageInput): OutgoingPart[] {
  const header = `🔔 <b>${escapeHtml(input.topicLabel)}</b>\n<i>${formatMoscowTime(input.now)} МСК</i>`;
  const contHeader = `🔔 <b>${escapeHtml(input.topicLabel)}</b> <i>(продолжение)</i>`;
  const reconnect = input.siteUrl ? `<a href="${escapeHtml(input.siteUrl)}">переподключите аккаунт</a>` : 'переподключите аккаунт на сайте';
  const footer = input.privateChannelsPaused ? `⚠️ Приватные каналы сейчас не проверяются — ${reconnect}` : '';

  const blocks = [...input.items.map(formatItem), ...(footer ? [footer] : [])];
  const texts: string[] = [];
  let current = header;
  for (const block of blocks) {
    const next = `${current}\n\n${block}`;
    if (next.length <= TELEGRAM_TEXT_LIMIT) {
      current = next;
    } else {
      texts.push(current);
      current = `${contHeader}\n\n${block}`;
    }
  }
  texts.push(current);

  return texts.map((text, i) => ({
    text,
    replyMarkup: i === texts.length - 1 ? feedbackKeyboard(input.topicId, input.reportId) : null,
  }));
}
