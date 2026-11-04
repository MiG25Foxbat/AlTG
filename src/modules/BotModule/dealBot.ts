import { FreebiesSettings, STORES, STORE_LABELS, StoreCode, getFreebiesSettings, updateFreebiesSettings } from '../../db/dealsRepo';
import { getLinkByChat } from '../../db/destinationsRepo';
import { InlineKeyboard, escapeHtml } from '../AlertModule/messageFormat';
import { BotView, CallbackOutcome } from './botActions';

/**
 * Быстрые настройки халявы в боте (/freebies), по образцу /topics. Без grammY и сети,
 * тестируется на in-memory БД. Настройки меняются только через dealsRepo.
 * callback_data: fr:m — главный экран, fr:on — алерты вкл/выкл, fr:bq — пробивать тихие часы,
 * fr:st — список магазинов, fr:s:<код> — магазин вкл/выкл, fr:sa — все магазины.
 */

const STALE: CallbackOutcome = { toast: 'Кнопка устарела' };

/** Кнопка на сайт; Telegram принимает в кнопках только публичные https-адреса (как siteRow в botActions). */
function siteRow(): InlineKeyboard['inline_keyboard'] {
  const url = process.env.PUBLIC_BASE_URL;
  return url?.startsWith('https://') ? [[{ text: '⚙️ Все настройки на сайте', url }]] : [];
}

const mark = (on: boolean) => (on ? '✅' : '⏸');
const storesText = (s: FreebiesSettings) => (s.stores.length ? s.stores.map((c) => STORE_LABELS[c]).join(', ') : 'все');

export async function freebiesView(userId: number): Promise<BotView> {
  const s = await getFreebiesSettings(userId);
  return {
    text:
      '<b>Халява</b>\n' +
      `Акции в бот: ${s.alertsEnabled ? 'включены' : 'выключены'}\n` +
      `Магазины: ${escapeHtml(storesText(s))}\n` +
      `Ночью: ${s.breakQuiet ? 'акции приходят и в тихие часы' : 'акции не приходят в тихие часы и не копятся, утром придут только с неистёкшим сроком'}`,
    keyboard: {
      inline_keyboard: [
        [{ text: `${mark(s.alertsEnabled)} Акции в бот: ${s.alertsEnabled ? 'вкл' : 'выкл'}`, callback_data: 'fr:on' }],
        [{ text: '🛍 Магазины', callback_data: 'fr:st' }],
        [{ text: `${mark(s.breakQuiet)} Пробивать тихие часы`, callback_data: 'fr:bq' }],
        ...siteRow(),
      ],
    },
  };
}

function storesView(s: FreebiesSettings): BotView {
  const picked = s.stores.length ? s.stores : [...STORES];
  return {
    text: '<b>Магазины</b>\nОтметьте, откуда присылать акции. Если выбраны все, присылаю из любых.',
    keyboard: {
      inline_keyboard: [
        ...STORES.map((c) => [{ text: `${mark(picked.includes(c))} ${STORE_LABELS[c]}`, callback_data: `fr:s:${c}` }]),
        [{ text: 'Все магазины', callback_data: 'fr:sa' }],
        [{ text: '« Назад', callback_data: 'fr:m' }],
      ],
    },
  };
}

/** Только для привязанного чата; чужой чат или отвязанный бот получают подсказку. */
export async function handleFreebiesCallback(chatId: number, data: string, now: number): Promise<CallbackOutcome> {
  const link = await getLinkByChat(chatId);
  if (!link) return { toast: 'Бот не привязан к аккаунту — нажмите /start' };
  const userId = link.userId;
  const [, action, arg] = data.split(':');

  switch (action) {
    case 'm':
      return { edit: await freebiesView(userId) };

    case 'on': {
      const s = await updateFreebiesSettings(userId, { alertsEnabled: !(await getFreebiesSettings(userId)).alertsEnabled }, now);
      return { toast: s.alertsEnabled ? 'Акции включены' : 'Акции выключены', edit: await freebiesView(userId) };
    }

    case 'bq': {
      const s = await updateFreebiesSettings(userId, { breakQuiet: !(await getFreebiesSettings(userId)).breakQuiet }, now);
      return { toast: s.breakQuiet ? 'Акции будут приходить и ночью' : 'Ночью акции не приходят', edit: await freebiesView(userId) };
    }

    case 'st':
      return { edit: storesView(await getFreebiesSettings(userId)) };

    case 'sa':
      return { toast: 'Все магазины', edit: storesView(await updateFreebiesSettings(userId, { stores: [] }, now)) };

    case 's': {
      if (!(STORES as readonly string[]).includes(arg)) return STALE;
      const code = arg as StoreCode;
      const current = (await getFreebiesSettings(userId)).stores;
      const picked: StoreCode[] = current.length ? current : [...STORES];
      const next = picked.includes(code) ? picked.filter((c) => c !== code) : [...picked, code];
      if (next.length === 0) return { toast: 'Нужен хотя бы один магазин' };
      // Все отмечены = пустой список (так хранится «любые»).
      const s = await updateFreebiesSettings(userId, { stores: next.length === STORES.length ? [] : next }, now);
      return { edit: storesView(s) };
    }

    default:
      return STALE;
  }
}
