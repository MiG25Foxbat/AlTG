import { getDb } from './database';

export interface ChannelRow {
  username: string;
  title: string | null;
  added_at: number;
  is_active: 0 | 1;
}

export interface ChannelDto {
  username: string;
  title: string | null;
  addedAt: number;
  isActive: boolean;
}

function toDto(row: ChannelRow): ChannelDto {
  return {
    username: row.username,
    title: row.title,
    addedAt: row.added_at,
    isActive: row.is_active === 1,
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

export function listChannels(): ChannelDto[] {
  const rows = getDb()
    .prepare('SELECT * FROM channels ORDER BY added_at DESC')
    .all() as unknown as ChannelRow[];
  return rows.map(toDto);
}

export function listActiveChannelUsernames(): string[] {
  const rows = getDb()
    .prepare('SELECT username FROM channels WHERE is_active = 1')
    .all() as unknown as { username: string }[];
  return rows.map((r) => r.username);
}

export function getChannel(username: string): ChannelDto | undefined {
  const row = getDb()
    .prepare('SELECT * FROM channels WHERE username = ?')
    .get(username) as unknown as ChannelRow | undefined;
  return row ? toDto(row) : undefined;
}

export function upsertChannel(username: string, title: string | null): ChannelDto {
  const db = getDb();
  const existing = getChannel(username);
  if (existing) {
    db.prepare('UPDATE channels SET title = COALESCE(?, title) WHERE username = ?').run(title, username);
  } else {
    db.prepare('INSERT INTO channels (username, title, added_at, is_active) VALUES (?, ?, ?, 1)').run(
      username,
      title,
      Math.floor(Date.now() / 1000)
    );
  }
  return getChannel(username)!;
}

export function setChannelActive(username: string, isActive: boolean): ChannelDto | undefined {
  getDb().prepare('UPDATE channels SET is_active = ? WHERE username = ?').run(isActive ? 1 : 0, username);
  return getChannel(username);
}

export function removeChannel(username: string): boolean {
  const result = getDb().prepare('DELETE FROM channels WHERE username = ?').run(username);
  return result.changes > 0;
}
