import { randomUUID } from 'node:crypto';
import type { Ctx, AuthUser } from './context.js';
import { isStaff } from './context.js';
import { AppError, conflict, forbidden, notConfigured, notFound, unprocessable } from '../lib/errors.js';
import { EVIDENCE_RULES, type EvidencePhase } from '../domain/stateMachine.js';
import { appendEvent } from './ledger.js';
import { lockTx, partyOf, getTransaction } from './transactions.js';

export const ALLOWED_TYPES: Record<string, 'photo' | 'video' | 'document'> = {
  'image/jpeg': 'photo',
  'image/png': 'photo',
  'image/webp': 'photo',
  'image/heic': 'photo',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
  'application/pdf': 'document',
};

export async function requestUpload(
  ctx: Ctx,
  user: AuthUser,
  txId: string,
  i: { phase: EvidencePhase; contentType: string; sizeBytes: number; sha256: string; capturedAt?: string },
) {
  const storage = ctx.providers.storage;
  if (!storage) throw notConfigured('Evidence storage');
  const kind = ALLOWED_TYPES[i.contentType];
  if (!kind) throw unprocessable('unsupported_media_type', `Allowed: ${Object.keys(ALLOWED_TYPES).join(', ')}`);
  if (i.sizeBytes > ctx.config.MAX_EVIDENCE_BYTES) {
    throw new AppError(413, 'file_too_large', `Maximum evidence size is ${ctx.config.MAX_EVIDENCE_BYTES} bytes`);
  }
  const row = await ctx.db.tx(async (q) => {
    const tx = await lockTx(q, txId);
    const role = partyOf(tx, user.id);
    if (!role) throw forbidden('You are not a party to this transaction');
    const rule = EVIDENCE_RULES[i.phase];
    if (!rule.actors.includes(role)) throw forbidden(`${role}s cannot add ${i.phase} evidence`);
    if (!rule.states.includes(tx.state)) throw conflict('invalid_state', `${i.phase} evidence cannot be added while transaction is ${tx.state}`);
    const id = randomUUID();
    const key = `evidence/${txId}/${id}`;
    await q.query(
      `insert into evidence_items (id, transaction_id, uploader_id, phase, kind, storage_key, content_type, size_bytes, sha256, captured_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, txId, user.id, i.phase, kind, key, i.contentType, i.sizeBytes, i.sha256, i.capturedAt ?? null],
    );
    return { id, key };
  });
  const up = await storage.presignUpload({
    key: row.key,
    contentType: i.contentType,
    sizeBytes: i.sizeBytes,
    sha256Hex: i.sha256,
    expiresSec: 900,
  });
  return { evidenceId: row.id, upload: { method: 'PUT', url: up.url, headers: up.headers, expiresInSec: 900 } };
}

/** Marks evidence verified only after the object store confirms size (and checksum, when reported). */
export async function confirmUpload(ctx: Ctx, user: AuthUser, evidenceId: string) {
  const storage = ctx.providers.storage;
  if (!storage) throw notConfigured('Evidence storage');
  const r = await ctx.db.query<{
    id: string;
    transaction_id: string;
    uploader_id: string;
    status: string;
    storage_key: string;
    size_bytes: number;
    sha256: string;
    phase: string;
    kind: string;
    content_type: string;
  }>('select * from evidence_items where id = $1', [evidenceId]);
  const ev = r.rows[0];
  if (!ev || ev.uploader_id !== user.id) throw notFound('Evidence');
  if (ev.status === 'verified') return { evidenceId, status: 'verified' as const };
  const head = await storage.head(ev.storage_key);
  if (!head) throw unprocessable('upload_missing', 'The file has not been uploaded yet');
  if (head.sizeBytes !== ev.size_bytes) throw unprocessable('size_mismatch', 'Uploaded size differs from declared size');
  if (head.sha256Hex && head.sha256Hex !== ev.sha256) throw unprocessable('checksum_mismatch', 'Uploaded checksum differs from declared');
  await ctx.db.tx(async (q) => {
    await lockTx(q, ev.transaction_id);
    const u = await q.query(
      `update evidence_items set status='verified', verified_at=now() where id=$1 and status='pending'`,
      [evidenceId],
    );
    if (u.rowCount === 0) return;
    const role = (await q.query<{ seller_id: string }>('select seller_id from transactions where id=$1', [ev.transaction_id])).rows[0]!
      .seller_id === user.id
      ? 'seller'
      : 'buyer';
    await appendEvent(q, {
      transactionId: ev.transaction_id,
      type: 'evidence.recorded',
      actorId: user.id,
      actorRole: role,
      payload: {
        evidenceId,
        phase: ev.phase,
        kind: ev.kind,
        contentType: ev.content_type,
        sizeBytes: ev.size_bytes,
        sha256: ev.sha256,
        checksumVerifiedByStore: head.sha256Hex === ev.sha256,
      },
    });
  });
  return { evidenceId, status: 'verified' as const };
}

export async function downloadUrl(ctx: Ctx, user: AuthUser, evidenceId: string) {
  const storage = ctx.providers.storage;
  if (!storage) throw notConfigured('Evidence storage');
  const r = await ctx.db.query<{ transaction_id: string; storage_key: string; status: string }>(
    'select transaction_id, storage_key, status from evidence_items where id = $1',
    [evidenceId],
  );
  const ev = r.rows[0];
  if (!ev || ev.status !== 'verified') throw notFound('Evidence');
  await getTransaction(ctx, user, ev.transaction_id); // party or staff only
  if (isStaff(user)) {
    await ctx.db.query(
      `insert into audit_log (actor_id, action, entity_type, entity_id) values ($1,'evidence.staff_download','evidence',$2)`,
      [user.id, evidenceId],
    );
  }
  return { url: await storage.presignDownload(ev.storage_key, 300), expiresInSec: 300 };
}

export async function listEvidence(ctx: Ctx, user: AuthUser, txId: string) {
  await getTransaction(ctx, user, txId);
  const r = await ctx.db.query(
    `select id, phase, kind, content_type, size_bytes, sha256, status, uploader_id, captured_at, created_at, verified_at
     from evidence_items where transaction_id = $1 order by created_at`,
    [txId],
  );
  return r.rows;
}
