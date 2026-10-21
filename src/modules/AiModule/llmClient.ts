import { logger } from '../../utils/logger';

/**
 * Единственная точка вызова ИИ во всём проекте: Gemini напрямую, резерв —
 * та же модель через OpenRouter. Без SDK, голый fetch: смена провайдера —
 * правка этого файла.
 *
 * - Все запросы к Gemini (и их повторы) идут через одну общую очередь — не
 *   чаще раза в GEMINI_MIN_INTERVAL_MS (по умолчанию 1000 мс).
 * - 429 от Gemini: ждём retry-after (заголовок или retryDelay в теле) или
 *   2 / 4 / 8 с — до трёх повторов.
 * - Любая другая ошибка Gemini (с российского IP — «User location is not
 *   supported», таймаут 30 с, сеть, 5xx, ключ, не-JSON) или кончились повторы —
 *   тот же запрос сразу в OpenRouter (платно, с баланса); там одна попытка.
 * - Ответ — JSON-объект, поля описаны в системном промпте. Доверять ему
 *   нельзя: пункты алертов потом проверяет reportValidator.ts.
 */

export class LlmQuotaError extends Error {
  constructor() {
    super('Лимит запросов к ИИ исчерпан (ошибка 429). Подождите немного или попробуйте позже.');
    this.name = 'LlmQuotaError';
  }
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Provider {
  name: 'Gemini' | 'OpenRouter';
  apiKey: string | undefined;
  build(messages: ChatMessage[], temperature: number): HttpRequest;
  /** Текст ответа модели из JSON ответа API */
  extract(data: any): unknown;
}

/** OpenRouter резервирует под ответ до 65 тыс. токенов и без лимита отказывает (402) при скромном балансе. */
const OPEN_ROUTER_MAX_TOKENS = 8192;

const textOf = (messages: ChatMessage[], role: ChatMessage['role']) =>
  messages.filter((m) => m.role === role).map((m) => m.content).join('\n\n');

// Ключи и модель читаем при каждом вызове: тесты и .env задают их после импорта модуля.
const geminiModel = () => process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

const gemini = (): Provider => ({
  name: 'Gemini',
  apiKey: process.env.GEMINI_API_KEY,
  build: (messages, temperature) => ({
    // Ключ — в заголовке, а не в URL: URL попадает в логи и тексты ошибок.
    url: `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent`,
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '' },
    body: {
      systemInstruction: { parts: [{ text: textOf(messages, 'system') }] },
      contents: [{ role: 'user', parts: [{ text: textOf(messages, 'user') }] }],
      generationConfig: { responseMimeType: 'application/json', temperature },
    },
  }),
  extract: (data) => data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join(''),
});

const openRouter = (): Provider => ({
  name: 'OpenRouter',
  apiKey: process.env.OPEN_ROUTER_API_KEY,
  build: (messages, temperature) => ({
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: { Authorization: `Bearer ${process.env.OPEN_ROUTER_API_KEY ?? ''}` },
    body: {
      model: `google/${geminiModel()}`,
      messages,
      temperature,
      response_format: { type: 'json_object' },
      max_tokens: OPEN_ROUTER_MAX_TOKENS,
    },
  }),
  extract: (data) => data?.choices?.[0]?.message?.content,
});

/** Ошибка одного запроса к провайдеру; kind решает, что делать дальше. */
class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: 'rate_limit' | 'timeout' | 'failed',
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(`${provider}: ${message}`);
  }
}

export interface LlmDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs: number;
  geminiMinIntervalMs: number;
  /** Паузы перед повторами на 429, если провайдер не сказал, сколько ждать */
  retryDelaysMs: number[];
}

/** Сколько ждать после 429: заголовок retry-after или retryDelay из тела ошибки Google («34s»). */
function retryAfterMs(response: Response, body: string): number | undefined {
  const header = Number(response.headers.get('retry-after'));
  if (header > 0) return header * 1000;
  const fromBody = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return fromBody ? Number(fromBody[1]) * 1000 : undefined;
}

export class LlmClient {
  private nextGeminiSlotAt = 0;

  constructor(private readonly deps: LlmDeps) {}

  async completeJson(messages: ChatMessage[], temperature: number): Promise<any> {
    const [g, r] = [gemini(), openRouter()];
    if (!g.apiKey && !r.apiKey) {
      throw new LlmConfigError(
        'Не задан ключ ИИ: добавьте в .env GEMINI_API_KEY (https://aistudio.google.com/apikey) и/или OPEN_ROUTER_API_KEY (https://openrouter.ai/keys)'
      );
    }

    let geminiError: ProviderError | undefined;
    if (g.apiKey) {
      try {
        return await this.geminiWithRetries(g, messages, temperature);
      } catch (error) {
        geminiError = error as ProviderError;
        if (!r.apiKey) throw toPublicError(geminiError);
        logger.warn(`${geminiError.message} — отправляю тот же запрос в OpenRouter`);
      }
    }

    try {
      return await this.request(r, messages, temperature);
    } catch (error) {
      const routerError = error as ProviderError;
      logger.error(`ИИ не ответил: ${[geminiError?.message, routerError.message].filter(Boolean).join('; ')}`);
      throw toPublicError(routerError, geminiError);
    }
  }

  /**
   * Общая очередь Gemini: слот занимается синхронно (до первого await), так что
   * параллельные вызовы встают строго друг за другом с шагом minInterval.
   */
  private async geminiSlot(): Promise<void> {
    const now = this.deps.now();
    const slot = Math.max(now, this.nextGeminiSlotAt);
    this.nextGeminiSlotAt = slot + this.deps.geminiMinIntervalMs;
    if (slot > now) await this.deps.sleep(slot - now);
  }

  private async geminiWithRetries(p: Provider, messages: ChatMessage[], temperature: number): Promise<any> {
    for (let retry = 0; ; retry++) {
      await this.geminiSlot();
      try {
        return await this.request(p, messages, temperature);
      } catch (error) {
        const e = error as ProviderError;
        if (e.kind !== 'rate_limit' || retry >= this.deps.retryDelaysMs.length) throw e;
        const wait = e.retryAfterMs ?? this.deps.retryDelaysMs[retry];
        // Ждать дольше таймаута (кончилась дневная квота) не будем — иначе встанет планировщик.
        if (wait > this.deps.timeoutMs) throw e;
        logger.warn(`Gemini: 429, повтор ${retry + 1} через ${Math.round(wait / 1000)} с`);
        await this.deps.sleep(wait);
      }
    }
  }

  private async request(p: Provider, messages: ChatMessage[], temperature: number): Promise<any> {
    const { url, headers, body } = p.build(messages, temperature);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    const timeout = () => new ProviderError(p.name, 'timeout', `нет ответа за ${this.deps.timeoutMs / 1000} с`);
    try {
      let response: Response;
      try {
        response = await this.deps.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error: any) {
        if (controller.signal.aborted) throw timeout();
        throw new ProviderError(p.name, 'failed', `сетевая ошибка (${error?.cause?.code || error?.message || error})`);
      }

      const text = await response.text().catch(() => {
        if (controller.signal.aborted) throw timeout();
        return '';
      });
      if (response.status === 429) {
        throw new ProviderError(p.name, 'rate_limit', 'лимит запросов (429)', retryAfterMs(response, text));
      }
      if (!response.ok) {
        throw new ProviderError(p.name, 'failed', `ошибка ${response.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
      }

      let content: unknown;
      try {
        content = p.extract(JSON.parse(text));
      } catch {
        throw new ProviderError(p.name, 'failed', 'ответ API не JSON');
      }
      if (typeof content !== 'string' || !content.trim()) throw new ProviderError(p.name, 'failed', 'пустой ответ');
      try {
        // Режим JSON гарантирует JSON, но обёртку ```json на всякий случай снимаем
        return JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch {
        throw new ProviderError(p.name, 'failed', `модель ответила не JSON: ${content.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Последняя ошибка цепочки → то, что увидит пользователь (без ключей и лишних деталей). */
function toPublicError(last: ProviderError, previous?: ProviderError): Error {
  if (last.kind === 'rate_limit') return new LlmQuotaError();
  return new Error(`ИИ сейчас не отвечает (${[previous?.message, last.message].filter(Boolean).join('; ')}). Попробуйте ещё раз.`);
}

let defaultClient: LlmClient | undefined;

/** Общий клиент процесса — одна очередь Gemini на всех. */
function client(): LlmClient {
  return (defaultClient ??= new LlmClient({
    fetch: (...args) => fetch(...args),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    timeoutMs: 30_000,
    geminiMinIntervalMs: Number(process.env.GEMINI_MIN_INTERVAL_MS) || 1000,
    retryDelaysMs: [2000, 4000, 8000],
  }));
}

export interface RelevantItem {
  index: number;
  gist: string;
}

export interface SummarizeResult {
  summary: string;
  relevant: RelevantItem[];
}

const POST_CHARS_FOR_LLM = 600;

function postsBlock(posts: { index: number; text: string }[]): string {
  return posts.map((p) => `[${p.index}] ${p.text.slice(0, POST_CHARS_FOR_LLM)}`).join('\n---\n');
}

/**
 * Поиск по теме (вкладка «Поиск»). Модели намеренно не передаются тайминги
 * и каналы — только индекс и текст поста. Модель возвращает индексы
 * релевантных постов и короткую пометку, а конкретное время/канал/ссылку
 * сервер потом подставляет сам из своих же данных. Так исключается риск,
 * что ИИ придумает или перепутает дату.
 */
export async function summarizePosts(
  topic: string,
  posts: { index: number; text: string }[],
  llm: LlmClient = client()
): Promise<SummarizeResult> {
  const system = [
    'Ты помогаешь отбирать посты из Telegram-каналов по теме пользователя.',
    'Отвечай строго одним JSON-объектом, без текста вокруг, ровно в таком формате:',
    '{"summary": "<связный дайджест из 2–6 предложений по отобранным постам>",',
    ' "relevant": [{"index": <номер поста из квадратных скобок, целое число>, "gist": "<1 предложение: почему пост по теме>"}]}',
    '',
    'Правила:',
    '- Отбирай посты, которые по смыслу относятся к теме (учитывай синонимы, склонения, разные формулировки).',
    '- Используй только то, что реально написано в постах. Ничего не придумывай и не добавляй фактов извне.',
    '- Если ни один пост не относится к теме — верни пустой список relevant и в summary честно напиши,',
    '  что по этой теме за выбранный период ничего не найдено.',
    '- В index указывай ровно то число в квадратных скобках, под которым дан пост.',
  ].join('\n');
  const user = [`Тема запроса пользователя: "${topic}"`, '', 'Посты:', postsBlock(posts)].join('\n');

  const parsed = await llm.completeJson(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    0.2
  );
  return {
    summary: String(parsed?.summary || ''),
    relevant: Array.isArray(parsed?.relevant) ? parsed.relevant : [],
  };
}

/**
 * Алерт по подписке: ОДИН вызов на все новые посты подписки. Ответ — сырые
 * пункты; доверять им нельзя, пока их не проверит validateReportItems().
 * Дат и времени модель не пишет — время поста подставляется из метаданных.
 */
export async function generateAlertReport(
  topic: string,
  posts: { index: number; text: string }[],
  llm: LlmClient = client()
): Promise<unknown[]> {
  const system = [
    'Ты читаешь посты из Telegram-каналов за пользователя: отбираешь те, что по смыслу относятся к его теме,',
    'и коротко пересказываешь их для уведомления.',
    'Отвечай строго одним JSON-объектом, без текста вокруг, ровно в таком формате:',
    '{"items": [{"text": "<пункт: что в посте по теме, 1–2 предложения>",',
    '  "source_ids": [<номера постов-источников из квадратных скобок, целые числа>],',
    '  "quote": "<фрагмент одного из этих постов, 5–15 слов, скопированный как есть>",',
    '  "urgency": "normal" | "important" | "urgent"}]}',
    '',
    'Как отбирать:',
    '- Отбирай посты, которые по смыслу относятся к теме, — как отобрал бы человек, который читает каналы',
    '  ради этой темы. Учитывай синонимы, склонения, разговорные и разные формулировки, близкие по смыслу вещи.',
    '- Подходит не только новость: анонс, подборка, рекомендация, обзор, место, событие, мнение — если это по теме.',
    '- Один пункт — один пост или несколько постов об одном и том же.',
    '- Посты не по теме пропускай. Если по теме ничего нет — верни {"items": []}.',
    '',
    'Как писать (проверяется автоматически — пункт с нарушением будет выброшен):',
    '- Только то, что написано в постах. Ничего не добавляй от себя и не выдумывай.',
    '- В source_ids укажи номера всех постов пункта. Сами номера постов в текст пункта не вставляй.',
    '- quote — скопируй фрагмент поста символ в символ, ничего не меняя.',
    '- Числа переписывай ровно в том виде, как в посте, ничего не пересчитывая и не округляя.',
    '- Не пиши дат и времени — их подставит система.',
    '- Если посты противоречат друг другу, так и напиши: «источники расходятся: в одном …, в другом …»,',
    '  и укажи оба поста в source_ids.',
    '- urgency: "urgent" — требует внимания немедленно (происходит прямо сейчас, угроза, резкое изменение);',
    '  "important" — заметная новость по теме; "normal" — всё остальное.',
  ].join('\n');
  const user = [`Тема подписки пользователя: "${topic}"`, '', 'Посты:', postsBlock(posts)].join('\n');

  const parsed = await llm.completeJson(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    0.1
  );
  return Array.isArray(parsed?.items) ? parsed.items : [];
}
