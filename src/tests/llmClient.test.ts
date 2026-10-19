import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MISTRAL_API_KEY = 'mistral-test-key';
process.env.GROQ_API_KEY = 'groq-test-key';
delete process.env.MISTRAL_MODEL;
delete process.env.GROQ_MODEL;

import { LlmClient, LlmDeps, LlmQuotaError, LlmConfigError, ChatMessage, generateAlertReport, summarizePosts } from '../modules/AiModule/llmClient';

type Step = (init: any) => Response | Promise<Response>;

const ok = (obj: object): Step => () =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), { status: 200 });
const status = (code: number, headers: Record<string, string> = {}): Step => () => new Response('{"error":"x"}', { status: code, headers });
const hang: Step = (init) =>
  new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

/** Фейковый fetch по сценарию на каждого провайдера + часы, которые двигает sleep. */
function harness(script: { mistral?: Step[]; groq?: Step[] }, over: Partial<LlmDeps> = {}) {
  const calls: { provider: string; auth: string; body: any }[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const queues: Record<string, Step[]> = { mistral: [...(script.mistral ?? [])], groq: [...(script.groq ?? [])] };
  const fetchFn = async (url: string, init: any) => {
    const provider = url.startsWith('https://api.mistral.ai/') ? 'mistral' : url.startsWith('https://api.groq.com/') ? 'groq' : url;
    calls.push({ provider, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    const step = queues[provider]?.shift();
    if (!step) throw new Error(`в сценарии нет ответа для ${provider}`);
    return step(init);
  };
  const client = new LlmClient({
    fetch: fetchFn as any,
    // Часы сдвигаются не сразу, а после микрозадачи — как настоящие: параллельные
    // вызовы, вставшие в очередь синхронно, видят одно и то же «сейчас».
    sleep: async (ms) => {
      sleeps.push(ms);
      const until = clock + ms;
      await Promise.resolve();
      clock = Math.max(clock, until);
    },
    now: () => clock,
    timeoutMs: 30_000,
    mistralMinIntervalMs: 1000,
    retryDelaysMs: [2000, 4000, 8000],
    ...over,
  });
  const count = (provider: string) => calls.filter((c) => c.provider === provider).length;
  return { client, calls, sleeps, count };
}

const MSGS: ChatMessage[] = [
  { role: 'system', content: 'Отвечай JSON' },
  { role: 'user', content: 'посты' },
];

test('Mistral первым: Bearer-ключ, модель по умолчанию или из MISTRAL_MODEL, json_object, сообщения как есть', async () => {
  const h = harness({ mistral: [ok({ a: 1 }), ok({ a: 2 })] });
  assert.deepEqual(await h.client.completeJson(MSGS, 0.1), { a: 1 });
  const [call] = h.calls;
  assert.equal(call.auth, 'Bearer mistral-test-key');
  assert.equal(call.body.model, 'mistral-medium-latest');
  assert.deepEqual(call.body.response_format, { type: 'json_object' });
  assert.deepEqual(call.body.messages, MSGS);
  assert.equal(call.body.temperature, 0.1);

  process.env.MISTRAL_MODEL = 'mistral-small-latest';
  try {
    await h.client.completeJson(MSGS, 0.1);
    assert.equal(h.calls[1].body.model, 'mistral-small-latest');
  } finally {
    delete process.env.MISTRAL_MODEL;
  }
  assert.equal(h.count('groq'), 0);
});

test('429 с retry-after — ждём ровно столько и повторяем Mistral', async () => {
  const h = harness({ mistral: [status(429, { 'retry-after': '3' }), ok({ a: 2 })] });
  assert.deepEqual(await h.client.completeJson(MSGS, 0.1), { a: 2 });
  assert.deepEqual(h.sleeps, [3000]);
  assert.equal(h.count('groq'), 0);
});

test('429 без retry-after: повторы через 2, 4, 8 с, потом тот же запрос в Groq (gpt-oss-120b)', async () => {
  const h = harness({ mistral: [status(429), status(429), status(429), status(429)], groq: [ok({ b: 1 })] });
  assert.deepEqual(await h.client.completeJson(MSGS, 0.1), { b: 1 });
  assert.deepEqual(h.sleeps, [2000, 4000, 8000]);
  assert.equal(h.count('mistral'), 4);
  const groqCall = h.calls.at(-1)!;
  assert.deepEqual(
    [groqCall.provider, groqCall.auth, groqCall.body.model, groqCall.body.response_format],
    ['groq', 'Bearer groq-test-key', 'openai/gpt-oss-120b', { type: 'json_object' }]
  );
  assert.deepEqual(groqCall.body.messages, MSGS);
});

test('огромный retry-after (кончилась квота) не ждём — сразу Groq', async () => {
  const h = harness({ mistral: [status(429, { 'retry-after': '3600' })], groq: [ok({ b: 2 })] });
  assert.deepEqual(await h.client.completeJson(MSGS, 0.1), { b: 2 });
  assert.deepEqual(h.sleeps, []);
});

test('таймаут Mistral — без повторов сразу в Groq', async () => {
  const h = harness({ mistral: [hang], groq: [ok({ c: 1 })] }, { timeoutMs: 30 });
  assert.deepEqual(await h.client.completeJson(MSGS, 0.1), { c: 1 });
  assert.equal(h.count('mistral'), 1);
});

test('прочие ошибки Mistral (5xx, неверный ключ, сеть, не JSON) — сразу в Groq', async () => {
  const failures: Step[] = [
    status(500),
    status(401),
    () => {
      throw new TypeError('fetch failed');
    },
    () => new Response(JSON.stringify({ choices: [{ message: { content: 'это не json' } }] }), { status: 200 }),
  ];
  for (const failure of failures) {
    const h = harness({ mistral: [failure], groq: [ok({ d: 1 })] });
    assert.deepEqual(await h.client.completeJson(MSGS, 0.1), { d: 1 });
    assert.equal(h.count('mistral'), 1);
    assert.deepEqual(h.sleeps, []);
  }
});

test('Groq тоже не ответил — отказ без повторов; 429 у Groq — LlmQuotaError; ключи не попадают в ошибку', async () => {
  const failed = harness({ mistral: [status(500)], groq: [status(503)] });
  await assert.rejects(failed.client.completeJson(MSGS, 0.1), (error: Error) => {
    assert.match(error.message, /ИИ сейчас не отвечает/);
    assert.ok(!error.message.includes('test-key'));
    return true;
  });
  assert.equal(failed.count('groq'), 1);

  const quota = harness({ mistral: [status(429), status(429), status(429), status(429)], groq: [status(429)] });
  await assert.rejects(quota.client.completeJson(MSGS, 0.1), LlmQuotaError);
  assert.equal(quota.count('groq'), 1);
});

test('общая очередь Mistral: параллельные запросы — не чаще интервала из конфига', async () => {
  const h = harness({ mistral: [ok({}), ok({}), ok({})] });
  await Promise.all([h.client.completeJson(MSGS, 0.1), h.client.completeJson(MSGS, 0.1), h.client.completeJson(MSGS, 0.1)]);
  assert.deepEqual(h.sleeps, [1000, 2000]);

  const fast = harness({ mistral: [ok({}), ok({})] }, { mistralMinIntervalMs: 250 });
  await Promise.all([fast.client.completeJson(MSGS, 0.1), fast.client.completeJson(MSGS, 0.1)]);
  assert.deepEqual(fast.sleeps, [250]);
});

test('ключей нет — понятная LlmConfigError; есть только GROQ_API_KEY — сразу Groq', async () => {
  const saved = { m: process.env.MISTRAL_API_KEY, g: process.env.GROQ_API_KEY };
  try {
    delete process.env.MISTRAL_API_KEY;
    const onlyGroq = harness({ groq: [ok({ e: 1 })] });
    assert.deepEqual(await onlyGroq.client.completeJson(MSGS, 0.1), { e: 1 });
    assert.equal(onlyGroq.count('mistral'), 0);

    delete process.env.GROQ_API_KEY;
    await assert.rejects(harness({}).client.completeJson(MSGS, 0.1), (error: Error) => {
      assert.ok(error instanceof LlmConfigError);
      assert.match(error.message, /MISTRAL_API_KEY/);
      return true;
    });
  } finally {
    process.env.MISTRAL_API_KEY = saved.m;
    process.env.GROQ_API_KEY = saved.g;
  }
});

test('отчёт алерта и поиск: системный промпт требует JSON с нашими полями, посты — в сообщении пользователя', async () => {
  const h = harness({
    mistral: [
      ok({ items: [{ text: 'x', source_ids: [0], quote: 'q', urgency: 'normal' }] }),
      ok({ items: 'не массив' }),
      ok({ summary: 'итог', relevant: [{ index: 0, gist: 'по теме' }] }),
    ],
  });
  const posts = [{ index: 0, text: 'ЦБ повысил ставку' }];

  assert.deepEqual(await generateAlertReport('ставка', posts, h.client), [{ text: 'x', source_ids: [0], quote: 'q', urgency: 'normal' }]);
  const [system, user] = h.calls[0].body.messages;
  assert.equal(system.role, 'system');
  for (const field of ['JSON', '"items"', '"source_ids"', '"quote"', '"urgency"']) assert.ok(system.content.includes(field), field);
  assert.ok(user.content.includes('"ставка"') && user.content.includes('[0] ЦБ повысил ставку'));
  assert.equal(h.calls[0].body.temperature, 0.1);

  assert.deepEqual(await generateAlertReport('ставка', posts, h.client), []);

  assert.deepEqual(await summarizePosts('ставка', posts, h.client), { summary: 'итог', relevant: [{ index: 0, gist: 'по теме' }] });
  const searchSystem = h.calls[2].body.messages[0].content;
  for (const field of ['JSON', '"summary"', '"relevant"', '"index"', '"gist"']) assert.ok(searchSystem.includes(field), field);
});
