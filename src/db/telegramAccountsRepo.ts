import { getDb } from './database';
import { encrypt, decrypt } from '../utils/crypto';

export interface DecryptedAccount {
  telegramUserId: number;
  phoneNumber: string;
  sessionString: string;
}

/** Есть ли уже привязанный Telegram-аккаунт у этого пользователя. */
export async function hasAccount(userId: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT 1 FROM telegram_accounts WHERE user_id = ?',
    args: [userId],
  });
  return result.rows.length > 0;
}

/**
 * Сохраняет Telegram-аккаунт пользователя. session_string и phone_number
 * шифруются перед записью (docs/tech-stack-final.md, 5.4) — открытым
 * текстом в БД не попадают никогда. Один пользователь — один аккаунт
 * (UNIQUE user_id в схеме), повторный вызов обновляет запись.
 */
export async function upsertAccount(
  userId: number,
  account: { telegramUserId: number; phoneNumber: string; sessionString: string }
): Promise<void> {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: `INSERT INTO telegram_accounts
            (user_id, telegram_user_id, phone_number_encrypted, session_string_encrypted, connected_at, session_last_used_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            telegram_user_id = excluded.telegram_user_id,
            phone_number_encrypted = excluded.phone_number_encrypted,
            session_string_encrypted = excluded.session_string_encrypted,
            session_last_used_at = excluded.session_last_used_at`,
    args: [
      userId,
      account.telegramUserId,
      encrypt(account.phoneNumber),
      encrypt(account.sessionString),
      now,
      now,
    ],
  });
}

/**
 * Расшифровывает и возвращает аккаунт для одноразового использования
 * (например, создание клиента teleproto на один цикл чтения). Вызывающий
 * код не должен сохранять расшифрованные поля дольше одного вызова —
 * это по дизайну (5.5 дока), не гарантируется на уровне типов.
 */
export async function getDecryptedAccount(userId: number): Promise<DecryptedAccount | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT telegram_user_id, phone_number_encrypted, session_string_encrypted FROM telegram_accounts WHERE user_id = ?',
    args: [userId],
  });
  if (result.rows.length === 0) return undefined;
  const row = result.rows[0] as unknown as {
    telegram_user_id: number;
    phone_number_encrypted: string;
    session_string_encrypted: string;
  };
  return {
    telegramUserId: row.telegram_user_id,
    phoneNumber: decrypt(row.phone_number_encrypted),
    sessionString: decrypt(row.session_string_encrypted),
  };
}
