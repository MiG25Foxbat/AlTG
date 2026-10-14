import { logger } from '../../utils/logger';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiQuotaError extends Error {
  constructor() {
    super('Бесплатный лимит Gemini на сегодня исчерпан (ошибка 429). Подождите немного или попробуйте позже.');
    this.name = 'GeminiQuotaError';
  }
}

export class GeminiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiConfigError';
  }
}

export interface RelevantItem {
  index: number;
  gist: string;
}

export interface SummarizeResult {
  summary: string;
  relevant: RelevantItem[];
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    relevant: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'INTEGER' },
          gist: { type: 'STRING' },
        },
        required: ['index', 'gist'],
      },
    },
  },
  required: ['summary', 'relevant'],
};

/**
 * Схема ответа для алертов (ТЗ п. 8): каждый пункт — текст, номера
 * постов-источников, дословная цитата и срочность. Код потом проверяет
 * каждый пункт (reportValidator.ts) и выкидывает непрошедшие.
 */
const REPORT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          source_ids: { type: 'ARRAY', items: { type: 'INTEGER' } },
          quote: { type: 'STRING' },
          urgency: { type: 'STRING', enum: ['normal', 'important', 'urgent'] },
        },
        required: ['text', 'source_ids', 'quote', 'urgency'],
      },
    },
  },
  required: ['items'],
};

const POST_CHARS_FOR_LLM = 600;

function postsBlock(posts: { index: number; text: string }[]): string {
  return posts.map((p) => `[${p.index}] ${p.text.slice(0, POST_CHARS_FOR_LLM)}`).join('\n---\n');
}

/**
 * Единственная точка вызова ИИ во всём проекте. Специально изолирована в
 * один файл и не завязана ни на какой SDK (обычный REST-запрос) — чтобы
 * смена провайдера (например, на Groq или GigaChat, если понадобится RU-хостинг
 * или бесплатный лимит Gemini закончится) была правкой одного файла, а не
 * поиском по всему коду.
 */
async function callGemini(prompt: string, responseSchema: object, temperature: number): Promise<any> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

  if (!apiKey) {
    throw new GeminiConfigError(
      'GEMINI_API_KEY не задан в .env. Получите ключ на https://aistudio.google.com/apikey и добавьте в файл .env'
    );
  }

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
      temperature,
    },
  };

  const url = `${API_BASE}/${model}:generateContent?key=${apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error: any) {
    logger.error('Сетевая ошибка при обращении к Gemini:', error);
    throw new Error(
      `Не удалось достучаться до Gemini API (сетевая ошибка). Если сервер работает из России — ` +
        `это может быть блокировка по IP, попробуйте через VPN или смените GEMINI_MODEL на другого провайдера. Детали: ${error?.message || error}`
    );
  }

  if (response.status === 429) {
    throw new GeminiQuotaError();
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Gemini API вернул ошибку ${response.status}: ${text.slice(0, 500)}`);
  }

  const data: any = await response.json();
  const rawText: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!rawText) {
    logger.error('Пустой ответ Gemini:', JSON.stringify(data).slice(0, 1000));
    throw new Error('Gemini вернул пустой ответ. Попробуйте ещё раз.');
  }

  try {
    return JSON.parse(rawText);
  } catch (error) {
    logger.error('Не удалось разобрать JSON от Gemini:', rawText.slice(0, 1000));
    throw new Error('Gemini вернул ответ в неожиданном формате. Попробуйте ещё раз.');
  }
}

/**
 * Поиск по теме (вкладка «Поиск»). Модели намеренно не передаются тайминги
 * и каналы — только индекс и текст поста. Модель возвращает индексы
 * релевантных постов и короткую пометку, а конкретное время/канал/ссылку
 * сервер потом подставляет сам из своих же данных. Так исключается риск,
 * что ИИ придумает или перепутает дату.
 */
export async function summarizeWithGemini(
  topic: string,
  posts: { index: number; text: string }[]
): Promise<SummarizeResult> {
  const prompt = [
    `Тема запроса пользователя: "${topic}"`,
    '',
    'Ниже пронумерованные посты из Telegram-каналов. Твоя задача:',
    '1. Отобрать только те посты, которые по смыслу относятся к теме запроса',
    '   (учитывай синонимы, склонения, разные формулировки — не только буквальные совпадения слов).',
    '2. Для каждого отобранного поста написать очень короткую (1 предложение) пометку,',
    '   почему он относится к теме.',
    '3. Написать общий связный текст-дайджест (2-6 предложений) по отобранным постам.',
    '',
    'Правила:',
    '- Используй только то, что реально написано в постах ниже. Ничего не придумывай и не добавляй фактов извне.',
    '- Если ни один пост не относится к теме — верни пустой список relevant и в summary честно напиши,',
    '  что по этой теме за выбранный период ничего не найдено.',
    '- В поле index указывай ровно то число в квадратных скобках, под которым дан пост.',
    '',
    'Посты:',
    postsBlock(posts),
  ].join('\n');

  const parsed = await callGemini(prompt, RESPONSE_SCHEMA, 0.2);
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
  posts: { index: number; text: string }[]
): Promise<unknown[]> {
  const prompt = [
    `Тема подписки пользователя: "${topic}"`,
    '',
    'Ниже пронумерованные посты из Telegram-каналов. Составь сводку по теме: список пунктов,',
    'каждый пункт — один факт или событие по теме, 1–2 предложения.',
    '',
    'Строгие правила:',
    '- Пиши только то, что прямо сказано в постах ниже. Ничего не добавляй от себя: никаких выводов,',
    '  прогнозов, оценок и фактов извне.',
    '- В source_ids укажи номера (числа в квадратных скобках) всех постов, на которых основан пункт.',
    '  Сами номера постов в текст пункта не вставляй.',
    '- В quote приведи короткую (5–15 слов) дословную цитату из одного из этих постов, подтверждающую',
    '  пункт, — символ в символ, ничего не меняя.',
    '- Числа переписывай ровно в том виде, как в источнике, ничего не пересчитывая и не округляя.',
    '- Не пиши дат и времени — их подставит система.',
    '- Если источники противоречат друг другу, так и напиши: «источники расходятся: в одном …, в другом …»,',
    '  и укажи оба поста в source_ids.',
    '- Посты не по теме пропускай. Если по теме ничего нет — верни пустой список items.',
    '- urgency: "urgent" — требует внимания немедленно (происходит прямо сейчас, угроза, резкое изменение);',
    '  "important" — значимая новость по теме; "normal" — всё остальное.',
    '',
    'Посты:',
    postsBlock(posts),
  ].join('\n');

  const parsed = await callGemini(prompt, REPORT_SCHEMA, 0.1);
  return Array.isArray(parsed?.items) ? parsed.items : [];
}
