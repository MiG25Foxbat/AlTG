/**
 * Пресеты периода "за какое время получить посты" — ровно те восемь
 * значений, которые заданы в требованиях к интерфейсу.
 */
export interface TimeWindowOption {
  /** Значение в минутах — используется как id и как параметр запроса */
  minutes: number;
  /** Подпись для кнопки в интерфейсе */
  label: string;
}

export const TIME_WINDOW_OPTIONS: TimeWindowOption[] = [
  { minutes: 5, label: '5 мин' },
  { minutes: 15, label: '15 мин' },
  { minutes: 30, label: '30 мин' },
  { minutes: 60, label: '1 ч' },
  { minutes: 180, label: '3 ч' },
  { minutes: 300, label: '5 ч' },
  { minutes: 420, label: '7 ч' },
  { minutes: 600, label: '10 ч' },
];

const ALLOWED_MINUTES = new Set(TIME_WINDOW_OPTIONS.map((o) => o.minutes));

export class InvalidTimeWindowError extends Error {
  constructor(value: unknown) {
    super(`Недопустимый период: ${String(value)}. Разрешены: ${[...ALLOWED_MINUTES].join(', ')}`);
    this.name = 'InvalidTimeWindowError';
  }
}

/**
 * Проверяет, что запрошенный период — один из восьми разрешённых пресетов,
 * и возвращает unix-время (в секундах) отсечки: посты старше этого момента
 * в выдачу не попадают.
 *
 * Сознательно НЕ принимает произвольные числа минут — список пресетов
 * фиксирован требованиями интерфейса, а не служебное ограничение.
 */
export function windowMinutesToCutoff(minutes: number, now: Date = new Date()): number {
  if (!ALLOWED_MINUTES.has(minutes)) {
    throw new InvalidTimeWindowError(minutes);
  }
  return Math.floor(now.getTime() / 1000) - minutes * 60;
}

/**
 * Человекочитаемое время поста в московском часовом поясе — именно так,
 * как его увидит пользователь, независимо от того, где физически
 * запущен сервер.
 */
export function formatMoscowTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
