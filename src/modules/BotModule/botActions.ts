import {
  ALERT_INTERVALS,
  URGENCY_LEVELS,
  Urgency,
  TopicDto,
  listTopics,
  getTopic,
  updateTopic,
  recordFeedback,
} from '../../db/alertsRepo';
import { consumeLinkToken, getLinkByChat, linkPrivateChat, setPause, PrivateChatLink } from '../../db/destinationsRepo';
import { findUserIdByTelegramId } from '../../db/telegramAccountsRepo';
import { escapeHtml, InlineKeyboard } from '../AlertModule/messageFormat';
import { formatMoscowTime, nextMoscowMorning } from '../../utils/time';

/**
 * Что бот отвечает и что делают кнопки — без grammY и сети (тестируется на
 * in-memory БД). bot.ts только передаёт сюда апдейты и отправляет результат.
 * Тексты — HTML.
 */

export interface BotView {
  text: string;
  keyboard?: InlineKeyboard;
}

export interface CallbackOutcome {
  /** Всплывашка на нажатие */
  toast?: string;
  /** Заменить сообщение с кнопкой */
  edit?: BotView;
  /** Ответить новым сообщением (сам алерт не трогаем) */
  reply?: BotView;
}

const START_PAYLOAD_RE = /^[A-Za-z0-9_-]{1,64}$/;

const INTERVAL_TEXT: Record<number, string> = {
  15: '15 минут',
  30: '30 минут',
  60: 'час',
  180: '3 часа',
  300: '5 часов',
  600: '10 часов',
  1440: 'сутки',
};
const INTERVAL_BUTTON: Record<number, string> = { 15: '15м', 30: '30м', 60: '1ч', 180: '3ч', 300: '5ч', 600: '10ч', 1440: '24ч' };
const LOUD_TEXT: Record<Urgency, string> = { normal: 'всё', important: 'важное и срочное', urgent: 'только срочное' };
const LOUD_BUTTON: Record<Urgency, string> = { normal: 'Всё', important: 'Важное+', urgent: 'Срочное' };

const HELP = 'Команды: /topics — темы, /pause — пауза, /settings — все настройки на сайте.';

/** Кнопка «Настройки» на сайт; Telegram принимает в кнопках только публичные https-адреса. */
function siteRow(): InlineKeyboard['inline_keyboard'] {
  const url = process.env.PUBLIC_BASE_URL;
  return url?.startsWith('https://') ? [[{ text: '⚙️ Настройки на сайте', url }]] : [];
}

function siteText(): string {
  const url = process.env.PUBLIC_BASE_URL;
  return url ? `\n${escapeHtml(url)}` : '';
}

const quoteLabel = (t: TopicDto) => `«${escapeHtml(t.label)}»`;

// --- /start ---

export async function handleStart(chatId: number, fromId: number, payload: string, now: number): Promise<BotView> {
  let userId: number | undefined;
  if (payload) {
    if (!START_PAYLOAD_RE.test(payload)) return { text: 'Ссылка повреждена. Получите новую на сайте: вкладка «Алерты» → «Получать алерты».' };
    userId = await consumeLinkToken(payload, now);
    if (!userId) {
      return {
        text: 'Ссылка устарела или уже использована. Получите новую на сайте: вкладка «Алерты» → «Получать алерты».' + siteText(),
        keyboard: { inline_keyboard: siteRow() },
      };
    }
  } else {
    userId = await findUserIdByTelegramId(fromId);
    if (!userId) {
      return {
        text:
          'Не нашёл ваш аккаунт: этот Telegram не подключён на сайте. Откройте сайт → вкладка «Алерты» → ' +
          '«Получать алерты» и перейдите по ссылке оттуда.' + siteText(),
        keyboard: { inline_keyboard: siteRow() },
      };
    }
  }

  await linkPrivateChat(userId, chatId, now);
  const active = (await listTopics(userId)).filter((t) => t.isActive).length;
  const word = active % 10 === 1 && active % 100 !== 11 ? 'теме' : 'темам';
  const head = active
    ? `Готово, алерты по ${active} ${word} будут приходить сюда.`
    : 'Готово, бот привязан. Активных тем пока нет — добавьте их на сайте.';
  return { text: `${head}\n\n${HELP}` };
}

// --- Экраны ---

export async function topicsView(userId: number): Promise<BotView> {
  const topics = await listTopics(userId);
  if (topics.length === 0) {
    return { text: 'Тем пока нет — добавьте их на сайте.' + siteText(), keyboard: { inline_keyboard: siteRow() } };
  }
  return {
    text: '<b>Ваши темы</b>\nНажмите на тему, чтобы включить или выключить её; ⚙️ — частота проверки и звук.',
    keyboard: {
      inline_keyboard: [
        ...topics.map((t) => [
          { text: `${t.isActive ? '✅' : '⏸'} ${t.label}`.slice(0, 60), callback_data: `tp:t:${t.id}` },
          { text: '⚙️', callback_data: `tp:s:${t.id}` },
        ]),
        ...siteRow(),
      ],
    },
  };
}

export function topicSettingsView(topic: TopicDto): BotView {
  const s = topic.settings;
  const mark = (on: boolean, text: string) => (on ? `• ${text}` : text);
  const intervals = ALERT_INTERVALS.map((m) => ({
    text: mark(s.intervalMinutes === m, INTERVAL_BUTTON[m]),
    callback_data: `tp:i:${topic.id}:${m}`,
  }));
  return {
    text:
      `<b>${quoteLabel(topic)}</b> ${topic.isActive ? '' : '(выключена)'}\n` +
      `Проверка: раз в ${INTERVAL_TEXT[s.intervalMinutes]}\n` +
      `Со звуком: ${LOUD_TEXT[s.loudFrom]} (громкое приходит и в тихие часы, и в паузу)`,
    keyboard: {
      inline_keyboard: [
        intervals.slice(0, 4),
        intervals.slice(4),
        URGENCY_LEVELS.map((u) => ({ text: mark(s.loudFrom === u, LOUD_BUTTON[u]), callback_data: `tp:l:${topic.id}:${u}` })),
        [{ text: '« К списку тем', callback_data: 'tp:list' }],
      ],
    },
  };
}

export function pauseView(link: PrivateChatLink, now: number): BotView {
  const paused = link.pausedUntil !== null && link.pausedUntil > now;
  const text = paused
    ? `⏸ Пауза до ${formatMoscowTime(link.pausedUntil!)} МСК. Обычные алерты придут одним сообщением после паузы, громкие — сразу.`
    : 'Пауза: обычные алерты придержу и пришлю одним сообщением, когда она кончится. Громкие (по вашему порогу звука) придут сразу.';
  return {
    text,
    keyboard: {
      inline_keyboard: [
        [
          { text: 'На час', callback_data: 'pz:1h' },
          { text: 'До утра (09:00)', callback_data: 'pz:am' },
        ],
        ...(paused ? [[{ text: '▶️ Снять паузу', callback_data: 'pz:off' }]] : []),
      ],
    },
  };
}

// --- Кнопки ---

/** «Реже» — следующий пресет интервала; null — уже максимальный. */
export function nextInterval(minutes: number): number | null {
  const i = ALERT_INTERVALS.indexOf(minutes as (typeof ALERT_INTERVALS)[number]);
  return i >= 0 && i < ALERT_INTERVALS.length - 1 ? ALERT_INTERVALS[i + 1] : null;
}

const STALE: CallbackOutcome = { toast: 'Кнопка устарела' };

/**
 * callback_data: fb:<nr|less|off>:<topicId>:<reportId> — под алертом;
 * undo:less:<topicId>:<прежний интервал>, undo:off:<topicId> — отмена;
 * tp:… — экран тем; pz:… — пауза. Всё — от имени владельца чата и только
 * с его темами (updateTopic/getTopic проверяют user_id).
 */
export async function handleCallback(chatId: number, data: string, now: number): Promise<CallbackOutcome> {
  const link = await getLinkByChat(chatId);
  if (!link) return { toast: 'Бот не привязан к аккаунту — нажмите /start' };
  const userId = link.userId;

  if (data.startsWith('pz:')) {
    const until = data === 'pz:1h' ? now + 3600 : data === 'pz:am' ? nextMoscowMorning(now) : data === 'pz:off' ? null : undefined;
    if (until === undefined) return STALE;
    await setPause(link.destinationId, until);
    return {
      toast: until ? `Пауза до ${formatMoscowTime(until)} МСК` : 'Пауза снята',
      edit: pauseView({ ...link, pausedUntil: until }, now),
    };
  }
  if (data === 'tp:list') return { edit: await topicsView(userId) };

  const [kind, action, rawId, rawArg] = data.split(':');
  const topicId = Number(rawId);
  if (!Number.isInteger(topicId)) return STALE;
  const topic = await getTopic(userId, topicId);
  if (!topic) return { toast: 'Тема не найдена — возможно, её удалили' };
  const reportId = Number.isInteger(Number(rawArg)) ? Number(rawArg) : null;

  switch (`${kind}:${action}`) {
    case 'fb:nr':
      await recordFeedback(userId, topicId, reportId, 'not_relevant', now);
      return { toast: 'Спасибо, учту' };

    case 'fb:less': {
      await recordFeedback(userId, topicId, reportId, 'less_often', now);
      const next = nextInterval(topic.settings.intervalMinutes);
      if (next === null) return { toast: 'Реже уже нельзя — проверяю раз в сутки' };
      await updateTopic(userId, topicId, { settings: { intervalMinutes: next } });
      return {
        reply: {
          text: `Тема ${quoteLabel(topic)}: теперь проверяю раз в ${INTERVAL_TEXT[next]}.`,
          keyboard: {
            inline_keyboard: [[{ text: 'Отменить', callback_data: `undo:less:${topicId}:${topic.settings.intervalMinutes}` }]],
          },
        },
      };
    }

    case 'fb:off':
      await recordFeedback(userId, topicId, reportId, 'disable_topic', now);
      await updateTopic(userId, topicId, { isActive: false });
      return {
        reply: {
          text: `Тема ${quoteLabel(topic)} отключена.`,
          keyboard: { inline_keyboard: [[{ text: 'Включить обратно', callback_data: `undo:off:${topicId}` }]] },
        },
      };

    case 'undo:less': {
      const prev = Number(rawArg);
      if (!(ALERT_INTERVALS as readonly number[]).includes(prev)) return STALE;
      await updateTopic(userId, topicId, { settings: { intervalMinutes: prev } });
      await recordFeedback(userId, topicId, null, 'undo_less_often', now);
      return { edit: { text: `Тема ${quoteLabel(topic)}: вернул проверку раз в ${INTERVAL_TEXT[prev]}.` } };
    }

    case 'undo:off':
      await updateTopic(userId, topicId, { isActive: true });
      await recordFeedback(userId, topicId, null, 'undo_disable_topic', now);
      return { edit: { text: `Тема ${quoteLabel(topic)} снова включена.` } };

    case 'tp:t':
      await updateTopic(userId, topicId, { isActive: !topic.isActive });
      return { toast: topic.isActive ? 'Тема выключена' : 'Тема включена', edit: await topicsView(userId) };

    case 'tp:s':
      return { edit: topicSettingsView(topic) };

    case 'tp:i': {
      const minutes = Number(rawArg);
      if (!(ALERT_INTERVALS as readonly number[]).includes(minutes)) return STALE;
      const updated = await updateTopic(userId, topicId, { settings: { intervalMinutes: minutes } });
      return { toast: `Раз в ${INTERVAL_TEXT[minutes]}`, edit: topicSettingsView(updated!) };
    }

    case 'tp:l': {
      if (!(URGENCY_LEVELS as readonly string[]).includes(rawArg)) return STALE;
      const updated = await updateTopic(userId, topicId, { settings: { loudFrom: rawArg } });
      return { toast: `Со звуком: ${LOUD_TEXT[rawArg as Urgency]}`, edit: topicSettingsView(updated!) };
    }

    default:
      return STALE;
  }
}
