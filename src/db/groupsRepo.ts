import { getDb } from './database';

export interface GroupDto {
  id: number;
  name: string;
  isActive: boolean;
}

interface GroupRow {
  id: number;
  name: string;
  is_active: 0 | 1;
}

const toDto = (r: GroupRow): GroupDto => ({ id: r.id, name: r.name, isActive: r.is_active === 1 });

export function normalizeGroupName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new Error('Введите название группы');
  if (name.length > 60) throw new Error('Название группы — не длиннее 60 символов');
  return name;
}

export async function listGroups(userId: number): Promise<GroupDto[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT id, name, is_active FROM channel_groups WHERE user_id = ? ORDER BY name COLLATE NOCASE',
    args: [userId],
  });
  return (result.rows as unknown as GroupRow[]).map(toDto);
}

export async function createGroup(userId: number, name: string): Promise<GroupDto> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'INSERT INTO channel_groups (user_id, name, is_active, created_at) VALUES (?, ?, 1, ?)',
    args: [userId, name, Math.floor(Date.now() / 1000)],
  });
  return { id: Number(result.lastInsertRowid), name, isActive: true };
}

/** Каждое изменение группы — только в пределах её владельца (user_id в WHERE). */
export async function updateGroup(
  userId: number,
  groupId: number,
  patch: { name?: string; isActive?: boolean }
): Promise<GroupDto | undefined> {
  const db = await getDb();
  if (patch.name !== undefined) {
    await db.execute({
      sql: 'UPDATE channel_groups SET name = ? WHERE id = ? AND user_id = ?',
      args: [patch.name, groupId, userId],
    });
  }
  if (patch.isActive !== undefined) {
    await db.execute({
      sql: 'UPDATE channel_groups SET is_active = ? WHERE id = ? AND user_id = ?',
      args: [patch.isActive ? 1 : 0, groupId, userId],
    });
  }
  const result = await db.execute({
    sql: 'SELECT id, name, is_active FROM channel_groups WHERE id = ? AND user_id = ?',
    args: [groupId, userId],
  });
  const row = result.rows[0] as unknown as GroupRow | undefined;
  return row ? toDto(row) : undefined;
}

/** Удаление группы не удаляет каналы — они просто становятся «без группы» (ON DELETE SET NULL). */
export async function deleteGroup(userId: number, groupId: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'DELETE FROM channel_groups WHERE id = ? AND user_id = ?',
    args: [groupId, userId],
  });
  return result.rowsAffected > 0;
}

/**
 * Переносит канал в группу (groupId = null — убрать из группы). Чужую группу
 * подставить нельзя: EXISTS проверяет, что группа принадлежит тому же user_id.
 * Возвращает false, если канал не найден или группа чужая/несуществующая.
 */
export async function setChannelGroup(
  userId: number,
  channelIdentifier: string,
  groupId: number | null
): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    sql: `UPDATE user_channels SET group_id = ?
          WHERE user_id = ? AND channel_identifier = ?
            AND (? IS NULL OR EXISTS (SELECT 1 FROM channel_groups WHERE id = ? AND user_id = ?))`,
    args: [groupId, userId, channelIdentifier, groupId, groupId, userId],
  });
  return result.rowsAffected > 0;
}
