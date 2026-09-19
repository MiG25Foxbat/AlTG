import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.DB_PATH = ':memory:';
process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { closeDb } from '../db/database';
import { getOrCreateSoleUser } from '../db/usersRepo';
import { hasAccount, upsertAccount, getDecryptedAccount } from '../db/telegramAccountsRepo';

test('getOrCreateSoleUser: первый вызов создаёт пользователя, повторный возвращает того же', async () => {
  const id1 = await getOrCreateSoleUser();
  const id2 = await getOrCreateSoleUser();
  assert.equal(id1, id2);
  closeDb();
});

test('telegramAccountsRepo: upsert -> hasAccount -> getDecryptedAccount возвращает исходные значения', async () => {
  const userId = await getOrCreateSoleUser();
  assert.equal(await hasAccount(userId), false);

  await upsertAccount(userId, {
    telegramUserId: 123456789,
    phoneNumber: '79991234567',
    sessionString: 'FAKE_SESSION_STRING_VALUE',
  });

  assert.equal(await hasAccount(userId), true);

  const account = await getDecryptedAccount(userId);
  assert.deepEqual(account, {
    telegramUserId: 123456789,
    phoneNumber: '79991234567',
    sessionString: 'FAKE_SESSION_STRING_VALUE',
  });
  closeDb();
});

test('telegramAccountsRepo: повторный upsert для того же userId обновляет запись, а не дублирует', async () => {
  const userId = await getOrCreateSoleUser();
  await upsertAccount(userId, {
    telegramUserId: 111,
    phoneNumber: '111',
    sessionString: 'first',
  });
  await upsertAccount(userId, {
    telegramUserId: 222,
    phoneNumber: '222',
    sessionString: 'second',
  });
  const account = await getDecryptedAccount(userId);
  assert.equal(account?.sessionString, 'second');
  closeDb();
});
