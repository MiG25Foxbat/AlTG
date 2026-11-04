import { Deal, STORE_LABELS, dealStatus } from '../../db/dealsRepo';
import { OutgoingPart, escapeHtml } from './messageFormat';
import { formatMoscowTime } from '../../utils/time';

/**
 * Короткое сообщение об акции (HTML для Bot API): магазин и скидка, заголовок,
 * промокод отдельной строкой в <code>, давность и срок, источник. Кнопка «Открыть».
 * Поля режем по длине до экранирования, так текст гарантированно короче 4096 (в худшем случае ~3000).
 */

const cut = (text: string, max: number) => escapeHtml(text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function agoText(unixSeconds: number, now: number): string {
  const min = Math.max(0, Math.floor((now - unixSeconds) / 60));
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  return min < 1440 ? `${Math.floor(min / 60)} ч назад` : `${Math.floor(min / 1440)} дн назад`;
}

export function buildDealMessage(deal: Deal, now: number): OutgoingPart {
  const head = [STORE_LABELS[deal.store], deal.discountText].filter(Boolean).map((t) => cut(t as string, 100)).join(' · ');
  const status = dealStatus(deal.publishedAt, deal.expiresAt, now);
  const when = [
    `🕒 ${agoText(deal.publishedAt, now)}`,
    deal.expiresAt ? `до ${formatMoscowTime(deal.expiresAt)} МСК` : null,
    status === 'maybe_over' ? 'могла закончиться' : status === 'expired' ? 'срок вышел' : null,
  ].filter(Boolean);

  const lines = [
    `🏷 <b>${head}</b>`,
    cut(deal.title, 200),
    deal.promoCode ? `\nПромокод:\n<code>${cut(deal.promoCode, 64)}</code>\n` : '',
    when.join(' · '),
    `Источник: ${cut(deal.sourceTitle, 100)}`,
  ];
  return {
    text: lines.join('\n'),
    replyMarkup: /^https?:\/\//i.test(deal.url) ? { inline_keyboard: [[{ text: 'Открыть', url: deal.url }]] } : null,
  };
}
