import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAlertMessages, escapeHtml, TELEGRAM_TEXT_LIMIT, MessageItem } from '../modules/AlertModule/messageFormat';

const NOW = Date.UTC(2026, 9, 15, 11, 30) / 1000; // 14:30 МСК
const source = (n: number, title: string | null = `Канал ${n}`) => ({
  channel: `@ch${n}`,
  channelTitle: title,
  link: `https://t.me/ch${n}/${n}`,
  postedAt: NOW - 600,
});
const item = (text: string, over: Partial<MessageItem> = {}): MessageItem => ({
  text,
  urgency: 'normal',
  sources: [source(1)],
  ...over,
});
const base = { topicId: 7, topicLabel: 'ставка ЦБ', reportId: 42, now: NOW };

test('escapeHtml: &, <, >, кавычки', () => {
  assert.equal(escapeHtml(`<b>"A" & B</b>`), '&lt;b&gt;&quot;A&quot; &amp; B&lt;/b&gt;');
});

test('шапка с темой и временем МСК, под пунктом — ссылка на пост с каналом и временем поста', () => {
  const [part] = buildAlertMessages({ ...base, items: [item('ЦБ повысил ставку', { urgency: 'urgent' })] });
  assert.match(part.text, /^🔔 <b>ставка ЦБ<\/b>\n<i>15\.10, 14:30 МСК<\/i>/);
  assert.match(part.text, /🔴 ЦБ повысил ставку\n↳ <a href="https:\/\/t\.me\/ch1\/1">Канал 1 · 15\.10, 14:20<\/a>/);
});

test('текст модели, тема и названия каналов экранируются; без названия — имя канала', () => {
  const [part] = buildAlertMessages({
    ...base,
    topicLabel: '<i>тема</i>',
    items: [item('<script>alert(1)</script> & "x"', { sources: [source(1, '<b>Канал</b>'), source(2, null)] })],
  });
  assert.ok(!part.text.includes('<script>'));
  assert.ok(part.text.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;'));
  assert.ok(part.text.includes('&lt;i&gt;тема&lt;/i&gt;'));
  assert.ok(part.text.includes('&lt;b&gt;Канал&lt;/b&gt; · '));
  assert.ok(part.text.includes('>@ch2 · '));
});

test('больше 5 источников — 5 ссылок и «и ещё N»', () => {
  const sources = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => source(n));
  const [part] = buildAlertMessages({ ...base, items: [item('много', { sources })] });
  assert.equal((part.text.match(/<a /g) || []).length, 5);
  assert.ok(part.text.includes(' и ещё 3'));
});

test('длинный отчёт режется на части по пунктам: каждая ≤ 4096, пункты целиком и по порядку, кнопки только под последней', () => {
  const items = Array.from({ length: 12 }, (_, i) => item(`Пункт ${i} ` + 'x'.repeat(900)));
  const parts = buildAlertMessages({ ...base, items, reconnectUrl: 'https://app.example/?tab=telegram' });
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.text.length <= TELEGRAM_TEXT_LIMIT, `часть длиной ${p.text.length}`);

  const all = parts.map((p) => p.text).join('\n');
  const order = items.map((_, i) => all.indexOf(`Пункт ${i} `));
  assert.ok(order.every((pos, i) => pos >= 0 && (i === 0 || pos > order[i - 1])));
  for (let i = 0; i < 12; i++) assert.equal(parts.filter((p) => p.text.includes(`Пункт ${i} `)).length, 1);

  assert.ok(parts.slice(0, -1).every((p) => p.replyMarkup === null));
  assert.ok(parts[1].text.startsWith('🔔 <b>ставка ЦБ</b> <i>(продолжение)</i>'));
  assert.ok(parts.at(-1)!.text.includes('Приватные каналы сейчас не проверяются'));
  assert.equal(parts.filter((p) => p.text.includes('Приватные каналы')).length, 1);
});

test('кнопки обратной связи: три действия, callback_data ≤ 64 байт даже с большими id', () => {
  const [part] = buildAlertMessages({ ...base, topicId: 2 ** 53 - 1, reportId: 2 ** 53 - 1, items: [item('x')] });
  const buttons = part.replyMarkup!.inline_keyboard.flat();
  assert.deepEqual(buttons.map((b) => b.text), ['Не релевантно', 'Реже', 'Отключить тему']);
  for (const b of buttons) assert.ok(Buffer.byteLength(b.callback_data!) <= 64, b.callback_data);
  assert.equal(buttons[2].callback_data, `fb:off:${2 ** 53 - 1}:${2 ** 53 - 1}`);
});

test('пункт из одних спецсимволов не вылезает за лимит после экранирования', () => {
  const parts = buildAlertMessages({ ...base, items: [item('&'.repeat(1000)), item('<'.repeat(1000))] });
  for (const p of parts) assert.ok(p.text.length <= TELEGRAM_TEXT_LIMIT);
  assert.ok(!/&(?![a-z]+;)/.test(parts.map((p) => p.text).join(''))); // ни одной разрезанной сущности
});
