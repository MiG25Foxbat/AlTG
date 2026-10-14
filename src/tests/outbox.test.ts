import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import { getDb, closeDb } from '../db/database';
import { Destination } from '../db/destinationsRepo';
import { enqueueParts } from '../db/outboxRepo';
import { Notifier, OutgoingMessage, SendResult, TelegramNotifier } from '../modules/AlertModule/notifier';
import { processOutbox, RateLimiter, limitsFor } from '../modules/AlertModule/sender';

const T0 = 1_800_000_000; // unix-секунды

class FakeNotifier implements Notifier {
  calls: { chatId: number | null; message: OutgoingMessage }[] = [];
  constructor(private readonly respond: (d: Destination, callNo: number) => SendResult = () => ({ ok: true })) {}
  async send(d: Destination, message: OutgoingMessage): Promise<SendResult> {
    this.calls.push({ chatId: d.chatId, message });
    return this.respond(d, this.calls.length);
  }
}

async function destination(chatId: number, kind = 'telegram_private'): Promise<number> {
  const db = await getDb();
  const user = await db.execute({ sql: 'INSERT INTO users (created_at) VALUES (0)', args: [] });
  const r = await db.execute({
    sql: 'INSERT INTO alert_destinations (user_id, kind, chat_id, created_at) VALUES (?, ?, ?, 0)',
    args: [Number(user.lastInsertRowid), kind, chatId],
  });
  return Number(r.lastInsertRowid);
}

const part = (text: string) => ({ text, replyMarkup: null });

async function rows() {
  const db = await getDb();
  return (await db.execute('SELECT id, status, attempts, next_attempt_at, last_error FROM outbox ORDER BY id')).rows as any[];
}

const tick = (n: Notifier, l: RateLimiter, sec: number) => processOutbox(n, l, () => sec * 1000);

test('отправляет текст, звук и кнопки как есть; статус sent', async () => {
  const dest = await destination(100);
  const markup = { inline_keyboard: [[{ text: 'Реже', callback_data: 'fb:less:1:1' }]] };
  await enqueueParts(dest, [{ text: '<b>alert</b>', replyMarkup: markup }], true, T0);
  const n = new FakeNotifier();
  assert.equal(await tick(n, new RateLimiter(), T0), 1);
  const { textHtml, disableNotification, replyMarkup } = n.calls[0].message;
  assert.deepEqual({ textHtml, disableNotification, replyMarkup }, { textHtml: '<b>alert</b>', disableNotification: true, replyMarkup: markup });
  assert.equal((await rows())[0].status, 'sent');
  assert.equal(await tick(n, new RateLimiter(), T0 + 10), 0); // второй раз не уходит
  closeDb();
});

test('в один чат — не чаще 1 сообщения в секунду, части по порядку', async () => {
  const dest = await destination(100);
  await enqueueParts(dest, [part('p0'), part('p1'), part('p2')], false, T0);
  const n = new FakeNotifier();
  const l = new RateLimiter();
  assert.equal(await tick(n, l, T0), 1);
  assert.equal(await tick(n, l, T0 + 0.5), 0);
  assert.equal(await tick(n, l, T0 + 1), 1);
  assert.equal(await tick(n, l, T0 + 2), 1);
  assert.deepEqual(n.calls.map((c) => c.message.textHtml), ['p0', 'p1', 'p2']);
  closeDb();
});

test('429: весь чат ждёт retry_after, попытка не засчитывается, другие чаты идут', async () => {
  const a = await destination(1);
  const b = await destination(2);
  await enqueueParts(a, [part('a1'), part('a2')], false, T0);
  await enqueueParts(b, [part('b1')], false, T0);
  const n = new FakeNotifier((d, callNo) => (d.chatId === 1 && callNo === 1 ? { ok: false, kind: 'retry_after', seconds: 30 } : { ok: true }));
  const l = new RateLimiter();

  assert.equal(await tick(n, l, T0), 1); // b1
  const [a1, a2] = await rows();
  assert.deepEqual([a1.status, a1.attempts, a1.next_attempt_at], ['pending', 0, T0 + 30]);
  assert.equal(a2.next_attempt_at, T0 + 30);

  assert.equal(await tick(n, l, T0 + 10), 0);
  assert.equal(await tick(n, l, T0 + 30), 1);
  assert.equal(await tick(n, l, T0 + 31), 1);
  assert.deepEqual(n.calls.map((c) => c.message.textHtml), ['a1', 'b1', 'a1', 'a2']);
  closeDb();
});

test('403: получатель помечается blocked, его очередь — failed, больше не шлём', async () => {
  const dest = await destination(100);
  await enqueueParts(dest, [part('x'), part('y')], false, T0);
  const n = new FakeNotifier(() => ({ ok: false, kind: 'blocked' }));
  await tick(n, new RateLimiter(), T0);
  const db = await getDb();
  const status = (await db.execute({ sql: 'SELECT status FROM alert_destinations WHERE id = ?', args: [dest] })).rows[0] as any;
  assert.equal(status.status, 'blocked');
  assert.deepEqual((await rows()).map((r) => r.status), ['failed', 'failed']);

  await enqueueParts(dest, [part('z')], false, T0 + 5);
  assert.equal(await tick(n, new RateLimiter(), T0 + 5), 0);
  assert.equal(n.calls.length, 1);
  closeDb();
});

test('прочие ошибки: 3 повтора с паузами 30 с / 2 мин / 10 мин, затем failed; исключение = ошибка', async () => {
  const dest = await destination(100);
  await enqueueParts(dest, [part('x')], false, T0);
  const n = new FakeNotifier((_d, callNo) => {
    if (callNo === 1) throw new Error('boom');
    return { ok: false, kind: 'error', message: '500 Internal' };
  });
  const l = new RateLimiter();

  await tick(n, l, T0);
  assert.deepEqual([(await rows())[0].attempts, (await rows())[0].next_attempt_at], [1, T0 + 30]);
  assert.match((await rows())[0].last_error, /boom/);
  await tick(n, l, T0 + 29);
  assert.equal(n.calls.length, 1);
  await tick(n, l, T0 + 30);
  await tick(n, l, T0 + 150);
  await tick(n, l, T0 + 750);
  const [row] = await rows();
  assert.deepEqual([row.status, row.attempts, row.last_error], ['failed', 4, '500 Internal']);
  await tick(n, l, T0 + 5000);
  assert.equal(n.calls.length, 4);
  closeDb();
});

test('зависшие в sending дольше 5 минут возвращаются в очередь, свежие — нет', async () => {
  const dest = await destination(100);
  const other = await destination(200);
  await enqueueParts(dest, [part('stuck')], false, T0);
  await enqueueParts(other, [part('fresh')], false, T0);
  const db = await getDb();
  await db.execute({ sql: `UPDATE outbox SET status = 'sending', locked_at = ? WHERE text_html = 'stuck'`, args: [T0 - 301] });
  await db.execute({ sql: `UPDATE outbox SET status = 'sending', locked_at = ? WHERE text_html = 'fresh'`, args: [T0 - 299] });

  const n = new FakeNotifier();
  assert.equal(await tick(n, new RateLimiter(), T0), 1);
  assert.deepEqual(n.calls.map((c) => c.message.textHtml), ['stuck']);
  assert.deepEqual((await rows()).map((r) => r.status), ['sent', 'sending']);
  closeDb();
});

test('лимитер: не больше 25 в секунду на бота и 20 в минуту в группу', () => {
  const l = new RateLimiter();
  const privates = Array.from({ length: 30 }, (_, i) => ({ id: i, userId: 1, kind: 'telegram_private' as const, chatId: i, threadId: null, email: null }));
  assert.equal(privates.filter((d) => l.tryAcquire(limitsFor(d), 0)).length, 25);
  assert.equal(l.tryAcquire(limitsFor(privates[29]), 1000), true); // новое окно

  const g = new RateLimiter();
  const group = { id: 1, userId: 1, kind: 'telegram_group' as const, chatId: -100, threadId: 5, email: null };
  const allowed = Array.from({ length: 30 }, (_, s) => g.tryAcquire(limitsFor(group), s * 1000)).filter(Boolean).length;
  assert.equal(allowed, 20);
  assert.equal(g.tryAcquire(limitsFor(group), 60_000), true); // через минуту окно освободилось
});

test('TelegramNotifier: разбор ответов Bot API, параметры запроса, токен не утекает в ошибку', async () => {
  const dest = { id: 1, userId: 1, kind: 'telegram_group' as const, chatId: -100, threadId: 7, email: null };
  const msg = { textHtml: '<b>x</b>', disableNotification: true, replyMarkup: null };
  const reply = (status: number, body: object) => async () => new Response(JSON.stringify(body), { status });
  let sentBody: any;
  const ok = new TelegramNotifier('SECRET', (async (_url: string, init: any) => {
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as any);
  assert.deepEqual(await ok.send(dest, msg), { ok: true });
  assert.deepEqual(
    [sentBody.chat_id, sentBody.message_thread_id, sentBody.parse_mode, sentBody.disable_notification],
    [-100, 7, 'HTML', true]
  );

  const as = (f: any) => new TelegramNotifier('SECRET', f as any).send(dest, msg);
  assert.deepEqual(await as(reply(429, { ok: false, parameters: { retry_after: 12 } })), { ok: false, kind: 'retry_after', seconds: 12 });
  assert.deepEqual(await as(reply(403, { ok: false, description: 'Forbidden: bot was blocked by the user' })), { ok: false, kind: 'blocked' });
  const bad: any = await as(reply(400, { ok: false, description: "Bad Request: can't parse entities" }));
  assert.equal(bad.kind, 'error');
  const net: any = await as(async () => {
    throw new TypeError('fetch failed');
  });
  assert.equal(net.kind, 'error');
  for (const r of [bad, net]) assert.ok(!r.message.includes('SECRET'));
});
