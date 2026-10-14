import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
delete process.env.PUBLIC_BASE_URL;

import { getDb, closeDb } from '../db/database';
import { addTopic, getTopic, updateTopic } from '../db/alertsRepo';
import {
  createLinkToken,
  getLinkByChat,
  getLinkByUser,
  linkPrivateChat,
  setPrivateChatStatus,
  LINK_TOKEN_TTL_SEC,
} from '../db/destinationsRepo';
import { enqueueParts } from '../db/outboxRepo';
import { handleStart, handleCallback } from '../modules/BotModule/botActions';
import { nextMoscowMorning } from '../utils/time';

const NOW = 1_800_000_000;

async function user(): Promise<number> {
  const db = await getDb();
  return Number((await db.execute('INSERT INTO users (created_at) VALUES (0)')).lastInsertRowid);
}

async function connectTelegram(userId: number, telegramUserId: number) {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO telegram_accounts (user_id, telegram_user_id, phone_number_encrypted, session_string_encrypted, connected_at)
          VALUES (?, ?, 'x', 'x', 0)`,
    args: [userId, telegramUserId],
  });
}

async function feedbackActions() {
  const db = await getDb();
  return (await db.execute('SELECT action, report_id FROM alert_feedback ORDER BY id')).rows.map((r: any) => [r.action, r.report_id]);
}

test('nextMoscowMorning: до 09:00 МСК — сегодня, ровно в 09:00 и позже — завтра', () => {
  const at = (iso: string) => Date.parse(iso) / 1000;
  assert.equal(nextMoscowMorning(at('2026-10-14T23:00:00Z')), at('2026-10-15T06:00:00Z')); // 02:00 МСК
  assert.equal(nextMoscowMorning(at('2026-10-15T06:00:00Z')), at('2026-10-16T06:00:00Z')); // 09:00 МСК
  assert.equal(nextMoscowMorning(at('2026-10-15T17:00:00Z')), at('2026-10-16T06:00:00Z')); // 20:00 МСК
});

test('/start без токена: находит пользователя по подключённому Telegram, привязывает чат, считает активные темы', async () => {
  const u = await user();
  await connectTelegram(u, 555);
  await addTopic(u, 'нефть');
  await addTopic(u, 'ставка');
  const off = await addTopic(u, 'выключенная');
  await updateTopic(u, off.id, { isActive: false });

  const view = await handleStart(555, 555, '', NOW);
  assert.match(view.text, /алерты по 2 темам/);
  const link = await getLinkByChat(555);
  assert.deepEqual([link?.userId, link?.status], [u, 'active']);

  const stranger = await handleStart(777, 777, '', NOW);
  assert.match(stranger.text, /Не нашёл ваш аккаунт/);
  assert.equal(await getLinkByChat(777), undefined);
  closeDb();
});

test('/start с токеном: одноразовый, живёт 15 минут, в БД только хеш; чат переезжает к новому аккаунту', async () => {
  const a = await user();
  const b = await user();
  const token = await createLinkToken(a, NOW);
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  const db = await getDb();
  const stored = (await db.execute('SELECT token_hash FROM bot_link_tokens')).rows[0] as any;
  assert.notEqual(stored.token_hash, token);

  assert.match((await handleStart(900, 900, token, NOW + 60)).text, /^Готово/);
  assert.equal((await getLinkByChat(900))?.userId, a);
  assert.match((await handleStart(900, 900, token, NOW + 61)).text, /устарела или уже использована/);

  const expired = await createLinkToken(b, NOW);
  assert.match((await handleStart(900, 900, expired, NOW + LINK_TOKEN_TTL_SEC + 1)).text, /устарела/);
  assert.match((await handleStart(900, 900, 'bad token!', NOW)).text, /повреждена/);
  assert.equal((await getLinkByChat(900))?.userId, a);

  await handleStart(900, 900, await createLinkToken(b, NOW), NOW + 10);
  assert.equal((await getLinkByChat(900))?.userId, b);
  assert.equal(await getLinkByUser(a), undefined); // один чат — один пользователь
  closeDb();
});

test('кнопки под алертом: «Реже» на шаг + отмена, на максимуме — нельзя; «Отключить» + включить обратно; всё в feedback', async () => {
  const u = await user();
  await linkPrivateChat(u, 100, NOW);
  const t = await addTopic(u, 'нефть');

  const less = await handleCallback(100, `fb:less:${t.id}:5`, NOW);
  assert.match(less.reply!.text, /теперь проверяю раз в 3 часа/);
  assert.equal(less.reply!.keyboard!.inline_keyboard[0][0].callback_data, `undo:less:${t.id}:60`);
  assert.equal((await getTopic(u, t.id))!.settings.intervalMinutes, 180);

  const undo = await handleCallback(100, `undo:less:${t.id}:60`, NOW);
  assert.match(undo.edit!.text, /вернул проверку раз в час/);
  assert.equal((await getTopic(u, t.id))!.settings.intervalMinutes, 60);

  await updateTopic(u, t.id, { settings: { intervalMinutes: 1440 } });
  assert.match((await handleCallback(100, `fb:less:${t.id}:5`, NOW)).toast!, /Реже уже нельзя/);
  assert.equal((await getTopic(u, t.id))!.settings.intervalMinutes, 1440);

  const off = await handleCallback(100, `fb:off:${t.id}:6`, NOW);
  assert.match(off.reply!.text, /отключена/);
  assert.equal((await getTopic(u, t.id))!.isActive, false);
  await handleCallback(100, `undo:off:${t.id}`, NOW);
  assert.equal((await getTopic(u, t.id))!.isActive, true);

  assert.equal((await handleCallback(100, `fb:nr:${t.id}:7`, NOW)).toast, 'Спасибо, учту');
  assert.deepEqual(await feedbackActions(), [
    ['less_often', 5],
    ['undo_less_often', null],
    ['less_often', 5],
    ['disable_topic', 6],
    ['undo_disable_topic', null],
    ['not_relevant', 7],
  ]);
  closeDb();
});

test('чужие темы, мусорные и устаревшие кнопки ничего не меняют; непривязанный чат', async () => {
  const a = await user();
  const b = await user();
  await linkPrivateChat(a, 1, NOW);
  const foreign = await addTopic(b, 'чужая');
  const own = await addTopic(a, 'своя');

  assert.match((await handleCallback(1, `fb:off:${foreign.id}:1`, NOW)).toast!, /Тема не найдена/);
  assert.equal((await getTopic(b, foreign.id))!.isActive, true);
  for (const data of ['tp:i:abc:60', `tp:i:${own.id}:7`, `undo:less:${own.id}:99`, `tp:l:${own.id}:panic`, `zz:${own.id}`, 'pz:forever']) {
    assert.equal((await handleCallback(1, data, NOW)).toast, 'Кнопка устарела', data);
  }
  assert.equal((await getTopic(a, own.id))!.settings.intervalMinutes, 60);
  assert.match((await handleCallback(2, `fb:nr:${own.id}:1`, NOW)).toast!, /не привязан/);
  assert.deepEqual(await feedbackActions(), []);
  closeDb();
});

test('экран тем: вкл/выкл, частота проверки и порог звука', async () => {
  const u = await user();
  await linkPrivateChat(u, 100, NOW);
  const t = await addTopic(u, 'нефть');

  const toggled = await handleCallback(100, `tp:t:${t.id}`, NOW);
  assert.equal((await getTopic(u, t.id))!.isActive, false);
  assert.ok(toggled.edit!.keyboard!.inline_keyboard[0][0].text.startsWith('⏸'));

  const interval = await handleCallback(100, `tp:i:${t.id}:180`, NOW);
  assert.match(interval.edit!.text, /раз в 3 часа/);
  await handleCallback(100, `tp:l:${t.id}:important`, NOW);
  const s = (await getTopic(u, t.id))!.settings;
  assert.deepEqual([s.intervalMinutes, s.loudFrom], [180, 'important']);
  assert.match((await handleCallback(100, `tp:s:${t.id}`, NOW)).edit!.text, /нефть/);
  closeDb();
});

test('пауза: на час, до утра (точное время в ответе), снять', async () => {
  const u = await user();
  await linkPrivateChat(u, 100, NOW);
  const pausedUntil = async () => (await getLinkByChat(100))!.pausedUntil;

  assert.match((await handleCallback(100, 'pz:1h', NOW)).toast!, /^Пауза до \d\d\.\d\d, \d\d:\d\d МСК$/);
  assert.equal(await pausedUntil(), NOW + 3600);
  const am = await handleCallback(100, 'pz:am', NOW);
  assert.equal(await pausedUntil(), nextMoscowMorning(NOW));
  assert.ok(am.edit!.keyboard!.inline_keyboard.flat().some((b) => b.callback_data === 'pz:off'));
  assert.equal((await handleCallback(100, 'pz:off', NOW)).toast, 'Пауза снята');
  assert.equal(await pausedUntil(), null);
  closeDb();
});

test('my_chat_member: kicked — получатель blocked и его очередь снята; member — снова active', async () => {
  const u = await user();
  await linkPrivateChat(u, 100, NOW);
  const link = (await getLinkByChat(100))!;
  await enqueueParts(link.destinationId, [{ text: 'x', replyMarkup: null }], false, NOW);

  await setPrivateChatStatus(100, 'blocked');
  assert.equal((await getLinkByChat(100))!.status, 'blocked');
  const db = await getDb();
  assert.equal(((await db.execute('SELECT status FROM outbox')).rows[0] as any).status, 'failed');

  await setPrivateChatStatus(100, 'active');
  assert.equal((await getLinkByChat(100))!.status, 'active');
  await setPrivateChatStatus(404, 'blocked'); // чужой/непривязанный чат — без ошибок
  closeDb();
});

test('webhook: без верного X-Telegram-Bot-Api-Secret-Token — 401, с ним апдейт доходит до бота', async () => {
  const { Bot, webhookCallback } = await import('grammy');
  const { createApp } = await import('../app');
  const bot = new Bot('1:test', { botInfo: { id: 1, is_bot: true, first_name: 'b', username: 'test_bot' } as any });
  const seen: string[] = [];
  bot.on('message:text', (ctx) => {
    seen.push(ctx.message.text);
  });
  const app = await createApp({} as any, {
    username: 'test_bot',
    webhookHandler: webhookCallback(bot, 'express', { secretToken: 's3cret' }) as any,
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const url = `http://127.0.0.1:${(server.address() as any).port}/telegram/webhook`;
  const update = {
    update_id: 1,
    message: { message_id: 1, date: 0, chat: { id: 5, type: 'private' }, from: { id: 5, is_bot: false, first_name: 'u' }, text: 'привет' },
  };
  const post = (secret?: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) },
      body: JSON.stringify(update),
    });
  try {
    assert.equal((await post()).status, 401);
    assert.equal((await post('wrong')).status, 401);
    assert.deepEqual(seen, []);
    assert.equal((await post('s3cret')).status, 200);
    assert.deepEqual(seen, ['привет']);
  } finally {
    server.close();
    closeDb();
  }
});
