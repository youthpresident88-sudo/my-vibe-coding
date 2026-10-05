import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** Applies pending SQL migrations in filename order, each in its own transaction, serialized by an advisory lock. */
export async function migrate(db: Db, log: (m: string) => void = () => undefined): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    await db.tx(async (q) => {
      await q.query('select pg_advisory_xact_lock(727274)');
      const done = await q.query('select 1 from schema_migrations where name = $1', [file]);
      if (done.rowCount > 0) return;
      await q.exec(sql);
      await q.query('insert into schema_migrations(name) values ($1)', [file]);
      applied.push(file);
      log(`applied ${file}`);
    });
  }
  return applied;
}
