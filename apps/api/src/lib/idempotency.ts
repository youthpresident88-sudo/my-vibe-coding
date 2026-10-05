import type { Db } from '../db/db.js';
import { sha256Hex, canonicalJson } from './crypto.js';
import { AppError, conflict, unprocessable } from './errors.js';

/**
 * Exactly-once-per-key execution of a mutating request. Same key + same body replays the stored response;
 * same key + different body is rejected; a concurrent duplicate gets 409.
 * On failure the key is released so the client can retry.
 */
export async function withIdempotency<T extends object>(
  db: Db,
  p: { userId: string; key: string | undefined; endpoint: string; body: unknown },
  fn: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T }> {
  if (!p.key || p.key.length < 8 || p.key.length > 128) {
    throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key header (8-128 chars) is required');
  }
  const hash = sha256Hex(canonicalJson({ e: p.endpoint, b: p.body }));
  const ins = await db.query(
    `insert into idempotency_keys (user_id, key, endpoint, request_hash) values ($1,$2,$3,$4)
     on conflict do nothing`,
    [p.userId, p.key, p.endpoint, hash],
  );
  if (ins.rowCount === 0) {
    const ex = await db.query<{ request_hash: string; response_status: number | null; response_body: T | null }>(
      'select request_hash, response_status, response_body from idempotency_keys where user_id=$1 and key=$2',
      [p.userId, p.key],
    );
    const row = ex.rows[0];
    if (!row || row.request_hash !== hash) {
      throw unprocessable('idempotency_key_reuse', 'Idempotency-Key was already used with a different request');
    }
    if (row.response_status === null) throw conflict('request_in_progress', 'A request with this key is still in progress');
    return { status: row.response_status, body: row.response_body as T };
  }
  try {
    const out = await fn();
    await db.query('update idempotency_keys set response_status=$3, response_body=$4 where user_id=$1 and key=$2', [
      p.userId,
      p.key,
      out.status,
      JSON.stringify(out.body),
    ]);
    return out;
  } catch (e) {
    await db.query('delete from idempotency_keys where user_id=$1 and key=$2', [p.userId, p.key]);
    throw e;
  }
}
