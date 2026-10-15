import { getDb } from './database';
import { listChannels } from './channelsRepo';

/** Как часто проверять — только из пресетов периода (utils/time.ts); они же шаги кнопки «Реже». */
export const ALERT_INTERVALS = [15, 30, 60, 180, 300, 600, 1440] as const;

/** Уровни срочности, которые ставит модель, — по возрастанию. */
export const URGENCY_LEVELS = ['normal', 'important', 'urgent'] as const;
export type Urgency = (typeof URGENCY_LEVELS)[number];

/**
 * Подписка = тема (строка topics) + где ищем + эти настройки. У каждой
 * подписки свои — общего набора на пользователя больше нет.
 */
export interface TopicSettings {
  intervalMinutes: number;
  /** 'all' — все отслеживаемые каналы, 'groups' — каналы из groupIds, 'channels' — из channels */
  scope: 'all' | 'groups' | 'channels';
  groupIds: number[];
  channels: string[];
  /** 0 — присылать сразу; N — обычные отчёты копятся и приходят раз в N часов */
  digestHours: number;
  quietEnabled: boolean;
  quietFrom: string;
  quietTo: string;
  /** С какого уровня срочности алерт громкий: со звуком и сквозь тихие часы, паузу и дайджест */
  loudFrom: Urgency;
  /** Не присылать, если подтверждённых пунктов меньше этого числа */
  minMatches: number;
  maxPerDay: number;
}

export const DEFAULT_TOPIC_SETTINGS: TopicSettings = {
  intervalMinutes: 60,
  scope: 'all',
  groupIds: [],
  channels: [],
  digestHours: 0,
  quietEnabled: true,
  quietFrom: '23:00',
  quietTo: '08:00',
  loudFrom: 'urgent',
  minMatches: 1,
  maxPerDay: 10,
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Граница доверия: из запроса/БД берём только известные поля с допустимыми значениями. */
export function sanitizeTopicSettings(input: any): TopicSettings {
  const d = DEFAULT_TOPIC_SETTINGS;
  const src = input && typeof input === 'object' ? input : {};
  const time = (v: unknown, fallback: string) => (typeof v === 'string' && TIME_RE.test(v) ? v : fallback);
  return {
    intervalMinutes: (ALERT_INTERVALS as readonly number[]).includes(Number(src.intervalMinutes))
      ? Number(src.intervalMinutes)
      : d.intervalMinutes,
    scope: src.scope === 'groups' || src.scope === 'channels' ? src.scope : 'all',
    groupIds: Array.isArray(src.groupIds)
      ? ([...new Set(src.groupIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] as number[])
      : [],
    channels: Array.isArray(src.channels)
      ? [...new Set(src.channels.filter((c: unknown) => typeof c === 'string' && c.trim() && c.length <= 100).map((c: string) => c.trim()))]
          .slice(0, 500) as string[]
      : [],
    digestHours: clampInt(src.digestHours, 0, 24, d.digestHours),
    quietEnabled: src.quietEnabled === undefined ? d.quietEnabled : src.quietEnabled === true,
    quietFrom: time(src.quietFrom, d.quietFrom),
    quietTo: time(src.quietTo, d.quietTo),
    loudFrom: (URGENCY_LEVELS as readonly string[]).includes(src.loudFrom) ? src.loudFrom : d.loudFrom,
    minMatches: clampInt(src.minMatches, 1, 50, d.minMatches),
    maxPerDay: clampInt(src.maxPerDay, 1, 100, d.maxPerDay),
  };
}

export interface TopicDto {
  id: number;
  label: string;
  isActive: boolean;
  settings: TopicSettings;
}

export interface TopicRow {
  id: number;
  label: string;
  is_active: number;
  settings_json: string | null;
}

export function topicFromRow(r: TopicRow): TopicDto {
  return {
    id: r.id,
    label: r.label,
    isActive: r.is_active === 1,
    settings: sanitizeTopicSettings(r.settings_json ? JSON.parse(r.settings_json) : null),
  };
}

function parseLabel(raw: unknown): string {
  const label = typeof raw === 'string' ? raw.trim() : '';
  if (!label) throw new Error('Введите тему');
  if (label.length > 200) throw new Error('Тема — не длиннее 200 символов');
  return label;
}

export async function listTopics(userId: number): Promise<TopicDto[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT id, label, is_active, settings_json FROM topics WHERE user_id = ? ORDER BY created_at, id',
    args: [userId],
  });
  return (result.rows as unknown as TopicRow[]).map(topicFromRow);
}

export async function getTopic(userId: number, topicId: number): Promise<TopicDto | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT id, label, is_active, settings_json FROM topics WHERE id = ? AND user_id = ?',
    args: [topicId, userId],
  });
  const row = result.rows[0] as unknown as TopicRow | undefined;
  return row ? topicFromRow(row) : undefined;
}

export async function addTopic(userId: number, rawLabel: unknown, rawSettings?: unknown): Promise<TopicDto> {
  const label = parseLabel(rawLabel);
  const settings = sanitizeTopicSettings(rawSettings);
  const db = await getDb();
  const result = await db.execute({
    sql: 'INSERT INTO topics (user_id, label, is_active, created_at, settings_json) VALUES (?, ?, 1, ?, ?)',
    args: [userId, label, Math.floor(Date.now() / 1000), JSON.stringify(settings)],
  });
  return { id: Number(result.lastInsertRowid), label, isActive: true, settings };
}

/** Частичное обновление: settings сливаются с текущими (бот меняет по одному полю). */
export async function updateTopic(
  userId: number,
  topicId: number,
  patch: { label?: unknown; isActive?: unknown; settings?: unknown }
): Promise<TopicDto | undefined> {
  const current = await getTopic(userId, topicId);
  if (!current) return undefined;
  const label = patch.label === undefined ? current.label : parseLabel(patch.label);
  const isActive = patch.isActive === undefined ? current.isActive : patch.isActive === true;
  const settings =
    patch.settings && typeof patch.settings === 'object'
      ? sanitizeTopicSettings({ ...current.settings, ...patch.settings })
      : current.settings;
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE topics SET label = ?, is_active = ?, settings_json = ? WHERE id = ? AND user_id = ?',
    args: [label, isActive ? 1 : 0, JSON.stringify(settings), topicId, userId],
  });
  return { id: topicId, label, isActive, settings };
}

export async function deleteTopic(userId: number, topicId: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({ sql: 'DELETE FROM topics WHERE id = ? AND user_id = ?', args: [topicId, userId] });
  return result.rowsAffected > 0;
}

/**
 * Каналы, по которым ищет подписка: undefined — все отслеживаемые, иначе
 * набор идентификаторов (может оказаться пустым — это решает вызывающий).
 * Включён ли канал/группа, дальше всё равно решает view monitored_channels.
 */
export async function resolveTopicChannels(userId: number, settings: TopicSettings): Promise<Set<string> | undefined> {
  if (settings.scope === 'all') return undefined;
  const channels = await listChannels(userId);
  return new Set(
    channels
      .filter((c) =>
        settings.scope === 'groups'
          ? c.groupId !== null && settings.groupIds.includes(c.groupId)
          : settings.channels.includes(c.username)
      )
      .map((c) => c.username)
  );
}

export type FeedbackAction = 'not_relevant' | 'less_often' | 'disable_topic' | 'undo_less_often' | 'undo_disable_topic';

/** Нажатия кнопок под алертом — отдельной таблицей, чтобы потом смотреть качество. */
export async function recordFeedback(
  userId: number,
  topicId: number,
  reportId: number | null,
  action: FeedbackAction,
  now: number
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'INSERT INTO alert_feedback (user_id, topic_id, report_id, action, created_at) VALUES (?, ?, ?, ?, ?)',
    args: [userId, topicId, reportId, action, now],
  });
}
