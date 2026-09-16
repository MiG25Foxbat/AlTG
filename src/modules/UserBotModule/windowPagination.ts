/**
 * Чистая логика постраничного сбора сообщений "не старше cutoff" —
 * вынесена отдельно от UserBot, чтобы её можно было протестировать без
 * реального подключения к Telegram (см. src/tests/windowMessages.test.ts).
 * UserBot.getMessagesInWindow — тонкая обёртка, которая просто подставляет
 * сюда живой client.getMessages в качестве fetchPage.
 */

export interface RawMessage {
  id: number;
  /** Сырое поле текста, как у GramJS (Api.Message.message) */
  message: string;
  /** unix-время в секундах */
  date: number;
}

export interface CollectedMessage {
  id: number;
  text: string;
  date: number;
}

/** Запрашивает одну страницу сообщений старше offsetId (0 — с самого новых). */
export type PageFetcher = (offsetId: number) => Promise<RawMessage[]>;

export async function collectMessagesInWindow(
  fetchPage: PageFetcher,
  cutoffUnixSeconds: number,
  maxMessages: number
): Promise<CollectedMessage[]> {
  const result: CollectedMessage[] = [];
  let offsetId = 0;

  while (result.length < maxMessages) {
    const page = await fetchPage(offsetId);
    if (!page || page.length === 0) {
      break; // дошли до начала истории канала
    }

    let reachedCutoff = false;
    for (const message of page) {
      if (message.date < cutoffUnixSeconds) {
        reachedCutoff = true;
        break; // дальше по истории будут только ещё более старые посты
      }
      const text = (message.message || '').trim();
      if (text) {
        result.push({ id: message.id, text, date: message.date });
      }
      if (result.length >= maxMessages) {
        break;
      }
    }

    offsetId = page[page.length - 1].id;
    if (reachedCutoff) break;
  }

  return result;
}
