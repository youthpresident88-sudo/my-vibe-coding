import type { Queryable } from '../db/db.js';
import { canonicalJson, sha256Hex } from '../lib/crypto.js';

export const GENESIS_HASH = '0'.repeat(64);

export interface NewEvent {
  transactionId: string;
  type: string;
  actorId: string | null;
  actorRole: string;
  payload: Record<string, unknown>;
}

function computeHash(e: {
  transactionId: string;
  seq: number;
  type: string;
  actorId: string | null;
  actorRole: string;
  payload: unknown;
  prevHash: string;
  createdAt: string;
}): string {
  return sha256Hex(canonicalJson(e));
}

/** Caller MUST hold the transaction row lock (select ... for update) so seq is gap-free and the chain is linear. */
export async function appendEvent(q: Queryable, e: NewEvent): Promise<{ seq: number; hash: string }> {
  const last = await q.query<{ seq: number; hash: string }>(
    'select seq, hash from transaction_events where transaction_id = $1 order by seq desc limit 1',
    [e.transactionId],
  );
  const seq = (last.rows[0]?.seq ?? 0) + 1;
  const prevHash = last.rows[0]?.hash ?? GENESIS_HASH;
  const createdAt = new Date();
  const hash = computeHash({ ...e, seq, prevHash, createdAt: createdAt.toISOString() });
  await q.query(
    `insert into transaction_events (transaction_id, seq, type, actor_id, actor_role, payload, prev_hash, hash, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.transactionId, seq, e.type, e.actorId, e.actorRole, JSON.stringify(e.payload), prevHash, hash, createdAt.toISOString()],
  );
  return { seq, hash };
}

export interface ChainReport {
  valid: boolean;
  length: number;
  headHash: string;
  brokenAtSeq?: number;
}

/** Recomputes every hash from stored fields; any edited row or gap is reported. */
export async function verifyChain(q: Queryable, transactionId: string): Promise<ChainReport> {
  const r = await q.query<{
    seq: number;
    type: string;
    actor_id: string | null;
    actor_role: string;
    payload: unknown;
    prev_hash: string;
    hash: string;
    created_at: Date | string;
  }>('select * from transaction_events where transaction_id = $1 order by seq', [transactionId]);
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const row of r.rows) {
    const recomputed = computeHash({
      transactionId,
      seq: row.seq,
      type: row.type,
      actorId: row.actor_id,
      actorRole: row.actor_role,
      payload: row.payload,
      prevHash: prev,
      createdAt: new Date(row.created_at).toISOString(),
    });
    if (row.seq !== expectedSeq || row.prev_hash !== prev || row.hash !== recomputed) {
      return { valid: false, length: r.rows.length, headHash: prev, brokenAtSeq: row.seq };
    }
    prev = row.hash;
    expectedSeq++;
  }
  return { valid: true, length: r.rows.length, headHash: prev };
}
