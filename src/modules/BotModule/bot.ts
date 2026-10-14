import { Bot, Context, webhookCallback } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { RequestHandler } from 'express';
import { handleStart, handleCallback, topicsView, pauseView, BotView } from './botActions';
import { getLinkByChat, setPrivateChatStatus } from '../../db/destinationsRepo';
import { logger } from '../../utils/logger';

export const WEBHOOK_PATH = '/telegram/webhook';
const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'] as const;

export interface AlertBot {
  username: string;
  mode: 'webhook' | 'polling';
  /** Только в режиме webhook — смонтировать на WEBHOOK_PATH */
  webhookHandler?: RequestHandler;
  /** Polling запускается отдельно — только в процессе, который держит замок */
  startPolling(): void;
  stop(): Promise<void>;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const options = (view: BotView) => ({
  parse_mode: 'HTML' as const,
  // Наш InlineKeyboard — тот же JSON Bot API, только тип проще (кнопка url или callback).
  reply_markup: view.keyboard as InlineKeyboardMarkup | undefined,
  link_preview_options: { is_disabled: true },
});
const NOT_LINKED = 'Бот ещё не привязан к вашему аккаунту на сайте — нажмите /start.';

/**
 * Общий бот алертов (grammY). Режим — BOT_MODE: webhook (Render — входящий
 * запрос будит сервис; проверка по secret_token) или polling (локально,
 * webhook без публичного HTTPS не работает). Без BOT_MODE — polling.
 */
export async function createAlertBot(token: string): Promise<AlertBot> {
  const bot = new Bot(token);
  const privateOnly = (handler: (ctx: Context) => Promise<unknown>) => async (ctx: Context) => {
    if (ctx.chat?.type === 'private') await handler(ctx);
  };

  bot.command(
    'start',
    privateOnly(async (ctx) => {
      const view = await handleStart(ctx.chat!.id, ctx.from!.id, String(ctx.match ?? '').trim(), nowSec());
      await ctx.reply(view.text, options(view));
    })
  );

  bot.command(
    'topics',
    privateOnly(async (ctx) => {
      const link = await getLinkByChat(ctx.chat!.id);
      const view = link ? await topicsView(link.userId) : { text: NOT_LINKED };
      await ctx.reply(view.text, options(view));
    })
  );

  bot.command(
    'pause',
    privateOnly(async (ctx) => {
      const link = await getLinkByChat(ctx.chat!.id);
      const view = link ? pauseView(link, nowSec()) : { text: NOT_LINKED };
      await ctx.reply(view.text, options(view));
    })
  );

  bot.command(
    'settings',
    privateOnly(async (ctx) => {
      const url = process.env.PUBLIC_BASE_URL;
      const view: BotView = url?.startsWith('https://')
        ? { text: 'Все настройки — на сайте.', keyboard: { inline_keyboard: [[{ text: '⚙️ Открыть настройки', url }]] } }
        : { text: url ? `Все настройки — на сайте: ${url}` : 'Все настройки — на сайте.' };
      await ctx.reply(view.text, options(view));
    })
  );

  bot.on('callback_query:data', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId || ctx.chat?.type !== 'private') return ctx.answerCallbackQuery();
    const outcome = await handleCallback(chatId, ctx.callbackQuery.data, nowSec());
    await ctx.answerCallbackQuery(outcome.toast ? { text: outcome.toast } : undefined);
    if (outcome.edit) {
      await ctx.editMessageText(outcome.edit.text, options(outcome.edit)).catch((error) => {
        // «message is not modified» — повторное нажатие той же кнопки, не ошибка
        if (!/not modified/.test(String(error?.description))) throw error;
      });
    }
    if (outcome.reply) await ctx.reply(outcome.reply.text, options(outcome.reply));
  });

  // Пользователь заблокировал/разблокировал бота — не слать зря (ТЗ п. 4).
  bot.on('my_chat_member', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === 'kicked') await setPrivateChatStatus(ctx.chat.id, 'blocked');
    else if (status === 'member') await setPrivateChatStatus(ctx.chat.id, 'active');
  });

  bot.catch((err) => logger.error('Ошибка в обработчике бота:', err.error));

  await bot.init();
  await bot.api.setMyCommands([
    { command: 'topics', description: 'Темы: вкл/выкл, частота, звук' },
    { command: 'pause', description: 'Пауза на час или до утра' },
    { command: 'settings', description: 'Все настройки на сайте' },
    { command: 'start', description: 'Привязать бота к аккаунту' },
  ]);

  const mode = process.env.BOT_MODE === 'webhook' ? 'webhook' : 'polling';
  let webhookHandler: RequestHandler | undefined;
  if (mode === 'webhook') {
    const base = process.env.PUBLIC_BASE_URL;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!base?.startsWith('https://') || !secret) {
      throw new Error('BOT_MODE=webhook требует PUBLIC_BASE_URL (https://…) и TELEGRAM_WEBHOOK_SECRET');
    }
    await bot.api.setWebhook(`${base.replace(/\/$/, '')}${WEBHOOK_PATH}`, {
      secret_token: secret,
      allowed_updates: [...ALLOWED_UPDATES],
    });
    // grammY сам сверяет заголовок X-Telegram-Bot-Api-Secret-Token и отвечает 401 на чужие запросы.
    webhookHandler = webhookCallback(bot, 'express', { secretToken: secret }) as unknown as RequestHandler;
  }

  logger.info(`Бот алертов @${bot.botInfo.username} готов, режим: ${mode}`);
  return {
    username: bot.botInfo.username,
    mode,
    webhookHandler,
    startPolling() {
      if (mode !== 'polling') return;
      // bot.start() сам снимает webhook; промис живёт, пока идёт polling.
      bot.start({ allowed_updates: [...ALLOWED_UPDATES] }).catch((error) => logger.error('Polling бота остановился:', error));
    },
    async stop() {
      if (bot.isRunning()) await bot.stop();
    },
  };
}
