import { CollectedMessage } from './windowPagination';

/**
 * Часть интерфейса UserBot, которая реально нужна слоям FetchModule/AiModule/App —
 * только чтение. Выделена отдельно, чтобы в тестах можно было подставить
 * фейковую реализацию вместо живого подключения к Telegram, не трогая
 * настоящий UserBot и не мокая GramJS целиком.
 */
export interface IUserBotReader {
  resolveChannel(channel: string): Promise<{ title: string | null } | null>;
  getMessagesInWindow(
    channel: string,
    cutoffUnixSeconds: number,
    maxMessages?: number
  ): Promise<CollectedMessage[]>;
}
