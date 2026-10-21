import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'gemini-test-key';
process.env.OPEN_ROUTER_API_KEY = 'router-test-key';
delete process.env.GEMINI_MODEL;

import { LlmClient, LlmDeps, LlmQuotaError, LlmConfigError, ChatMessage, generateAlertReport, summarizePosts } from '../modules/AiModule/llmClient';

type Step = (init: any) => Response | Promise<Response>;

/** Ответ Gemini (generateContent) и OpenRouter (OpenAI-формат) с JSON модели внутри. */
const geminiOk = (obj: object): Step => () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status: 200 });
const routerOk = (obj: object): Step => () =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), { status: 200 });
const status = (code: number, headers: Record<string, string> = {}, body = '{"error":"x"}'): Step => () =>
  new Response(body, { status: code, headers });
const hang: Step = (init) =>
  new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

/** Фейковый fetch по сценарию на каждого провайдера + часы, которые двигает sleep. */
function harness(script: { gemini?: Step[]; router?: Step[] }, over: Partial<LlmDeps> = {}) {
  const calls: { provider: string; url: string; headers: Record<string, string>; body: any }[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const queues: Record<string, Step[]> = { gemini: [...(script.gemini ?? [])], router: [...(script.router ?? [])] };
  const fetchFn = async (url: string, init: any) => {
    const provider = url.startsWith('https://generativelanguage.googleapis.com/')
      ? 'gemini'
      : url.startsWith('https://openrouter.ai/')
        ? 'router'
        : url;
    calls.push({ provider, url, headers: init.headers, body: JSON.parse(init.body) });
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
    geminiMinIntervalMs: 1000,
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

test('Gemini первым: ключ в заголовке (не в URL), модель по умолчанию или из GEMINI_MODEL, JSON-режим, system отдельно', async () => {
  const h = harness({ gemini: [geminiOk({ a: 1 }), geminiOk({ a: 2 })] });
  assert.deepEqual(await h.client.completeJson(MSGS, 0.1), { a: 1 });
  const [call] = h.calls;
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(call.headers['x-goog-api-key'], 'gemini-test-key');
  assert.ok(!call.url.includes('test-key'));
  assert.deepEqual(call.body.systemInstruction, { parts: [{ text: 'Отвечай JSON' }] });
  assert.deepEqual(call.body.contents, [{ role: 'user', parts: [{ text: 'посты' }] }]);
  assert.deepEqual(call.body.generationConfig, { responseMimeType: 'application/json', temperature: 0.1 });

  process.env.GEMINI_MODEL = 'gemini-3.5-flash';
  try {
    await h.client.completeJson(MSGS, 0.1);
    assert.match(h.calls[1].url, /models\/gemini-3\.5-flash:generateContent$/);
  } finally {
    delete process.env.GEMINI_MODEL;
  }
  assert.equal(h.count('router'), 0);
});

test('429 с retry-after или retryDelay в теле Google — ждём ровно столько и повторяем Gemini', async () => {
  const header = harness({ gemini: [status(429, { 'retry-after': '3' }), geminiOk({ a: 2 })] });
  assert.deepEqual(await header.client.completeJson(MSGS, 0.1), { a: 2 });
  assert.deepEqual(header.sleeps, [3000]);

  const googleBody = '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"5s"}]}}';
  const body = harness({ gemini: [status(429, {}, googleBody), geminiOk({ a: 3 })] });
  assert.deepEqual(await body.client.completeJson(MSGS, 0.1), { a: 3 });
  assert.deepEqual(body.sleeps, [5000]);
  assert.equal(header.count('router') + body.count('router'), 0);
});

test('429 без подсказки: повторы через 2, 4, 8 с, потом тот же запрос через OpenRouter в ту же модель', async () => {
  const h = harness({ gemini: [status(429), status(429), status(429), status(429)], router: [routerOk({ b: 1 })] });
  assert.deepEqual(await h.client.completeJson(MSGS, 0.1), { b: 1 });
  assert.deepEqual(h.sleeps, [2000, 4000, 8000]);
  assert.equal(h.count('gemini'), 4);
  const routerCall = h.calls.at(-1)!;
  assert.equal(routerCall.headers.Authorization, 'Bearer router-test-key');
  assert.deepEqual(
    [routerCall.body.model, routerCall.body.response_format, routerCall.body.max_tokens, routerCall.body.temperature],
    ['google/gemini-3.5-flash-lite', { type: 'json_object' }, 8192, 0.1]
  );
  assert.deepEqual(routerCall.body.messages, MSGS);
});

test('огромная задержка (кончилась дневная квота) не ждём — сразу OpenRouter', async () => {
  const h = harness({ gemini: [status(429, { 'retry-after': '3600' })], router: [routerOk({ b: 2 })] });
  assert.deepEqual(await h.client.completeJson(MSGS, 0.1), { b: 2 });
  assert.deepEqual(h.sleeps, []);
});

test('таймаут Gemini — без повторов сразу OpenRouter', async () => {
  const h = harness({ gemini: [hang], router: [routerOk({ c: 1 })] }, { timeoutMs: 30 });
  assert.deepEqual(await h.client.completeJson(MSGS, 0.1), { c: 1 });
  assert.equal(h.count('gemini'), 1);
});

test('прочие ошибки Gemini (российский IP, 5xx, сеть, пустой ответ, не JSON) — сразу OpenRouter', async () => {
  const failures: Step[] = [
    status(400, {}, '{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}'),
    status(500),
    () => {
      throw new TypeError('fetch failed');
    },
    () => new Response(JSON.stringify({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 }),
    () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'это не json' }] } }] }), { status: 200 }),
  ];
  for (const failure of failures) {
    const h = harness({ gemini: [failure], router: [routerOk({ d: 1 })] });
    assert.deepEqual(await h.client.completeJson(MSGS, 0.1), { d: 1 });
    assert.equal(h.count('gemini'), 1);
    assert.deepEqual(h.sleeps, []);
  }
});

test('OpenRouter тоже не ответил — отказ без повторов; 429 у него — LlmQuotaError; ключи не попадают в ошибку', async () => {
  const failed = harness({ gemini: [status(500)], router: [status(402, {}, '{"error":{"message":"requires more credits"}}')] });
  await assert.rejects(failed.client.completeJson(MSGS, 0.1), (error: Error) => {
    assert.match(error.message, /ИИ сейчас не отвечает/);
    assert.match(error.message, /402/);
    assert.ok(!error.message.includes('test-key'));
    return true;
  });
  assert.equal(failed.count('router'), 1);

  const quota = harness({ gemini: [status(429), status(429), status(429), status(429)], router: [status(429)] });
  await assert.rejects(quota.client.completeJson(MSGS, 0.1), LlmQuotaError);
});

test('общая очередь Gemini: параллельные запросы — не чаще интервала из конфига', async () => {
  const h = harness({ gemini: [geminiOk({}), geminiOk({}), geminiOk({})] });
  await Promise.all([h.client.completeJson(MSGS, 0.1), h.client.completeJson(MSGS, 0.1), h.client.completeJson(MSGS, 0.1)]);
  assert.deepEqual(h.sleeps, [1000, 2000]);

  const fast = harness({ gemini: [geminiOk({}), geminiOk({})] }, { geminiMinIntervalMs: 250 });
  await Promise.all([fast.client.completeJson(MSGS, 0.1), fast.client.completeJson(MSGS, 0.1)]);
  assert.deepEqual(fast.sleeps, [250]);
});

test('ключей нет — понятная LlmConfigError; есть только OPEN_ROUTER_API_KEY — сразу OpenRouter', async () => {
  const saved = { g: process.env.GEMINI_API_KEY, r: process.env.OPEN_ROUTER_API_KEY };
  try {
    delete process.env.GEMINI_API_KEY;
    const onlyRouter = harness({ router: [routerOk({ e: 1 })] });
    assert.deepEqual(await onlyRouter.client.completeJson(MSGS, 0.1), { e: 1 });
    assert.equal(onlyRouter.count('gemini'), 0);

    delete process.env.OPEN_ROUTER_API_KEY;
    await assert.rejects(harness({}).client.completeJson(MSGS, 0.1), (error: Error) => {
      assert.ok(error instanceof LlmConfigError);
      assert.match(error.message, /GEMINI_API_KEY/);
      return true;
    });
  } finally {
    process.env.GEMINI_API_KEY = saved.g;
    process.env.OPEN_ROUTER_API_KEY = saved.r;
  }
});

test('отчёт алерта и поиск: системный промпт требует JSON с нашими полями, посты — в сообщении пользователя', async () => {
  const h = harness({
    gemini: [
      geminiOk({ items: [{ text: 'x', source_ids: [0], quote: 'q', urgency: 'normal' }] }),
      geminiOk({ items: 'не массив' }),
      geminiOk({ summary: 'итог', relevant: [{ index: 0, gist: 'по теме' }] }),
    ],
  });
  const posts = [{ index: 0, text: 'ЦБ повысил ставку' }];

  assert.deepEqual(await generateAlertReport('ставка', posts, h.client), [{ text: 'x', source_ids: [0], quote: 'q', urgency: 'normal' }]);
  const system = h.calls[0].body.systemInstruction.parts[0].text;
  for (const field of ['JSON', '"items"', '"source_ids"', '"quote"', '"urgency"']) assert.ok(system.includes(field), field);
  const user = h.calls[0].body.contents[0].parts[0].text;
  assert.ok(user.includes('"ставка"') && user.includes('[0] ЦБ повысил ставку'));
  assert.equal(h.calls[0].body.generationConfig.temperature, 0.1);

  assert.deepEqual(await generateAlertReport('ставка', posts, h.client), []);

  assert.deepEqual(await summarizePosts('ставка', posts, h.client), { summary: 'итог', relevant: [{ index: 0, gist: 'по теме' }] });
  const searchSystem = h.calls[2].body.systemInstruction.parts[0].text;
  for (const field of ['JSON', '"summary"', '"relevant"', '"index"', '"gist"']) assert.ok(searchSystem.includes(field), field);
});
