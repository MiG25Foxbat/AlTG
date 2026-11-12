/**
 * Перенос локальной базы в Turso, чтобы Render работал с теми же аккаунтами, каналами и настройками.
 * Запуск в PowerShell из папки проекта (значения берутся из этого окна терминала, .env не читается):
 *   $env:TURSO_DATABASE_URL = "libsql://…"
 *   $env:TURSO_AUTH_TOKEN = "…"
 *   npx ts-node src/copyDbToTurso.ts [путь к файлу базы, по умолчанию data/app.db]
 *
 * Схему в Turso создаёт сам сервис (getDb), строки копируются таблица за таблицей в порядке внешних ключей.
 * База в Turso должна быть пустой (в том числе Render ещё не должен был к ней подключаться), иначе скрипт
 * ничего не меняет. Исходный файл только читается. Не копируются очередь отправки (outbox), придержанные
 * отчёты (alert_reports) и замок экземпляра (service_locks): иначе Render разослал бы старые сообщения
 * локальных тестов. Зашифрованные поля копируются как есть: на Render нужен тот же SESSION_ENCRYPTION_KEY.
 */
import fs from 'node:fs';
import { createClient } from '@libsql/client';
import { closeDb, getDb } from './db/database';

const SKIP = new Set(['service_locks', 'outbox', 'alert_reports']);
const CHUNK = 200;
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (name: string) => `'${name.replace(/'/g, "''")}'`;

async function main() {
  if (!process.env.TURSO_DATABASE_URL) throw new Error('задайте в этом окне терминала TURSO_DATABASE_URL и TURSO_AUTH_TOKEN');
  const file = process.argv[2] ?? 'data/app.db';
  if (!fs.existsSync(file)) throw new Error(`нет файла базы ${file}`);

  const source = createClient({ url: `file:${file}` });
  const target = await getDb(); // создаёт в Turso схему сервиса

  const names = async (sql: string, db = source) => (await db.execute(sql)).rows.map((r) => String(Object.values(r)[0]));
  const tables = (await names(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)).filter((t) => !SKIP.has(t));

  const count = async (t: string) => Number((await target.execute(`SELECT COUNT(*) FROM ${q(t)}`)).rows[0][0]);
  const targetTables = new Set(await names(`SELECT name FROM sqlite_master WHERE type = 'table'`, target));
  const busy: string[] = [];
  for (const t of tables) if (targetTables.has(t) && (await count(t)) > 0) busy.push(t);
  if (busy.length) throw new Error(`база в Turso не пустая (${busy.join(', ')}): создайте новую пустую базу и запустите снова`);

  // Родительские таблицы раньше дочерних, чтобы внешние ключи не мешали вставке.
  const order: string[] = [];
  const visit = async (t: string, path: string[] = []) => {
    if (order.includes(t) || path.includes(t)) return;
    for (const r of (await source.execute(`PRAGMA foreign_key_list(${q(t)})`)).rows) {
      const parent = String(r.table);
      if (tables.includes(parent) && parent !== t) await visit(parent, [...path, t]);
    }
    order.push(t);
  };
  for (const t of tables) await visit(t);

  for (const t of order) {
    if (!targetTables.has(t)) {
      console.log(`${t}: в схеме сервиса нет такой таблицы, пропускаю`);
      continue;
    }
    const targetCols = new Set(await names(`SELECT name FROM pragma_table_info(${lit(t)})`, target));
    const cols = (await names(`SELECT name FROM pragma_table_info(${lit(t)})`)).filter((c) => targetCols.has(c));
    const rows = (await source.execute(`SELECT ${cols.map(q).join(', ')} FROM ${q(t)}`)).rows;
    const sql = `INSERT INTO ${q(t)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await target.batch(rows.slice(i, i + CHUNK).map((r) => ({ sql, args: cols.map((c) => r[c] as any) })), 'write');
    }
    const copied = await count(t);
    console.log(`${t}: в файле ${rows.length}, в Turso ${copied}${copied === rows.length ? '' : '  ← НЕ СОВПАДАЕТ'}`);
  }
  console.log(`Готово. Не переносились: ${[...SKIP].join(', ')}.`);
  source.close();
  closeDb();
}

main().catch((error) => {
  console.error('Перенос не выполнен:', error?.message || error);
  process.exit(1);
});
