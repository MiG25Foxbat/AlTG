import { getDb } from './database';

/** Куда доставлять: личка с ботом; группа компании и почта — заложены, пока не используются. */
export type DestinationKind = 'telegram_private' | 'telegram_group' | 'email';

export interface Destination {
  id: number;
  userId: number;
  kind: DestinationKind;
  chatId: number | null;
  threadId: number | null;
  email: string | null;
}

/**
 * Получатель заблокировал бота (403 при отправке или my_chat_member=kicked):
 * помечаем и сразу снимаем с очереди всё, что ему ещё не ушло, — после
 * разблокировки старые алерты уже неактуальны.
 */
export async function markDestinationBlocked(destinationId: number): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      { sql: `UPDATE alert_destinations SET status = 'blocked' WHERE id = ?`, args: [destinationId] },
      {
        sql: `UPDATE outbox SET status = 'failed', locked_at = NULL, last_error = 'получатель заблокировал бота'
              WHERE destination_id = ? AND status IN ('pending', 'sending')`,
        args: [destinationId],
      },
    ],
    'write'
  );
}
