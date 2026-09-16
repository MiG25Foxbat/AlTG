import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowMinutesToCutoff, formatMoscowTime, InvalidTimeWindowError, TIME_WINDOW_OPTIONS } from '../utils/time';

test('windowMinutesToCutoff: считает точную отсечку для каждого разрешённого пресета', () => {
  const now = new Date('2026-09-14T12:00:00Z');
  for (const option of TIME_WINDOW_OPTIONS) {
    const cutoff = windowMinutesToCutoff(option.minutes, now);
    const expected = Math.floor(now.getTime() / 1000) - option.minutes * 60;
    assert.equal(cutoff, expected, `период ${option.minutes} мин`);
  }
});

test('windowMinutesToCutoff: отклоняет период, которого нет среди пресетов', () => {
  assert.throws(() => windowMinutesToCutoff(45), InvalidTimeWindowError);
  assert.throws(() => windowMinutesToCutoff(0), InvalidTimeWindowError);
  assert.throws(() => windowMinutesToCutoff(-15), InvalidTimeWindowError);
});

test('formatMoscowTime: переводит unix-время в московское (UTC+3) вне зависимости от TZ сервера', () => {
  // 14 сентября 2026, 12:00 UTC -> 15:00 в Москве
  const unixSeconds = Date.UTC(2026, 8, 14, 12, 0, 0) / 1000;
  const formatted = formatMoscowTime(unixSeconds);
  assert.ok(formatted.includes('14.09'), `ожидали дату 14.09, получили "${formatted}"`);
  assert.ok(formatted.includes('15:00'), `ожидали время 15:00, получили "${formatted}"`);
});

test('formatMoscowTime: корректно переносит через полночь при пересчёте в московское время', () => {
  // 14 сентября 2026, 22:30 UTC -> 15 сентября, 01:30 в Москве
  const unixSeconds = Date.UTC(2026, 8, 14, 22, 30, 0) / 1000;
  const formatted = formatMoscowTime(unixSeconds);
  assert.ok(formatted.includes('15.09'), `ожидали дату 15.09, получили "${formatted}"`);
  assert.ok(formatted.includes('01:30'), `ожидали время 01:30, получили "${formatted}"`);
});
