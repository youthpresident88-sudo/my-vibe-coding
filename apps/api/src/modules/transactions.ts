import type { Queryable } from '../db/db.js';
import type { Ctx, AuthUser } from './context.js';
import { isStaff } from './context.js';
import { canonicalJson, sha256Hex } from '../lib/crypto.js';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { enqueue } from '../jobs/queue.js';
import { TRANSITIONS, type Actor, type EvidencePhase, type TransitionName, type TxState } from '../domain/stateMachine.js';
import { appendEvent, verifyChain } from './ledger.js';
import { audit, notify } from './notifications.js';

export interface TxRow {
  id: string;
  seller_id: string;
  buyer_id: string | null;
  title: string;
  description: string;
  channel: string;
  amount_minor: number;
  currency: string;
  spec: { items: Array<{ key: string; description: string }>; conditionNotes?: string };
  spec_hash: string;
  state: TxState;
  carrier: string | null;
  tracking_number: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SpecInput {
  items: Array<{ key: string; description: string }>;
  conditionNotes?: string;
}

export const lockTx = async (q: Queryable, id: string): Promise<TxRow> => {
  const r = await q.query<TxRow>('select * from transactions where id = $1 for update', [id]);
  if (!r.rows[0]) throw notFound('Transaction');
  return r.rows[0];
};

export const partyOf = (tx: TxRow, userId: string): 'buyer' | 'seller' | null =>
  tx.seller_id === userId ? 'seller' : tx.buyer_id === userId ? 'buyer' : null;

export function requireVerifiedEmail(u: AuthUser): void {
  if (!u.emailVerified) throw new AppError(403, 'email_not_verified', 'Verify your email first');
}

/** Applies a named transition: validates state + actor, updates the row, appends the evidence event. */
export async function transition(
  q: Queryable,
  tx: TxRow,
  name: TransitionName,
  actor: { id: string | null; role: Actor },
  payload: Record<string, unknown> = {},
  set: { carrier?: string; trackingNumber?: string } = {},
): Promise<TxState> {
  const t: { from: readonly TxState[]; to: TxState; actors: readonly Actor[] } = TRANSITIONS[name];
  if (!t.actors.includes(actor.role)) throw forbidden(`Only ${t.actors.join('/')} may perform ${name}`);
  if (!t.from.includes(tx.state)) throw conflict('invalid_state', `Cannot ${name} while transaction is ${tx.state}`);
  await q.query(
    `update transactions set state = $2, carrier = coalesce($3, carrier),
       tracking_number = coalesce($4, tracking_number), updated_at = now() where id = $1`,
    [tx.id, t.to, set.carrier ?? null, set.trackingNumber ?? null],
  );
  await appendEvent(q, {
    transactionId: tx.id,
    type: name,
    actorId: actor.id,
    actorRole: actor.role,
    payload: { ...payload, from: tx.state, to: t.to },
  });
  tx.state = t.to;
  return t.to;
}

async function verifiedEvidenceCount(q: Queryable, txId: string, phase: EvidencePhase): Promise<number> {
  const r = await q.query<{ n: number }>(
    `select count(*)::int as n from evidence_items where transaction_id = $1 and phase = $2 and status = 'verified'`,
    [txId, phase],
  );
  return r.rows[0]!.n;
}

const actorFor = (tx: TxRow, u: AuthUser): Actor => {
  const p = partyOf(tx, u.id);
  if (!p) throw forbidden('You are not a party to this transaction');
  return p;
};

export async function createTransaction(
  ctx: Ctx,
  seller: AuthUser,
  i: { title: string; description: string; channel: string; amountMinor: number; currency: string; spec: SpecInput },
): Promise<TxRow> {
  requireVerifiedEmail(seller);
  const currencies = ctx.config.SUPPORTED_CURRENCIES.split(',').map((c) => c.trim().toLowerCase());
  if (!currencies.includes(i.currency.toLowerCase())) {
    throw unprocessable('unsupported_currency', `Supported currencies: ${currencies.join(', ')}`);
  }
  return ctx.db.tx(async (q) => {
    if (ctx.config.REQUIRE_SELLER_KYC) {
      const p = await q.query<{ verification_status: string }>('select verification_status from seller_profiles where user_id = $1', [
        seller.id,
      ]);
      if (p.rows[0]?.verification_status !== 'verified') {
        throw new AppError(403, 'seller_not_verified', 'Seller identity verification is required');
      }
    }
    const specHash = sha256Hex(
      canonicalJson({ title: i.title, amountMinor: i.amountMinor, currency: i.currency.toLowerCase(), spec: i.spec }),
    );
    const r = await q.query<TxRow>(
      `insert into transactions (seller_id, title, description, channel, amount_minor, currency, spec, spec_hash, state)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'awaiting_agreement') returning *`,
      [seller.id, i.title, i.description, i.channel, i.amountMinor, i.currency.toLowerCase(), JSON.stringify(i.spec), specHash],
    );
    const tx = r.rows[0]!;
    await appendEvent(q, {
      transactionId: tx.id,
      type: 'transaction.created',
      actorId: seller.id,
      actorRole: 'seller',
      payload: { title: i.title, amountMinor: i.amountMinor, currency: tx.currency, spec: i.spec, specHash, channel: i.channel },
    });
    await audit(q, { actorId: seller.id, action: 'transaction.created', entityType: 'transaction', entityId: tx.id });
    return tx;
  });
}

export async function previewTransaction(ctx: Ctx, user: AuthUser, id: string) {
  const r = await ctx.db.query<TxRow & { seller_name: string; verification_status: string }>(
    `select t.*, u.display_name as seller_name, coalesce(sp.verification_status,'unverified') as verification_status
     from transactions t join users u on u.id = t.seller_id
     left join seller_profiles sp on sp.user_id = t.seller_id where t.id = $1`,
    [id],
  );
  const t = r.rows[0];
  if (!t || (t.state !== 'awaiting_agreement' && partyOf(t, user.id) === null && !isStaff(user))) throw notFound('Transaction');
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    amountMinor: t.amount_minor,
    currency: t.currency,
    spec: t.spec,
    specHash: t.spec_hash,
    state: t.state,
    seller: { displayName: t.seller_name, verificationStatus: t.verification_status },
  };
}

export async function getTransaction(ctx: Ctx, user: AuthUser, id: string): Promise<TxRow> {
  const r = await ctx.db.query<TxRow>('select * from transactions where id = $1', [id]);
  const tx = r.rows[0];
  if (!tx || (!partyOf(tx, user.id) && !isStaff(user))) throw notFound('Transaction');
  return tx;
}

export async function listTransactions(ctx: Ctx, user: AuthUser, limit: number, before?: string) {
  const r = await ctx.db.query<TxRow>(
    `select * from transactions where (seller_id = $1 or buyer_id = $1)
       and ($3::timestamptz is null or created_at < $3) order by created_at desc limit $2`,
    [user.id, limit, before ?? null],
  );
  return r.rows;
}

export async function acceptAgreement(ctx: Ctx, buyer: AuthUser, id: string, specHash: string): Promise<TxRow> {
  requireVerifiedEmail(buyer);
  return ctx.db.tx(async (q) => {
    const tx = await lockTx(q, id);
    if (tx.seller_id === buyer.id) throw forbidden('Sellers cannot accept their own listing');
    if (tx.state !== 'awaiting_agreement') throw conflict('invalid_state', `Transaction is ${tx.state}`);
    // The buyer must agree to exactly the specification they were shown.
    if (specHash !== tx.spec_hash) throw conflict('spec_changed', 'Specification does not match what you reviewed');
    await q.query('update transactions set buyer_id = $2 where id = $1', [id, buyer.id]);
    tx.buyer_id = buyer.id;
    await transition(q, tx, 'spec.agreed', { id: buyer.id, role: 'buyer' }, { specHash });
    await notify(q, tx.seller_id, 'agreement_accepted', { title: tx.title });
    return { ...tx };
  });
}

export async function cancelTransaction(ctx: Ctx, user: AuthUser, id: string, reason: string): Promise<TxRow> {
  return ctx.db.tx(async (q) => {
    const tx = await lockTx(q, id);
    const role = actorFor(tx, user);
    await transition(q, tx, 'transaction.cancelled', { id: user.id, role }, { reason });
    const other = role === 'buyer' ? tx.seller_id : tx.buyer_id;
    if (other) await notify(q, other, 'transaction_cancelled', { title: tx.title });
    return { ...tx };
  });
}

export async function submitCondition(ctx: Ctx, seller: AuthUser, id: string, notes: string): Promise<TxRow> {
  return ctx.db.tx(async (q) => {
    const tx = await lockTx(q, id);
    const role = actorFor(tx, seller);
    if ((await verifiedEvidenceCount(q, id, 'seller_condition')) < 1) {
      throw unprocessable('evidence_required', 'Upload and confirm at least one condition photo/video first');
    }
    await transition(q, tx, 'condition.documented', { id: seller.id, role }, { notes });
    await notify(q, tx.buyer_id!, 'condition_documented', { title: tx.title });
    return { ...tx };
  });
}

export async function dispatchGoods(ctx: Ctx, seller: AuthUser, id: string, i: { carrier: string; trackingNumber: string }) {
  return ctx.db.tx(async (q) => {
    const tx = await lockTx(q, id);
    const role = actorFor(tx, seller);
    if ((await verifiedEvidenceCount(q, id, 'dispatch')) < 1) {
      throw unprocessable('evidence_required', 'Upload and confirm dispatch evidence (packed item/receipt) first');
    }
    await transition(q, tx, 'goods.dispatched', { id: seller.id, role }, i, { carrier: i.carrier, trackingNumber: i.trackingNumber });
    await notify(q, tx.buyer_id!, 'goods_dispatched', { title: tx.title, carrier: i.carrier, trackingNumber: i.trackingNumber });
    return { ...tx };
  });
}

export async function confirmDelivery(ctx: Ctx, buyer: AuthUser, id: string) {
  return ctx.db.tx(async (q) => {
    const tx = await lockTx(q, id);
    const role = actorFor(tx, buyer);
    await transition(q, tx, 'delivery.confirmed', { id: buyer.id, role });
    await notify(q, tx.seller_id, 'delivery_confirmed', { title: tx.title });
    return { ...tx };
  });
}

export interface InspectionItem {
  specKey: string;
  result: 'matches' | 'mismatch' | 'damaged' | 'missing';
  note?: string;
}

export async function submitInspection(ctx: Ctx, buyer: AuthUser, id: string, items: InspectionItem[]) {
  return ctx.db.tx(async (q) => {
    const tx = await lockTx(q, id);
    const role = actorFor(tx, buyer);
    if ((await verifiedEvidenceCount(q, id, 'unboxing')) < 1) {
      throw unprocessable('evidence_required', 'Upload and confirm unboxing evidence first');
    }
    // The checklist must cover every agreed spec item exactly once.
    const keys = tx.spec.items.map((s) => s.key).sort();
    const got = items.map((s) => s.specKey).sort();
    if (canonicalJson(keys) !== canonicalJson(got)) {
      throw unprocessable('inspection_incomplete', `Inspection must cover each agreed item exactly once: ${keys.join(', ')}`);
    }
    const overall = items.every((s) => s.result === 'matches') ? 'matches' : 'discrepancies';
    await q.query('insert into inspections (transaction_id, inspector_id, items, overall) values ($1,$2,$3,$4)', [
      id,
      buyer.id,
      JSON.stringify(items),
      overall,
    ]);
    await transition(q, tx, 'inspection.submitted', { id: buyer.id, role }, { items, overall });
    await notify(q, tx.seller_id, 'inspection_submitted', { title: tx.title, overall });
    return { ...tx };
  });
}

export function splitAmount(totalMinor: number, bps: number) {
  const fee = Math.floor((totalMinor * bps) / 10_000);
  return { fee, net: totalMinor - fee };
}

export async function approve(ctx: Ctx, buyer: AuthUser, id: string) {
  return ctx.db.tx(async (q) => {
    const tx = await lockTx(q, id);
    const role = actorFor(tx, buyer);
    await transition(q, tx, 'buyer.approved', { id: buyer.id, role });
    const { fee, net } = splitAmount(tx.amount_minor, ctx.config.PLATFORM_FEE_BPS);
    await enqueue(q, 'payout.execute', { transactionId: id, amountMinor: net, feeMinor: fee }, { dedupeKey: `payout:${id}`, maxAttempts: 20 });
    await notify(q, tx.seller_id, 'transaction_completed', { title: tx.title });
    return { ...tx };
  });
}

export async function openDispute(
  ctx: Ctx,
  buyer: AuthUser,
  id: string,
  i: { reasonCode: string; description: string },
) {
  return ctx.db.tx(async (q) => {
    const tx = await lockTx(q, id);
    const role = actorFor(tx, buyer);
    await transition(q, tx, 'dispute.opened', { id: buyer.id, role }, i);
    const d = await q.query<{ id: string }>(
      'insert into disputes (transaction_id, opened_by, reason_code, description) values ($1,$2,$3,$4) returning id',
      [id, buyer.id, i.reasonCode, i.description],
    );
    await notify(q, tx.seller_id, 'dispute_opened', { title: tx.title, reason: i.reasonCode });
    return { transaction: { ...tx }, disputeId: d.rows[0]!.id };
  });
}

/** Either party adds a written statement to the immutable record during a dispute. */
export async function addDisputeStatement(ctx: Ctx, user: AuthUser, id: string, statement: string) {
  return ctx.db.tx(async (q) => {
    const tx = await lockTx(q, id);
    const role = actorFor(tx, user);
    if (tx.state !== 'disputed') throw conflict('invalid_state', 'No open dispute on this transaction');
    await appendEvent(q, { transactionId: id, type: 'dispute.statement', actorId: user.id, actorRole: role, payload: { statement } });
  });
}

export async function resolveDispute(
  ctx: Ctx,
  arbiter: AuthUser,
  id: string,
  i: { resolution: 'full_refund' | 'partial_refund' | 'release_to_seller'; refundAmountMinor?: number; reason: string },
) {
  if (arbiter.role !== 'arbiter' && arbiter.role !== 'admin') throw forbidden('Arbiter role required');
  return ctx.db.tx(async (q) => {
    const tx = await lockTx(q, id);
    if (tx.state !== 'disputed') throw conflict('invalid_state', 'Transaction is not disputed');
    if (tx.buyer_id === arbiter.id || tx.seller_id === arbiter.id) throw forbidden('Arbiter cannot decide their own transaction');
    let refund = 0;
    if (i.resolution === 'full_refund') refund = tx.amount_minor;
    if (i.resolution === 'partial_refund') {
      refund = i.refundAmountMinor ?? 0;
      if (refund < 1 || refund >= tx.amount_minor) {
        throw unprocessable('invalid_refund_amount', 'Partial refund must be between 1 and total-1 minor units');
      }
    }
    const remainder = tx.amount_minor - refund;
    const { fee, net } = splitAmount(remainder, ctx.config.PLATFORM_FEE_BPS);
    await transition(q, tx, 'dispute.resolved', { id: arbiter.id, role: 'arbiter' }, {
      resolution: i.resolution,
      refundAmountMinor: refund,
      sellerNetMinor: remainder > 0 ? net : 0,
      reason: i.reason,
    });
    await q.query(
      `update disputes set status='resolved', resolution=$2, resolution_amount_minor=$3, resolution_reason=$4,
         decided_by=$5, decided_at=now() where transaction_id=$1 and status='open'`,
      [id, i.resolution, refund, i.reason, arbiter.id],
    );
    if (refund > 0) await enqueue(q, 'refund.execute', { transactionId: id, amountMinor: refund }, { dedupeKey: `refund:${id}`, maxAttempts: 20 });
    if (remainder > 0) {
      await enqueue(q, 'payout.execute', { transactionId: id, amountMinor: net, feeMinor: fee }, { dedupeKey: `payout:${id}`, maxAttempts: 20 });
    }
    await audit(q, { actorId: arbiter.id, action: 'dispute.resolved', entityType: 'transaction', entityId: id, metadata: { resolution: i.resolution } });
    for (const uid of [tx.buyer_id!, tx.seller_id]) {
      await notify(q, uid, 'dispute_resolved', { title: tx.title, resolution: i.resolution, reason: i.reason });
    }
    return { ...tx };
  });
}

export async function timeline(ctx: Ctx, user: AuthUser, id: string) {
  await getTransaction(ctx, user, id);
  const events = await ctx.db.query(
    `select seq, type, actor_id, actor_role, payload, prev_hash, hash, created_at
     from transaction_events where transaction_id = $1 order by seq`,
    [id],
  );
  const integrity = await verifyChain(ctx.db, id);
  const money = await ctx.db.query(
    'select entry_type, amount_minor, currency, provider_ref, created_at from money_ledger where transaction_id = $1 order by id',
    [id],
  );
  return { events: events.rows, integrity, money: money.rows };
}

/** Side-by-side of what the seller documented versus what the buyer documented, with the agreed spec and inspection. */
export async function compareEvidence(ctx: Ctx, user: AuthUser, id: string) {
  const tx = await getTransaction(ctx, user, id);
  const ev = await ctx.db.query<{
    id: string;
    phase: EvidencePhase;
    kind: string;
    sha256: string;
    size_bytes: number;
    content_type: string;
    uploader_id: string;
    captured_at: Date | null;
    verified_at: Date | null;
  }>(
    `select id, phase, kind, sha256, size_bytes, content_type, uploader_id, captured_at, verified_at
     from evidence_items where transaction_id = $1 and status = 'verified' order by verified_at`,
    [id],
  );
  const insp = await ctx.db.query('select items, overall, created_at from inspections where transaction_id = $1', [id]);
  const by = (phases: EvidencePhase[]) => ev.rows.filter((e) => phases.includes(e.phase));
  return {
    agreedSpec: { hash: tx.spec_hash, ...tx.spec },
    sellerEvidence: by(['seller_condition', 'dispatch']),
    buyerEvidence: by(['delivery', 'unboxing', 'inspection']),
    disputeEvidence: by(['dispute']),
    inspection: insp.rows[0] ?? null,
  };
}
