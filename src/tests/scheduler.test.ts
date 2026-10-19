import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
delete process.env.MISTRAL_API_KEY;
delete process.env.GROQ_API_KEY;

import { getDb, closeDb } from '../db/database';
import { addTopic, updateTopic } from '../db/alertsRepo';
import { upsertChannel } from '../db/channelsRepo';
import { insertPosts } from '../db/postsRepo';
import { insertPrivatePosts } from '../db/privatePostsRepo';
import { linkPrivateChat, getLinkByChat, setPause } from '../db/destinationsRepo';
import { tryAcquireLease, releaseLease } from '../db/locksRepo';
import { schedulerTick, previewAlerts, SchedulerDeps } from '../modules/AlertModule/scheduler';
import { IUserBotReader } from '../modules/UserBotModule/IUserBotReader';

// Время в МСК → unix-секунды.
const msk = (iso: string) => Date.parse(`${iso}+03:00`) / 1000;
const DAY_14 = msk('2026-10-15T14:00:00');

const fakeUserBot: IUserBotReader = {
  resolveChannel: async () => ({ title: null }),
  getMessagesInWindow: async () => [], // посты кладём в БД сами
};

type SentPost = { index: number; text: string };
function fakeLlm(makeItems: (posts: SentPost[]) => unknown[]) {
  const calls: SentPost[][] = [];
  const generate = async (_topic: string, posts: SentPost[]) => {
    calls.push(posts);
    return makeItems(posts);
  };
  return { calls, generate };
}
/** Пункт на каждый пост: текст и цитата — дословно из поста, значит проверку проходит. */
const itemPerPost = (urgency = 'important') => (posts: SentPost[]) =>
  posts.map((p) => ({ text: p.text, source_ids: [p.index], quote: p.text.slice(0, 20), urgency }));

let msgId = 1;
async function post(channel: string, text: string, postedAt: number) {
  await insertPosts([{ channelUsername: channel, messageId: msgId++, text, postedAt }]);
}

async function setup(topicSettings: object = {}) {
  const db = await getDb();
  const userId = Number((await db.execute('INSERT INTO users (created_at) VALUES (0)')).lastInsertRowid);
  await linkPrivateChat(userId, 100, 0);
  await upsertChannel(userId, '@pub', 'Публичный');
  const topic = await addTopic(userId, 'ставка', { intervalMinutes: 15, quietEnabled: false, ...topicSettings });
  return { db, userId, topic };
}

const q = async (sql: string) => ((await (await getDb()).execute(sql)).rows as any[]);

test('проверка: один вызов LLM на подписку, отчёт уходит в outbox с кнопками; разобранные посты повторно в LLM не идут', async () => {
  const { topic } = await setup();
  // keyword-фильтр прототипа — подстрока темы, поэтому «ставка» в обоих постах дословно
  await post('@pub', 'ЦБ: ключевая ставка повышена до 21% годовых', DAY_14 - 300);
  await post('@pub', 'Ставка по ипотеке выросла до 25 процентов', DAY_14 - 200);
  const llm = fakeLlm(itemPerPost());
  const deps: SchedulerDeps = { userBot: fakeUserBot, generate: llm.generate };

  await schedulerTick(deps, DAY_14);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].length, 2);
  const [msg] = await q('SELECT text_html, disable_notification, reply_markup_json FROM outbox');
  assert.match(msg.text_html, /ЦБ: ключевая ставка повышена до 21%/);
  assert.match(msg.text_html, /href="https:\/\/t\.me\/pub\//);
  assert.equal(msg.disable_notification, 1); // important < порога urgent — без звука
  assert.match(msg.reply_markup_json, new RegExp(`fb:off:${topic.id}:`));
  assert.equal((await q('SELECT COUNT(*) AS n FROM topic_seen_posts WHERE report_id IS NOT NULL'))[0].n, 2);

  await schedulerTick(deps, DAY_14 + 60); // интервал 15 минут ещё не прошёл
  await schedulerTick(deps, DAY_14 + 15 * 60); // прошёл, но нового нет — LLM не зовём
  assert.equal(llm.calls.length, 1);
  assert.equal((await q(`SELECT last_run_at FROM topics`))[0].last_run_at, DAY_14 + 15 * 60);

  await post('@pub', 'Ставка осталась на уровне 21%', DAY_14 + 20 * 60);
  await schedulerTick(deps, DAY_14 + 30 * 60);
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(llm.calls[1].map((p) => p.text), ['Ставка осталась на уровне 21%']);
  assert.equal((await q('SELECT COUNT(*) AS n FROM outbox'))[0].n, 2);
  closeDb();
});

test('пункт не прошёл проверку — отчёта нет, посты всё равно разобраны', async () => {
  await setup();
  await post('@pub', 'ЦБ повысил ключевую ставку до 21% годовых', DAY_14 - 300);
  const llm = fakeLlm(() => [{ text: 'Ставка выросла до 99%', source_ids: [0], quote: 'повысил ключевую ставку', urgency: 'urgent' }]);
  await schedulerTick({ userBot: fakeUserBot, generate: llm.generate }, DAY_14);
  assert.equal((await q('SELECT COUNT(*) AS n FROM outbox'))[0].n, 0);
  assert.equal((await q('SELECT COUNT(*) AS n FROM alert_reports'))[0].n, 0);
  assert.deepEqual(await q('SELECT report_id FROM topic_seen_posts'), [{ report_id: null }]);
  closeDb();
});

test('ошибка LLM: следующая попытка через интервал с теми же постами', async () => {
  await setup();
  await post('@pub', 'ЦБ повысил ключевую ставку до 21% годовых', DAY_14 - 300);
  let fail = true;
  const calls: SentPost[][] = [];
  const generate = async (_t: string, posts: SentPost[]) => {
    calls.push(posts);
    if (fail) throw new Error('LLM 500');
    return itemPerPost()(posts);
  };
  await schedulerTick({ userBot: fakeUserBot, generate }, DAY_14);
  // окно первой проверки запомнено — пост не потеряется
  assert.deepEqual(await q('SELECT last_run_at, checked_until FROM topics'), [{ last_run_at: DAY_14, checked_until: DAY_14 - 15 * 60 }]);
  assert.equal((await q('SELECT COUNT(*) AS n FROM topic_seen_posts'))[0].n, 0);

  fail = false;
  await schedulerTick({ userBot: fakeUserBot, generate }, DAY_14 + 15 * 60);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].length, 1);
  assert.equal((await q('SELECT COUNT(*) AS n FROM outbox'))[0].n, 1);
  closeDb();
});

test('тихие часы: обычные отчёты копятся и приходят одним сообщением утром; громкое — сразу со звуком', async () => {
  const { topic, userId } = await setup({ quietEnabled: true, quietFrom: '23:00', quietTo: '08:00' });
  const night = msk('2026-10-15T23:30:00');
  const llm = fakeLlm(itemPerPost('normal'));
  const deps = { userBot: fakeUserBot, generate: llm.generate };

  await post('@pub', 'Ставка: первая ночная новость о 21%', night - 60);
  await schedulerTick(deps, night);
  await post('@pub', 'Ставка: вторая ночная новость о 22%', night + 10 * 60);
  await schedulerTick(deps, night + 15 * 60);
  assert.equal(llm.calls.length, 2);
  assert.equal((await q('SELECT COUNT(*) AS n FROM outbox'))[0].n, 0);
  assert.deepEqual(
    (await q(`SELECT DISTINCT hold_until FROM alert_reports WHERE status = 'held'`)).map((r) => r.hold_until),
    [msk('2026-10-16T08:00:00')]
  );

  await schedulerTick(deps, msk('2026-10-16T08:00:00'));
  const morning = await q('SELECT text_html, disable_notification FROM outbox');
  assert.equal(morning.length, 1); // одним сообщением
  assert.match(morning[0].text_html, /первая ночная[\s\S]*вторая ночная/);
  assert.equal(morning[0].disable_notification, 1);

  // громкое (порог normal) ночью — сразу и со звуком
  await updateTopic(userId, topic.id, { settings: { loudFrom: 'normal' } });
  const nextNight = msk('2026-10-16T23:45:00');
  await post('@pub', 'Ставка: срочно, ЦБ экстренно поднял до 30%', nextNight - 60);
  await schedulerTick(deps, nextNight);
  const loud = (await q('SELECT text_html, disable_notification FROM outbox ORDER BY id'))[1];
  assert.match(loud.text_html, /экстренно/);
  assert.equal(loud.disable_notification, 0);
  closeDb();
});

test('пауза, поставленная после отчёта, задерживает выпуск (задержка пересчитывается при выпуске)', async () => {
  await setup({ digestHours: 1 });
  const llm = fakeLlm(itemPerPost('normal'));
  await post('@pub', 'Ставка: новость для дайджеста про 21%', DAY_14 - 60);
  await schedulerTick({ userBot: fakeUserBot, generate: llm.generate }, DAY_14); // дайджест — ждёт до 15:00
  const link = (await getLinkByChat(100))!;
  await setPause(link.destinationId, msk('2026-10-15T16:00:00'));

  await schedulerTick({ userBot: fakeUserBot, generate: llm.generate }, msk('2026-10-15T15:00:00'));
  assert.equal((await q('SELECT COUNT(*) AS n FROM outbox'))[0].n, 0);
  assert.equal((await q('SELECT hold_until FROM alert_reports'))[0].hold_until, msk('2026-10-15T16:00:00'));
  await schedulerTick({ userBot: fakeUserBot, generate: llm.generate }, msk('2026-10-15T16:00:00'));
  assert.equal((await q('SELECT COUNT(*) AS n FROM outbox'))[0].n, 1);
  closeDb();
});

test('дневной лимит: после maxPerDay выпусков обычные ждут завтрашнего дня', async () => {
  await setup({ maxPerDay: 1 });
  const llm = fakeLlm(itemPerPost('normal'));
  const deps = { userBot: fakeUserBot, generate: llm.generate };
  await post('@pub', 'Ставка: первая дневная новость 21%', DAY_14 - 60);
  await schedulerTick(deps, DAY_14);
  await post('@pub', 'Ставка: вторая дневная новость 22%', DAY_14 + 5 * 60);
  await schedulerTick(deps, DAY_14 + 15 * 60);
  assert.equal((await q('SELECT COUNT(*) AS n FROM outbox'))[0].n, 1);
  assert.equal((await q(`SELECT hold_until FROM alert_reports WHERE status = 'held'`))[0].hold_until, msk('2026-10-16T00:00:00'));
  closeDb();
});

test('без привязанного бота подписки не проверяются', async () => {
  const db = await getDb();
  const userId = Number((await db.execute('INSERT INTO users (created_at) VALUES (0)')).lastInsertRowid);
  await upsertChannel(userId, '@pub', null);
  await addTopic(userId, 'ставка', { intervalMinutes: 15 });
  await post('@pub', 'ЦБ повысил ключевую ставку до 21% годовых', DAY_14 - 60);
  const llm = fakeLlm(itemPerPost());
  await schedulerTick({ userBot: fakeUserBot, generate: llm.generate }, DAY_14);
  assert.equal(llm.calls.length, 0);
  closeDb();
});

test('личная сессия отвалилась: приватная подписка на паузе, смешанная — по публичным с пометкой, напоминание раз в сутки', async () => {
  const { db, userId, topic: mixed } = await setup();
  await db.execute({
    sql: `INSERT INTO telegram_accounts (user_id, telegram_user_id, phone_number_encrypted, session_string_encrypted, session_status, connected_at)
          VALUES (?, 555, 'x', 'x', 'needs_reauth', 0)`,
    args: [userId],
  });
  await upsertChannel(userId, '-100777', 'Закрытый', true);
  const privateOnly = await addTopic(userId, 'приватная ставка', { intervalMinutes: 15, quietEnabled: false, scope: 'channels', channels: ['-100777'] });
  await insertPrivatePosts(userId, [{ channelIdentifier: '-100777', messageId: 1, text: 'Закрытая новость про ставку 21%', postedAt: DAY_14 - 60 }]);
  await post('@pub', 'Открытая новость про ставку 21%', DAY_14 - 60);

  const llm = fakeLlm(itemPerPost());
  const deps = { userBot: fakeUserBot, generate: llm.generate, siteUrl: 'https://alerts.example' };
  await schedulerTick(deps, DAY_14);

  assert.equal(llm.calls.length, 1); // только смешанная, и только по публичному посту
  assert.deepEqual(llm.calls[0].map((p) => p.text), ['Открытая новость про ставку 21%']);
  const lastRun = await q(`SELECT id, last_run_at FROM topics ORDER BY id`);
  assert.deepEqual(lastRun.map((r) => [r.id, r.last_run_at]), [[mixed.id, DAY_14], [privateOnly.id, null]]);

  const sent = await q('SELECT text_html FROM outbox ORDER BY id');
  const alert = sent.find((m) => m.text_html.includes('Открытая новость'));
  assert.match(alert.text_html, /Приватные каналы сейчас не проверяются — <a href="https:\/\/alerts\.example">/);
  assert.equal(sent.filter((m) => m.text_html.includes('отключился от сервиса')).length, 1);

  await schedulerTick(deps, DAY_14 + 3600);
  assert.equal((await q(`SELECT COUNT(*) AS n FROM outbox WHERE text_html LIKE '%отключился от сервиса%'`))[0].n, 1);
  await schedulerTick(deps, DAY_14 + 86400);
  assert.equal((await q(`SELECT COUNT(*) AS n FROM outbox WHERE text_html LIKE '%отключился от сервиса%'`))[0].n, 2);
  closeDb();
});

test('превью: тот же конвейер всухую — готовое сообщение, но ничего не пишет и не отправляет', async () => {
  const { userId } = await setup();
  await post('@pub', 'ЦБ повысил ключевую ставку до 21% годовых', DAY_14 - 60);
  const llm = fakeLlm(itemPerPost());
  const [result] = await previewAlerts({ userBot: fakeUserBot, generate: llm.generate }, userId, DAY_14);
  assert.equal(result.wouldSend, true);
  assert.match(result.messages![0], /ЦБ повысил ключевую ставку/);
  for (const table of ['outbox', 'alert_reports', 'topic_seen_posts']) {
    assert.equal((await q(`SELECT COUNT(*) AS n FROM ${table}`))[0].n, 0, table);
  }
  closeDb();
});

test('замок экземпляра: второй не берёт, пока первый продлевает; после истечения — берёт, старый теряет', async () => {
  const T = 1_000_000;
  assert.equal(await tryAcquireLease('worker', 'A', 60, T), true);
  assert.equal(await tryAcquireLease('worker', 'B', 60, T + 10), false);
  assert.equal(await tryAcquireLease('worker', 'A', 60, T + 20), true); // продление
  assert.equal(await tryAcquireLease('worker', 'B', 60, T + 79), false);
  assert.equal(await tryAcquireLease('worker', 'B', 60, T + 80), true); // истёк
  assert.equal(await tryAcquireLease('worker', 'A', 60, T + 81), false);
  await releaseLease('worker', 'A'); // чужой не снимает
  assert.equal(await tryAcquireLease('worker', 'A', 60, T + 82), false);
  await releaseLease('worker', 'B');
  assert.equal(await tryAcquireLease('worker', 'A', 60, T + 83), true);
  closeDb();
});

test('ошибки отвергнутой сессии распознаются; переподключение снимает needs_reauth и сбрасывает напоминание', async () => {
  const { randomBytes } = await import('node:crypto');
  process.env.SESSION_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
  const { isSessionRevokedError } = await import('../modules/FetchModule/fetchService');
  const { upsertAccount, markNeedsReauth, getSessionStatus } = await import('../db/telegramAccountsRepo');

  for (const code of ['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'USER_DEACTIVATED_BAN', 'AUTH_KEY_DUPLICATED']) {
    assert.equal(isSessionRevokedError({ errorMessage: code }), true, code);
  }
  assert.equal(isSessionRevokedError({ errorMessage: 'FLOOD_WAIT_30' }), false);
  assert.equal(isSessionRevokedError(new Error('CHANNEL_PRIVATE')), false);

  const db = await getDb();
  const userId = Number((await db.execute('INSERT INTO users (created_at) VALUES (0)')).lastInsertRowid);
  const account = { telegramUserId: 42, phoneNumber: '+70000000000', sessionString: 'old' };
  await upsertAccount(userId, account);
  await markNeedsReauth(userId);
  await db.execute({ sql: 'UPDATE telegram_accounts SET reauth_notified_at = 1 WHERE user_id = ?', args: [userId] });
  assert.equal(await getSessionStatus(userId), 'needs_reauth');

  await upsertAccount(userId, { ...account, sessionString: 'new' });
  assert.equal(await getSessionStatus(userId), 'active');
  assert.equal((await q('SELECT reauth_notified_at FROM telegram_accounts'))[0].reauth_notified_at, null);
  closeDb();
});
