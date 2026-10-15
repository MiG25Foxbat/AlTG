import { TopicSettings, Urgency, URGENCY_LEVELS } from '../../db/alertsRepo';
import { nextMoscowMorning } from '../../utils/time';

/**
 * Когда можно отправить отчёт (unix-секунды; ≤ now — сразу). Чистая функция.
 * Громкое (срочность ≥ порога подписки) идёт сразу — сквозь тихие часы,
 * паузу, дайджест и дневной лимит. Обычное ждёт, пока не кончатся все
 * задержки: тихие часы (МСК), пауза получателя, дайджест (первый
 * придержанный отчёт + N часов), дневной лимит (до полуночи МСК). Задержки
 * могут цепляться друг за друга (лимит → полночь → тихие часы → 08:00),
 * поэтому сдвигаем время, пока оно не перестанет меняться.
 */

const MSK = 3 * 3600;
const DAY = 86400;

export function isLoud(urgency: Urgency, loudFrom: Urgency): boolean {
  return URGENCY_LEVELS.indexOf(urgency) >= URGENCY_LEVELS.indexOf(loudFrom);
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export const mskDay = (t: number) => Math.floor((t + MSK) / DAY);
export const mskDayStart = (t: number) => mskDay(t) * DAY - MSK;

/** Конец тихих часов, если t в них попадает (окно может переходить через полночь); иначе null. */
export function quietEnd(t: number, from: string, to: string): number | null {
  const f = toMinutes(from);
  const e = toMinutes(to);
  if (f === e) return null;
  const m = Math.floor(((t + MSK) % DAY) / 60);
  const inQuiet = f < e ? m >= f && m < e : m >= f || m < e;
  if (!inQuiet) return null;
  let end = mskDayStart(t) + e * 60;
  if (end <= t) end += DAY;
  return end;
}

export interface HoldInput {
  now: number;
  loud: boolean;
  settings: Pick<TopicSettings, 'quietEnabled' | 'quietFrom' | 'quietTo' | 'digestHours' | 'maxPerDay'>;
  pausedUntil: number | null;
  /** Самый ранний ещё не отправленный отчёт подписки — от него считается дайджест */
  firstHeldAt: number;
  /** Сколько алертов по подписке уже ушло сегодня (МСК) */
  releasedToday: number;
}

export function holdUntil(input: HoldInput): number {
  const { now, settings: s } = input;
  if (input.loud) return now;
  let t = now;
  for (let guard = 0; guard < 10; guard++) {
    const before = t;
    if (input.pausedUntil !== null && t < input.pausedUntil) t = input.pausedUntil;
    if (s.quietEnabled) t = quietEnd(t, s.quietFrom, s.quietTo) ?? t;
    if (s.digestHours > 0) t = Math.max(t, input.firstHeldAt + s.digestHours * 3600);
    // Счётчик знаем только за сегодня; завтра он с нуля.
    if (mskDay(t) === mskDay(now) && input.releasedToday >= s.maxPerDay) t = nextMoscowMorning(now, 0);
    if (t === before) return t;
  }
  return t;
}
