import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run a multi-statement script (no parameters). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPgDb(opts: { url: string; max: number; ssl: boolean }): Db {
  // Return int8 as JS number; money amounts stay far below 2^53 minor units.
  pg.types.setTypeParser(20, (v) => Number(v));
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.max,
    ssl: opts.ssl ? { rejectUnauthorized: true } : undefined,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  const wrap = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const r = await c.query(sql, params as unknown[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    async exec(sql: string) {
      await c.query(sql);
    },
  });
  const base = wrap(pool);
  return {
    ...base,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn(wrap(client));
        await client.query('commit');
        return out;
      } catch (e) {
        await client.query('rollback').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
