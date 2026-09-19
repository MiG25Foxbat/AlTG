import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { encrypt, decrypt } from '../utils/crypto';

test('encrypt/decrypt: round-trip возвращает исходную строку', () => {
  const original = '1BQANOTEuMTA4LjU2LjE7NTk3MDpFQzY4QzMzMD_example_session_string';
  const payload = encrypt(original);
  assert.notEqual(payload, original);
  assert.equal(decrypt(payload), original);
});

test('encrypt: формат — три base64-части через двоеточие (iv:authTag:ciphertext)', () => {
  const payload = encrypt('test-value');
  const parts = payload.split(':');
  assert.equal(parts.length, 3);
  for (const part of parts) {
    assert.doesNotThrow(() => Buffer.from(part, 'base64'));
  }
});

test('decrypt: испорченный ciphertext бросает ошибку, а не возвращает мусор', () => {
  const payload = encrypt('secret-value');
  const [iv, authTag] = payload.split(':');
  const tampered = `${iv}:${authTag}:${Buffer.from('garbage-data').toString('base64')}`;
  assert.throws(() => decrypt(tampered));
});

test('decrypt: неверный ключ бросает ошибку вместо молчаливо неверного результата', () => {
  const payload = encrypt('secret-value');
  process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  assert.throws(() => decrypt(payload));
});

test('encrypt: без SESSION_ENCRYPTION_KEY бросает понятную ошибку', () => {
  const saved = process.env.SESSION_ENCRYPTION_KEY;
  delete process.env.SESSION_ENCRYPTION_KEY;
  assert.throws(() => encrypt('x'), /SESSION_ENCRYPTION_KEY/);
  process.env.SESSION_ENCRYPTION_KEY = saved;
});
