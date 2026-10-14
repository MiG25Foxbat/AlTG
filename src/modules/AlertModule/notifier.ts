import { Destination } from '../../db/destinationsRepo';
import { InlineKeyboard } from './messageFormat';

export interface OutgoingMessage {
  textHtml: string;
  disableNotification: boolean;
  replyMarkup: InlineKeyboard | null;
}

/** Итог отправки — отправщик по нему решает: готово / подождать / получатель недоступен / повторить. */
export type SendResult =
  | { ok: true }
  | { ok: false; kind: 'retry_after'; seconds: number }
  | { ok: false; kind: 'blocked' }
  | { ok: false; kind: 'error'; message: string };

/**
 * Канал доставки (ТЗ п. 5). Сейчас только Telegram; почта для компаний —
 * ещё один класс с этим интерфейсом и kind = 'email' у получателя.
 */
export interface Notifier {
  send(destination: Destination, message: OutgoingMessage): Promise<SendResult>;
}

/**
 * Bot API sendMessage голым fetch — без зависимостей. Токен только в URL
 * запроса; в ошибки и логи он не попадает.
 */
export class TelegramNotifier implements Notifier {
  constructor(private readonly token: string, private readonly fetchFn: typeof fetch = fetch) {}

  async send(destination: Destination, message: OutgoingMessage): Promise<SendResult> {
    if (destination.chatId === null) return { ok: false, kind: 'error', message: 'у получателя нет chat_id' };

    let response: Response;
    try {
      response = await this.fetchFn(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: destination.chatId,
          message_thread_id: destination.threadId ?? undefined,
          text: message.textHtml,
          parse_mode: 'HTML',
          disable_notification: message.disableNotification,
          reply_markup: message.replyMarkup ?? undefined,
          link_preview_options: { is_disabled: true },
        }),
      });
    } catch (error: any) {
      return { ok: false, kind: 'error', message: `сеть: ${error?.cause?.code || error?.message || 'ошибка'}` };
    }

    const data: any = await response.json().catch(() => ({}));
    if (response.ok && data?.ok) return { ok: true };
    if (response.status === 429) return { ok: false, kind: 'retry_after', seconds: Number(data?.parameters?.retry_after) || 5 };
    if (response.status === 403) return { ok: false, kind: 'blocked' };
    return { ok: false, kind: 'error', message: `${response.status} ${String(data?.description || '').slice(0, 200)}` };
  }
}
