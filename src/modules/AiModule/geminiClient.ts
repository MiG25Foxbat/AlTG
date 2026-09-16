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
 * Единственная точка вызова ИИ во всём проекте. Специально изолирована в
 * один файл и не завязана ни на какой SDK (обычный REST-запрос) — чтобы
 * смена провайдера (например, на Groq или GigaChat, если понадобится RU-хостинг
 * или бесплатный лимит Gemini закончится) была правкой одного файла, а не
 * поиском по всему коду.
 *
 * Модели намеренно не передаются тайминги и каналы — только индекс и текст
 * поста. Модель возвращает индексы релевантных постов и короткую пометку,
 * а конкретное время/канал/ссылку сервер потом подставляет сам из своих
 * же данных. Так исключается риск, что ИИ придумает или перепутает дату.
 */
export async function summarizeWithGemini(
  topic: string,
  posts: { index: number; text: string }[]
): Promise<SummarizeResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

  if (!apiKey) {
    throw new GeminiConfigError(
      'GEMINI_API_KEY не задан в .env. Получите ключ на https://aistudio.google.com/apikey и добавьте в файл .env'
    );
  }

  const postsBlock = posts
    .map((p) => `[${p.index}] ${p.text.slice(0, 600)}`)
    .join('\n---\n');

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
    postsBlock,
  ].join('\n');

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.2,
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
    const parsed = JSON.parse(rawText);
    return {
      summary: String(parsed.summary || ''),
      relevant: Array.isArray(parsed.relevant) ? parsed.relevant : [],
    };
  } catch (error) {
    logger.error('Не удалось разобрать JSON от Gemini:', rawText.slice(0, 1000));
    throw new Error('Gemini вернул ответ в неожиданном формате. Попробуйте ещё раз.');
  }
}
