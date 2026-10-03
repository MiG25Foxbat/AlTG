import { getDb } from './database';

export interface ChannelRow {
  user_id: number;
  channel_identifier: string;
  channel_title: string | null;
  is_private: 0 | 1;
  is_active: 0 | 1;
  added_at: number;
  group_id: number | null;
}

export interface ChannelDto {
  username: string;
  title: string | null;
  addedAt: number;
  isActive: boolean;
  isPrivate: boolean;
  groupId: number | null;
}

function toDto(row: ChannelRow): ChannelDto {
  return {
    username: row.channel_identifier,
    title: row.channel_title,
    addedAt: row.added_at,
    isActive: row.is_active === 1,
    isPrivate: row.is_private === 1,
    groupId: row.group_id ?? null,
  };
}

/** Приводит ввод пользователя к единому формату: всегда с "@", без пробелов, без ссылки t.me/. */
export function normalizeChannelUsername(raw: string): string {
  let value = raw.trim();
  value = value.replace(/^https?:\/\/(t|telegram)\.me\//i, '');
  value = value.replace(/^@/, '');
  if (!value) {
    throw new Error('Пустое имя канала');
  }
  if (!/^[a-zA-Z0-9_]{4,64}$/.test(value)) {
    throw new Error('Похоже, это не имя публичного канала (пример: @channel_name)');
  }
  return `@${value}`;
}

/**
 * Параметр :username в URL: у публичных каналов это имя (нормализуем как
 * обычно), у приватных — числовой id вида -100123…, который через
 * normalizeChannelUsername не проходит и должен оставаться как есть.
 */
export function parseChannelParam(raw: string): string {
  return /^-?\d+$/.test(raw) ? raw : normalizeChannelUsername(raw);
}

/** Сколько каналов пользователя реально мониторится (с учётом выключенных групп). */
export async function countMonitoredChannels(userId: number): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM monitored_channels WHERE user_id = ?',
    args: [userId],
  });
  return Number((result.rows[0] as unknown as { n: number }).n);
}

export async function listChannels(userId: number): Promise<ChannelDto[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM user_channels WHERE user_id = ? ORDER BY added_at DESC',
    args: [userId],
  });
  return (result.rows as unknown as ChannelRow[]).map(toDto);
}

/** Публичные каналы — читает общий системный бот, см. listActivePrivateChannelIds для приватных. */
export async function listActiveChannelUsernames(userId: number): Promise<string[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT channel_identifier FROM monitored_channels WHERE user_id = ? AND is_private = 0',
    args: [userId],
  });
  return (result.rows as unknown as { channel_identifier: string }[]).map(
    (r) => r.channel_identifier
  );
}

export async function getChannel(
  userId: number,
  identifier: string
): Promise<ChannelDto | undefined> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM user_channels WHERE user_id = ? AND channel_identifier = ?',
    args: [userId, identifier],
  });
  const row = result.rows[0] as unknown as ChannelRow | undefined;
  return row ? toDto(row) : undefined;
}

export async function upsertChannel(
  userId: number,
  identifier: string,
  title: string | null,
  isPrivate = false
): Promise<ChannelDto> {
  const db = await getDb();
  const existing = await getChannel(userId, identifier);
  if (existing) {
    await db.execute({
      sql: 'UPDATE user_channels SET channel_title = COALESCE(?, channel_title) WHERE user_id = ? AND channel_identifier = ?',
      args: [title, userId, identifier],
    });
  } else {
    await db.execute({
      sql: 'INSERT INTO user_channels (user_id, channel_identifier, channel_title, is_private, added_at, is_active) VALUES (?, ?, ?, ?, ?, 1)',
      args: [userId, identifier, title, isPrivate ? 1 : 0, Math.floor(Date.now() / 1000)],
    });
  }
  return (await getChannel(userId, identifier))!;
}

/** Идентификаторы приватных каналов, активных у пользователя — для fetchService. */
export async function listActivePrivateChannelIds(userId: number): Promise<string[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT channel_identifier FROM monitored_channels WHERE user_id = ? AND is_private = 1',
    args: [userId],
  });
  return (result.rows as unknown as { channel_identifier: string }[]).map((r) => r.channel_identifier);
}

export async function setChannelActive(
  userId: number,
  identifier: string,
  isActive: boolean
): Promise<ChannelDto | undefined> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE user_channels SET is_active = ? WHERE user_id = ? AND channel_identifier = ?',
    args: [isActive ? 1 : 0, userId, identifier],
  });
  return getChannel(userId, identifier);
}

export async function removeChannel(userId: number, identifier: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'DELETE FROM user_channels WHERE user_id = ? AND channel_identifier = ?',
    args: [userId, identifier],
  });
  return result.rowsAffected > 0;
}
