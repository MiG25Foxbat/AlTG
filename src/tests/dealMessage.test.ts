import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Deal } from '../db/dealsRepo';
import { buildDealMessage } from '../modules/AlertModule/dealMessage';
import { TELEGRAM_TEXT_LIMIT } from '../modules/AlertModule/messageFormat';

const NOW = 1_800_000_000;

const deal = (patch: Partial<Deal> = {}): Deal => ({
  id: 1,
  sourceId: 1,
  sourceTitle: 'Pepper.ru',
  sourceUrl: 'https://www.pepper.ru/',
  store: 'goldapple',
  category: 'beauty',
  title: 'Минус 30% на уходовую косметику',
  url: 'https://goldapple.ru/promo?a=1&b=2',
  promoCode: 'PRIMER30',
  discountPercent: 30,
  discountText: '-30%',
  expiresAt: NOW + 3600,
  publishedAt: NOW - 5 * 60,
  foundAt: NOW - 4 * 60,
  status: 'live',
  ...patch,
});

test('сообщение об акции: магазин и скидка, промокод отдельной строкой в <code>, давность, источник, кнопка', () => {
  const part = buildDealMessage(deal(), NOW);
  assert.match(part.text, /<b>Золотое яблоко · -30%<\/b>/);
  assert.match(part.text, /^<code>PRIMER30<\/code>$/m);
  assert.match(part.text, /5 мин назад/);
  assert.match(part.text, /до \d\d\.\d\d, \d\d:\d\d МСК/);
  assert.match(part.text, /Источник: Pepper\.ru/);
  assert.deepEqual(part.replyMarkup, { inline_keyboard: [[{ text: 'Открыть', url: 'https://goldapple.ru/promo?a=1&b=2' }]] });
});

test('без промокода строки с <code> нет; срока нет и прошло больше 15 минут: «могла закончиться»', () => {
  const part = buildDealMessage(deal({ promoCode: null, expiresAt: null, publishedAt: NOW - 20 * 60 }), NOW);
  assert.doesNotMatch(part.text, /<code>/);
  assert.match(part.text, /20 мин назад · могла закончиться/);
});

test('HTML в полях экранируется, текст не длиннее 4096 даже на худших данных', () => {
  const evil = deal({ title: '<b>"&"</b>'.repeat(100), promoCode: '"<>"'.repeat(30), discountText: '"'.repeat(300), sourceTitle: '"'.repeat(300) });
  const part = buildDealMessage(evil, NOW);
  assert.doesNotMatch(part.text, /<b>"/);
  assert.ok(part.text.length <= TELEGRAM_TEXT_LIMIT, `длина ${part.text.length}`);
});

test('ссылка не http(s): кнопки нет', () => {
  assert.equal(buildDealMessage(deal({ url: 'javascript:alert(1)' }), NOW).replyMarkup, null);
});
