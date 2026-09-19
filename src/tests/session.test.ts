import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.SESSION_ENCRYPTION_KEY = randomBytes(32).toString('base64');

import { createSessionToken, verifySessionToken, parseCookies, SESSION_COOKIE_NAME } from '../utils/session';

test('createSessionToken/verifySessionToken: round-trip возвращает тот же userId', () => {
  const { token } = createSessionToken(42);
  assert.equal(verifySessionToken(token), 42);
});

test('verifySessionToken: подделанная подпись отклоняется', () => {
  const { token } = createSessionToken(1);
  const [userId, expiresAt] = token.split('.');
  const tampered = `${userId}.${expiresAt}.forged-signature`;
  assert.equal(verifySessionToken(tampered), null);
});

test('verifySessionToken: изменённый userId при старой подписи отклоняется', () => {
  const { token } = createSessionToken(1);
  const [, expiresAt, signature] = token.split('.');
  const tampered = `2.${expiresAt}.${signature}`;
  assert.equal(verifySessionToken(tampered), null);
});

test('verifySessionToken: истёкший (но честно подписанный) токен отклоняется', () => {
  const { token } = createSessionToken(7);
  const realNow = Date.now;
  try {
    // Переводим "текущее время" на 31 день вперёд — за пределы TTL (30 дней),
    // подпись при этом настоящая (создавалась через ту же sign()), проверяем
    // именно проверку срока действия, а не подписи.
    Date.now = () => realNow() + 31 * 24 * 60 * 60 * 1000;
    assert.equal(verifySessionToken(token), null);
  } finally {
    Date.now = realNow;
  }
});

test('verifySessionToken: мусор/пустая строка/undefined — null, а не исключение', () => {
  assert.equal(verifySessionToken(undefined), null);
  assert.equal(verifySessionToken(''), null);
  assert.equal(verifySessionToken('not-a-token'), null);
  assert.equal(verifySessionToken('a.b.c.d'), null);
});

test('parseCookies: разбирает несколько кук через "; ", игнорирует мусор без "="', () => {
  const cookies = parseCookies(`${SESSION_COOKIE_NAME}=abc123; other=xyz; garbage`);
  assert.equal(cookies[SESSION_COOKIE_NAME], 'abc123');
  assert.equal(cookies.other, 'xyz');
  assert.equal(cookies.garbage, undefined);
});

test('parseCookies: undefined-заголовок даёт пустой объект', () => {
  assert.deepEqual(parseCookies(undefined), {});
});
