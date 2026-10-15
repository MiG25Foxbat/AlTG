import { test } from 'node:test';
import assert from 'node:assert/strict';

import { holdUntil, quietEnd, isLoud, HoldInput } from '../modules/AlertModule/holdPolicy';

// Время в МСК → unix-секунды (МСК = UTC+3).
const msk = (iso: string) => Date.parse(`${iso}+03:00`) / 1000;

const base = (over: Partial<HoldInput> = {}): HoldInput => ({
  now: msk('2026-10-15T14:00:00'),
  loud: false,
  settings: { quietEnabled: true, quietFrom: '23:00', quietTo: '08:00', digestHours: 0, maxPerDay: 10 },
  pausedUntil: null,
  firstHeldAt: msk('2026-10-15T14:00:00'),
  releasedToday: 0,
  ...over,
});
const withSettings = (s: Partial<HoldInput['settings']>, over: Partial<HoldInput> = {}) =>
  base({ ...over, settings: { ...base().settings, ...s } });

test('isLoud: срочность не ниже порога подписки', () => {
  assert.equal(isLoud('urgent', 'urgent'), true);
  assert.equal(isLoud('important', 'urgent'), false);
  assert.equal(isLoud('important', 'important'), true);
  assert.equal(isLoud('normal', 'normal'), true);
});

test('quietEnd: окно через полночь и внутри дня, границы', () => {
  assert.equal(quietEnd(msk('2026-10-15T23:30:00'), '23:00', '08:00'), msk('2026-10-16T08:00:00'));
  assert.equal(quietEnd(msk('2026-10-16T02:00:00'), '23:00', '08:00'), msk('2026-10-16T08:00:00'));
  assert.equal(quietEnd(msk('2026-10-16T08:00:00'), '23:00', '08:00'), null); // конец не включается
  assert.equal(quietEnd(msk('2026-10-15T23:00:00'), '23:00', '08:00'), msk('2026-10-16T08:00:00'));
  assert.equal(quietEnd(msk('2026-10-15T14:00:00'), '13:00', '15:00'), msk('2026-10-15T15:00:00'));
  assert.equal(quietEnd(msk('2026-10-15T16:00:00'), '13:00', '15:00'), null);
  assert.equal(quietEnd(msk('2026-10-15T16:00:00'), '10:00', '10:00'), null); // пустое окно
});

test('обычный отчёт днём без задержек — сразу', () => {
  assert.equal(holdUntil(base()), base().now);
});

test('тихие часы: обычное ждёт до конца, громкое — сразу; выключенные тихие часы не держат', () => {
  const night = msk('2026-10-15T23:30:00');
  assert.equal(holdUntil(base({ now: night })), msk('2026-10-16T08:00:00'));
  assert.equal(holdUntil(base({ now: night, loud: true })), night);
  assert.equal(holdUntil(withSettings({ quietEnabled: false }, { now: night })), night);
});

test('пауза: обычное — до конца паузы, громкое пробивает и паузу', () => {
  const until = msk('2026-10-15T15:00:00');
  assert.equal(holdUntil(base({ pausedUntil: until })), until);
  assert.equal(holdUntil(base({ pausedUntil: until, loud: true })), base().now);
  assert.equal(holdUntil(base({ pausedUntil: msk('2026-10-15T13:00:00') })), base().now); // уже кончилась
});

test('пауза кончается в тихие часы — ждём ещё и их', () => {
  const now = msk('2026-10-15T22:30:00');
  assert.equal(holdUntil(base({ now, pausedUntil: msk('2026-10-15T23:30:00') })), msk('2026-10-16T08:00:00'));
});

test('дайджест раз в N часов: от первого придержанного отчёта', () => {
  const first = msk('2026-10-15T12:00:00');
  assert.equal(holdUntil(withSettings({ digestHours: 3 }, { firstHeldAt: first })), msk('2026-10-15T15:00:00'));
  assert.equal(holdUntil(withSettings({ digestHours: 1 }, { firstHeldAt: first })), base().now); // уже пора
  assert.equal(holdUntil(withSettings({ digestHours: 3 }, { firstHeldAt: first, loud: true })), base().now);
  // дайджест выпадает на тихие часы — сдвигается на их конец
  assert.equal(
    holdUntil(withSettings({ digestHours: 12 }, { firstHeldAt: first })),
    msk('2026-10-16T08:00:00')
  );
});

test('дневной лимит: обычное — на завтра (и там ещё тихие часы), громкое — сразу', () => {
  assert.equal(holdUntil(base({ releasedToday: 10 })), msk('2026-10-16T08:00:00'));
  assert.equal(holdUntil(withSettings({ quietEnabled: false }, { releasedToday: 10 })), msk('2026-10-16T00:00:00'));
  assert.equal(holdUntil(base({ releasedToday: 9 })), base().now);
  assert.equal(holdUntil(base({ releasedToday: 10, loud: true })), base().now);
});
