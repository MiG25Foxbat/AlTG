import { logger } from '../../utils/logger';

/**
 * Единственная точка вызова ИИ во всём проекте: цепочка провайдеров с
 * OpenAI-совместимым API — Mistral первым, Groq резервом. Без SDK, голый
 * fetch: смена провайдера — правка этого файла.
 *
 * - Все запросы к Mistral (и их повторы) идут через одну общую очередь — не
 *   чаще раза в MISTRAL_MIN_INTERVAL_MS (по умолчанию 1000 мс).
 * - 429 от Mistral: ждём retry-after или 2 / 4 / 8 с — до трёх повторов.
 * - Любая другая ошибка Mistral (таймаут 30 с, сеть, 5xx, ключ, не-JSON) или
 *   кончились повторы — тот же запрос сразу в Groq; Groq — одна попытка.
 * - Ответ — JSON-объект (response_format json_object), поля описаны в
 *   системном промпте. Доверять ему нельзя: пункты алертов потом проверяет
 *   reportValidator.ts.
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

interface Provider {
  name: 'Mistral' | 'Groq';
  url: string;
  apiKey: string | undefined;
  model: string;
}

// Ключи и модели читаем при каждом вызове: тесты и .env задают их после импорта модуля.
const mistral = (): Provider => ({
  name: 'Mistral',
  url: 'https://api.mistral.ai/v1/chat/completions',
  apiKey: process.env.MISTRAL_API_KEY,
  model: process.env.MISTRAL_MODEL || 'mistral-medium-latest',
});
const groq = (): Provider => ({
  name: 'Groq',
  url: 'https://api.groq.com/openai/v1/chat/completions',
  apiKey: process.env.GROQ_API_KEY,
  model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
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
  mistralMinIntervalMs: number;
  /** Паузы перед повторами на 429, если провайдер не прислал retry-after */
  retryDelaysMs: number[];
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export class LlmClient {
  private nextMistralSlotAt = 0;

  constructor(private readonly deps: LlmDeps) {}

  async completeJson(messages: ChatMessage[], temperature: number): Promise<any> {
    const [m, g] = [mistral(), groq()];
    if (!m.apiKey && !g.apiKey) {
      throw new LlmConfigError(
        'Не задан ключ ИИ: добавьте в .env MISTRAL_API_KEY (https://console.mistral.ai) и/или GROQ_API_KEY (https://console.groq.com)'
      );
    }

    let mistralError: ProviderError | undefined;
    if (m.apiKey) {
      try {
        return await this.mistralWithRetries(m, messages, temperature);
      } catch (error) {
        mistralError = error as ProviderError;
        if (!g.apiKey) throw toPublicError(mistralError);
        logger.warn(`${mistralError.message} — отправляю тот же запрос в Groq`);
      }
    }

    try {
      return await this.request(g, messages, temperature);
    } catch (error) {
      const groqError = error as ProviderError;
      logger.error(`ИИ не ответил: ${[mistralError?.message, groqError.message].filter(Boolean).join('; ')}`);
      throw toPublicError(groqError, mistralError);
    }
  }

  /**
   * Общая очередь Mistral: слот занимается синхронно (до первого await), так что
   * параллельные вызовы встают строго друг за другом с шагом minInterval.
   */
  private async mistralSlot(): Promise<void> {
    const now = this.deps.now();
    const slot = Math.max(now, this.nextMistralSlotAt);
    this.nextMistralSlotAt = slot + this.deps.mistralMinIntervalMs;
    if (slot > now) await this.deps.sleep(slot - now);
  }

  private async mistralWithRetries(p: Provider, messages: ChatMessage[], temperature: number): Promise<any> {
    for (let retry = 0; ; retry++) {
      await this.mistralSlot();
      try {
        return await this.request(p, messages, temperature);
      } catch (error) {
        const e = error as ProviderError;
        if (e.kind !== 'rate_limit' || retry >= this.deps.retryDelaysMs.length) throw e;
        const wait = e.retryAfterMs ?? this.deps.retryDelaysMs[retry];
        // retry-after в минуты/часы (кончилась квота) не ждём — иначе встанет планировщик.
        if (wait > this.deps.timeoutMs) throw e;
        logger.warn(`Mistral: 429, повтор ${retry + 1} через ${Math.round(wait / 1000)} с`);
        await this.deps.sleep(wait);
      }
    }
  }

  private async request(p: Provider, messages: ChatMessage[], temperature: number): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.deps.fetch(p.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
          body: JSON.stringify({ model: p.model, messages, temperature, response_format: { type: 'json_object' } }),
          signal: controller.signal,
        });
      } catch (error: any) {
        if (controller.signal.aborted) throw new ProviderError(p.name, 'timeout', `нет ответа за ${this.deps.timeoutMs / 1000} с`);
        throw new ProviderError(p.name, 'failed', `сетевая ошибка (${error?.cause?.code || error?.message || error})`);
      }

      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        throw new ProviderError(p.name, 'rate_limit', 'лимит запросов (429)', seconds > 0 ? seconds * 1000 : undefined);
      }
      const text = await response.text().catch(() => {
        if (controller.signal.aborted) throw new ProviderError(p.name, 'timeout', `нет ответа за ${this.deps.timeoutMs / 1000} с`);
        return '';
      });
      if (!response.ok) throw new ProviderError(p.name, 'failed', `ошибка ${response.status}: ${text.slice(0, 300)}`);

      let content: unknown;
      try {
        content = JSON.parse(text)?.choices?.[0]?.message?.content;
      } catch {
        throw new ProviderError(p.name, 'failed', 'ответ API не JSON');
      }
      if (typeof content !== 'string' || !content.trim()) throw new ProviderError(p.name, 'failed', 'пустой ответ');
      try {
        // json_object гарантирует JSON, но обёртку ```json на всякий случай снимаем
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

/** Общий клиент процесса — одна очередь Mistral на всех. */
function client(): LlmClient {
  return (defaultClient ??= new LlmClient({
    fetch: (...args) => fetch(...args),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    timeoutMs: 30_000,
    mistralMinIntervalMs: Number(process.env.MISTRAL_MIN_INTERVAL_MS) || 1000,
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
    'Ты составляешь сводку новостей по теме пользователя строго по переданным постам из Telegram-каналов.',
    'Отвечай строго одним JSON-объектом, без текста вокруг, ровно в таком формате:',
    '{"items": [{"text": "<пункт: один факт или событие по теме, 1–2 предложения>",',
    '  "source_ids": [<номера постов-источников из квадратных скобок, целые числа>],',
    '  "quote": "<короткая дословная цитата из одного из этих постов, 5–15 слов>",',
    '  "urgency": "normal" | "important" | "urgent"}]}',
    '',
    'Строгие правила:',
    '- Пиши только то, что прямо сказано в постах. Ничего не добавляй от себя: никаких выводов,',
    '  прогнозов, оценок и фактов извне.',
    '- В source_ids укажи номера всех постов, на которых основан пункт. Сами номера постов в текст пункта не вставляй.',
    '- quote — символ в символ из поста, ничего не меняя.',
    '- Числа переписывай ровно в том виде, как в источнике, ничего не пересчитывая и не округляя.',
    '- Не пиши дат и времени — их подставит система.',
    '- Если источники противоречат друг другу, так и напиши: «источники расходятся: в одном …, в другом …»,',
    '  и укажи оба поста в source_ids.',
    '- Посты не по теме пропускай. Если по теме ничего нет — верни {"items": []}.',
    '- urgency: "urgent" — требует внимания немедленно (происходит прямо сейчас, угроза, резкое изменение);',
    '  "important" — значимая новость по теме; "normal" — всё остальное.',
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
