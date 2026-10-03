import { getDb } from './database';

/** Как часто проверять — только из пресетов периода (utils/time.ts), окно поиска = интервал. */
export const ALERT_INTERVALS = [15, 30, 60, 180, 300, 600, 1440] as const;

export interface AlertSettings {
  enabled: boolean;
  intervalMinutes: number;
  /** 'all' — все отслеживаемые каналы, 'groups' — только каналы из groupIds */
  scope: 'all' | 'groups';
  groupIds: number[];
  /** 'instant' — после каждой проверки с находками, 'digest' — одна сводка в digestTime */
  mode: 'instant' | 'digest';
  digestTime: string;
  quietEnabled: boolean;
  quietFrom: string;
  quietTo: string;
  /** Не присылать, если релевантных постов меньше этого числа */
  minMatches: number;
  maxPerDay: number;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  enabled: false,
  intervalMinutes: 60,
  scope: 'all',
  groupIds: [],
  mode: 'instant',
  digestTime: '09:00',
  quietEnabled: true,
  quietFrom: '23:00',
  quietTo: '08:00',
  minMatches: 1,
  maxPerDay: 10,
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Граница доверия: из запроса берём только известные поля с допустимыми значениями. */
export function sanitizeAlertSettings(input: any): AlertSettings {
  const d = DEFAULT_ALERT_SETTINGS;
  const src = input && typeof input === 'object' ? input : {};
  const time = (v: unknown, fallback: string) => (typeof v === 'string' && TIME_RE.test(v) ? v : fallback);
  return {
    enabled: src.enabled === true,
    intervalMinutes: (ALERT_INTERVALS as readonly number[]).includes(Number(src.intervalMinutes))
      ? Number(src.intervalMinutes)
      : d.intervalMinutes,
    scope: src.scope === 'groups' ? 'groups' : 'all',
    groupIds: Array.isArray(src.groupIds)
      ? [...new Set(src.groupIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] as number[]
      : [],
    mode: src.mode === 'digest' ? 'digest' : 'instant',
    digestTime: time(src.digestTime, d.digestTime),
    quietEnabled: src.quietEnabled === undefined ? d.quietEnabled : src.quietEnabled === true,
    quietFrom: time(src.quietFrom, d.quietFrom),
    quietTo: time(src.quietTo, d.quietTo),
    minMatches: clampInt(src.minMatches, 1, 50, d.minMatches),
    maxPerDay: clampInt(src.maxPerDay, 1, 100, d.maxPerDay),
  };
}

export async function getAlertSettings(userId: number): Promise<AlertSettings> {
  const db = await getDb();
  const result = await db.execute({ sql: 'SELECT settings_json FROM alert_settings WHERE user_id = ?', args: [userId] });
  const row = result.rows[0] as unknown as { settings_json: string } | undefined;
  return sanitizeAlertSettings(row ? JSON.parse(row.settings_json) : DEFAULT_ALERT_SETTINGS);
}

export async function saveAlertSettings(userId: number, input: unknown): Promise<AlertSettings> {
  const settings = sanitizeAlertSettings(input);
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO alert_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
    args: [userId, JSON.stringify(settings), Math.floor(Date.now() / 1000)],
  });
  return settings;
}

// --- Темы алертов: таблица topics из docs/tech-stack-final.md (5.3) ---

export interface TopicDto {
  id: number;
  label: string;
  isActive: boolean;
}

export async function listTopics(userId: number): Promise<TopicDto[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT id, label, is_active FROM topics WHERE user_id = ? ORDER BY created_at',
    args: [userId],
  });
  return (result.rows as unknown as { id: number; label: string; is_active: number }[]).map((r) => ({
    id: r.id,
    label: r.label,
    isActive: r.is_active === 1,
  }));
}

export async function addTopic(userId: number, rawLabel: unknown): Promise<TopicDto> {
  const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
  if (!label) throw new Error('Введите тему');
  if (label.length > 200) throw new Error('Тема — не длиннее 200 символов');
  const db = await getDb();
  const result = await db.execute({
    sql: 'INSERT INTO topics (user_id, label, is_active, created_at) VALUES (?, ?, 1, ?)',
    args: [userId, label, Math.floor(Date.now() / 1000)],
  });
  return { id: Number(result.lastInsertRowid), label, isActive: true };
}

export async function setTopicActive(userId: number, topicId: number, isActive: boolean): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'UPDATE topics SET is_active = ? WHERE id = ? AND user_id = ?',
    args: [isActive ? 1 : 0, topicId, userId],
  });
  return result.rowsAffected > 0;
}

export async function deleteTopic(userId: number, topicId: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({ sql: 'DELETE FROM topics WHERE id = ? AND user_id = ?', args: [topicId, userId] });
  return result.rowsAffected > 0;
}
