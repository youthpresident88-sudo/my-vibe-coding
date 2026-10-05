import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { setup, signWebhook } from './helpers.js';
import { hashPassword } from '../src/lib/crypto.js';
import { verifyChain } from '../src/modules/ledger.js';

type H = Awaited<ReturnType<typeof setup>>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let n = 0;

async function call(h: H, method: 'GET' | 'POST' | 'PUT', url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await h.app.inject({
    method,
    url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function user(h: H, name: string, role?: 'arbiter' | 'admin') {
  const email = `${name}${++n}@example.com`;
  const password = 'correct horse battery';
  if (role) {
    await h.db.query(`insert into users (email, password_hash, display_name, role, email_verified_at) values ($1,$2,$3,$4,now())`, [
      email,
      await hashPassword(password),
      name,
      role,
    ]);
  } else {
    const r = await call(h, 'POST', '/v1/auth/register', undefined, { email, password, displayName: name });
    expect(r.status).toBe(201);
    // the verification token only exists in the queued email: drain the worker and read it from the provider
    await h.drain();
    const mail = h.sent.filter((m) => m.to === email).pop()!;
    const token = /code: (\S+)/.exec(mail.text)![1]!;
    expect((await call(h, 'POST', '/v1/auth/verify-email', undefined, { token })).status).toBe(204);
  }
  const login = await call(h, 'POST', '/v1/auth/login', undefined, { email, password });
  expect(login.status).toBe(200);
  const me = await call(h, 'GET', '/v1/me', login.body.token);
  return { token: login.body.token as string, id: me.body.id as string, email };
}

async function upload(h: H, token: string, txId: string, phase: string, content = `file-${++n}`) {
  const req = await call(h, 'POST', `/v1/transactions/${txId}/evidence`, token, {
    phase,
    contentType: 'image/jpeg',
    sizeBytes: content.length,
    sha256: sha(content),
  });
  expect(req.status).toBe(201);
  return { id: req.body.evidenceId as string, content };
}
async function evidence(h: H, token: string, txId: string, phase: string) {
  const u = await upload(h, token, txId, phase);
  // before the object exists in storage, confirmation must be refused
  const early = await call(h, 'POST', `/v1/evidence/${u.id}/confirm`, token);
  expect(early.status).toBe(422);
  const key = (await h.db.query<{ storage_key: string }>('select storage_key from evidence_items where id=$1', [u.id])).rows[0]!.storage_key;
  h.storage.objects.set(key, { sizeBytes: u.content.length, sha256Hex: sha(u.content) });
  const ok = await call(h, 'POST', `/v1/evidence/${u.id}/confirm`, token);
  expect(ok.status).toBe(200);
  return u.id;
}

const newTx = (h: H, seller: { token: string }) =>
  call(h, 'POST', '/v1/transactions', seller.token, {
    title: 'Vintage camera',
    description: 'Film camera',
    channel: 'instagram',
    amountMinor: 10_000,
    currency: 'usd',
    spec: { items: [{ key: 'body', description: 'Camera body' }, { key: 'strap', description: 'Leather strap' }] },
  }, { 'idempotency-key': `key-${++n}-abcdefgh` });

async function fund(h: H, seller: { token: string; id: string }, buyer: { token: string; id: string }) {
  const created = await newTx(h, seller);
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  const accept = await call(h, 'POST', `/v1/transactions/${id}/accept`, buyer.token, { specHash: created.body.specHash });
  expect(accept.status).toBe(200);
  await evidence(h, seller.token, id, 'seller_condition');
  expect((await call(h, 'POST', `/v1/transactions/${id}/condition`, seller.token, { notes: 'good' })).status).toBe(200);
  const co = await call(h, 'POST', `/v1/transactions/${id}/checkout`, buyer.token, {}, { 'idempotency-key': `co-${++n}-abcdefgh` });
  expect(co.status).toBe(200);
  expect((await call(h, 'GET', `/v1/transactions/${id}`, buyer.token)).body.state).toBe('awaiting_payment');
  const paymentId = h.payments.checkouts.at(-1)!.paymentId;
  const body = JSON.stringify({
    id: `evt_${++n}`,
    type: 'checkout.session.completed',
    data: { object: { id: `cs_${paymentId}`, payment_status: 'paid', amount_total: 10_000, currency: 'usd', payment_intent: 'pi_1', metadata: { payment_id: paymentId } } },
  });
  const wh = await h.app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: body, headers: { 'content-type': 'application/json', 'stripe-signature': signWebhook(body) } });
  expect(wh.statusCode).toBe(200);
  return { id, paymentId, body };
}

describe('evidence-first transaction lifecycle', () => {
  it('runs agreement -> payment -> dispatch -> unboxing -> approval -> payout with an intact evidence chain', async () => {
    const h = await setup();
    const seller = await user(h, 'seller');
    const buyer = await user(h, 'buyer');
    await h.db.query('update seller_profiles set payout_account_ref=$2 where user_id=$1', [seller.id, 'acct_123']);

    const { id, body } = await fund(h, seller, buyer);

    // Money is NOT confirmed until the worker applies the verified webhook.
    expect((await call(h, 'GET', `/v1/transactions/${id}`, buyer.token)).body.state).toBe('awaiting_payment');
    await h.drain();
    expect((await call(h, 'GET', `/v1/transactions/${id}`, buyer.token)).body.state).toBe('funded');

    // Duplicate webhook delivery is a no-op.
    const evtId = JSON.parse(body).id;
    await h.app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: body, headers: { 'content-type': 'application/json', 'stripe-signature': signWebhook(body) } });
    await h.drain();
    expect((await h.db.query('select 1 from payment_webhook_events where provider_event_id=$1', [evtId])).rowCount).toBe(1);
    expect((await h.db.query(`select 1 from money_ledger where transaction_id=$1 and entry_type='escrow_in'`, [id])).rowCount).toBe(1);

    // dispatch requires evidence
    const noEv = await call(h, 'POST', `/v1/transactions/${id}/dispatch`, seller.token, { carrier: 'UPS', trackingNumber: '1Z' });
    expect(noEv.status).toBe(422);
    await evidence(h, seller.token, id, 'dispatch');
    expect((await call(h, 'POST', `/v1/transactions/${id}/dispatch`, seller.token, { carrier: 'UPS', trackingNumber: '1Z' })).status).toBe(200);
    expect((await call(h, 'POST', `/v1/transactions/${id}/delivery`, buyer.token)).status).toBe(200);

    // inspection requires unboxing evidence and must cover every spec item
    expect((await call(h, 'POST', `/v1/transactions/${id}/inspection`, buyer.token, { items: [{ specKey: 'body', result: 'matches' }, { specKey: 'strap', result: 'matches' }] })).status).toBe(422);
    await evidence(h, buyer.token, id, 'unboxing');
    expect((await call(h, 'POST', `/v1/transactions/${id}/inspection`, buyer.token, { items: [{ specKey: 'body', result: 'matches' }] })).status).toBe(422);
    expect((await call(h, 'POST', `/v1/transactions/${id}/inspection`, buyer.token, { items: [{ specKey: 'body', result: 'matches' }, { specKey: 'strap', result: 'matches' }] })).status).toBe(200);

    const cmp = await call(h, 'GET', `/v1/transactions/${id}/comparison`, seller.token);
    expect(cmp.body.sellerEvidence.length).toBe(2);
    expect(cmp.body.buyerEvidence.length).toBe(1);
    expect(cmp.body.inspection.overall).toBe('matches');

    expect((await call(h, 'POST', `/v1/transactions/${id}/approve`, buyer.token)).body.state).toBe('completed');
    await h.drain();

    // 250 bps fee on 10_000 => 250 fee, 9_750 net, paid only after provider accepted the transfer
    expect(h.payments.payouts).toMatchObject([{ destinationAccount: 'acct_123', amountMinor: 9750 }]);
    expect(h.payments.payouts.length).toBe(1);
    const tl = await call(h, 'GET', `/v1/transactions/${id}/timeline`, buyer.token);
    expect(tl.body.integrity.valid).toBe(true);
    expect(tl.body.events.map((e: { type: string }) => e.type)).toContain('payout.sent');
    expect(tl.body.money.map((m: { entry_type: string }) => m.entry_type).sort()).toEqual(['escrow_in', 'payout_out', 'platform_fee']);
  });

  it('detects tampering and refuses ledger mutation', async () => {
    const h = await setup();
    const seller = await user(h, 'seller');
    const created = await newTx(h, seller);
    const id = created.body.id as string;
    await expect(h.db.query(`update transaction_events set type='x' where transaction_id=$1`, [id])).rejects.toThrow(/append-only/);
    await expect(h.db.query(`delete from audit_log`)).rejects.toThrow(/append-only/);
    expect((await verifyChain(h.db, id)).valid).toBe(true);
  });

  it('refunds the buyer on arbiter decision, and non-arbiters cannot decide', async () => {
    const h = await setup();
    const seller = await user(h, 'seller');
    const buyer = await user(h, 'buyer');
    const arbiter = await user(h, 'arb', 'arbiter');
    const { id } = await fund(h, seller, buyer);
    await h.drain();
    await evidence(h, seller.token, id, 'dispatch');
    await call(h, 'POST', `/v1/transactions/${id}/dispatch`, seller.token, { carrier: 'UPS', trackingNumber: '1Z' });
    await call(h, 'POST', `/v1/transactions/${id}/delivery`, buyer.token);
    const d = await call(h, 'POST', `/v1/transactions/${id}/dispute`, buyer.token, { reasonCode: 'not_as_described', description: 'Strap was missing entirely' });
    expect(d.status).toBe(201);
    await evidence(h, seller.token, id, 'dispute');
    expect((await call(h, 'POST', `/v1/transactions/${id}/dispute/statements`, seller.token, { statement: 'Shipped with strap' })).status).toBe(201);

    const resolveBody = { resolution: 'full_refund', reason: 'Seller evidence shows no strap in packed photo' };
    expect((await call(h, 'POST', `/v1/transactions/${id}/dispute/resolve`, buyer.token, resolveBody)).status).toBe(403);
    expect((await call(h, 'POST', `/v1/transactions/${id}/dispute/resolve`, arbiter.token, resolveBody)).body.state).toBe('resolved');
    await h.drain();
    expect(h.payments.refunds).toMatchObject([{ paymentRef: 'pi_1', amountMinor: 10_000 }]);
    expect(h.payments.refunds.length).toBe(1);
    expect(h.payments.payouts.length).toBe(0);
    expect((await call(h, 'GET', `/v1/transactions/${id}/timeline`, arbiter.token)).body.integrity.valid).toBe(true);
  });
});

describe('security and correctness guards', () => {
  it('rejects unsigned, mis-signed and stale webhooks', async () => {
    const h = await setup();
    const body = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } });
    const post = (sig?: string) => h.app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: body, headers: { 'content-type': 'application/json', ...(sig ? { 'stripe-signature': sig } : {}) } });
    expect((await post()).statusCode).toBe(400);
    expect((await post(signWebhook(body, 'wrong'))).statusCode).toBe(400);
    expect((await post(signWebhook(body, undefined, Math.floor(Date.now() / 1000) - 3600))).statusCode).toBe(400);
    expect((await h.db.query('select 1 from payment_webhook_events')).rowCount).toBe(0);
  });

  it('does not fund when the paid amount differs from the agreed amount', async () => {
    const h = await setup();
    const seller = await user(h, 'seller');
    const buyer = await user(h, 'buyer');
    const created = await newTx(h, seller);
    const id = created.body.id;
    await call(h, 'POST', `/v1/transactions/${id}/accept`, buyer.token, { specHash: created.body.specHash });
    await evidence(h, seller.token, id, 'seller_condition');
    await call(h, 'POST', `/v1/transactions/${id}/condition`, seller.token, {});
    await call(h, 'POST', `/v1/transactions/${id}/checkout`, buyer.token, {}, { 'idempotency-key': 'abcdefgh-1' });
    const paymentId = h.payments.checkouts.at(-1)!.paymentId;
    const body = JSON.stringify({ id: 'evt_short', type: 'checkout.session.completed', data: { object: { payment_status: 'paid', amount_total: 100, currency: 'usd', payment_intent: 'pi_x', metadata: { payment_id: paymentId } } } });
    await h.app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: body, headers: { 'content-type': 'application/json', 'stripe-signature': signWebhook(body) } });
    await h.drain();
    expect((await call(h, 'GET', `/v1/transactions/${id}`, buyer.token)).body.state).toBe('awaiting_payment');
    expect((await h.db.query(`select 1 from audit_log where action='payment.mismatch'`)).rowCount).toBe(1);
  });

  it('enforces party access, spec-hash agreement, and role-restricted actions', async () => {
    const h = await setup();
    const seller = await user(h, 'seller');
    const buyer = await user(h, 'buyer');
    const stranger = await user(h, 'stranger');
    const created = await newTx(h, seller);
    const id = created.body.id;
    expect((await call(h, 'GET', `/v1/transactions/${id}`, stranger.token)).status).toBe(404);
    expect((await call(h, 'GET', `/v1/transactions/${id}/preview`, stranger.token)).status).toBe(200);
    expect((await call(h, 'POST', `/v1/transactions/${id}/accept`, seller.token, { specHash: created.body.specHash })).status).toBe(403);
    expect((await call(h, 'POST', `/v1/transactions/${id}/accept`, buyer.token, { specHash: sha('other') })).status).toBe(409);
    expect((await call(h, 'POST', `/v1/transactions/${id}/accept`, buyer.token, { specHash: created.body.specHash })).status).toBe(200);
    expect((await call(h, 'GET', `/v1/transactions/${id}/preview`, stranger.token)).status).toBe(404);
    expect((await call(h, 'POST', `/v1/transactions/${id}/evidence`, buyer.token, { phase: 'seller_condition', contentType: 'image/jpeg', sizeBytes: 3, sha256: sha('abc') })).status).toBe(403);
    expect((await call(h, 'POST', `/v1/transactions/${id}/approve`, buyer.token)).status).toBe(409);
    expect((await call(h, 'GET', '/v1/me')).status).toBe(401);
  });

  it('requires idempotency keys and replays identical requests without duplicating', async () => {
    const h = await setup();
    const seller = await user(h, 'seller');
    const body = { title: 'T', description: '', channel: 'x', amountMinor: 500, currency: 'usd', spec: { items: [{ key: 'a', description: 'A' }] } };
    expect((await call(h, 'POST', '/v1/transactions', seller.token, body)).status).toBe(400);
    const hdr = { 'idempotency-key': 'same-key-123' };
    const a = await call(h, 'POST', '/v1/transactions', seller.token, body, hdr);
    const b = await call(h, 'POST', '/v1/transactions', seller.token, body, hdr);
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect((await call(h, 'POST', '/v1/transactions', seller.token, { ...body, amountMinor: 900 }, hdr)).status).toBe(422);
    expect((await h.db.query('select 1 from transactions')).rowCount).toBe(1);
  });

  it('never reports email as sent when no provider is configured, and keeps retrying', async () => {
    const h = await setup({ email: undefined });
    await call(h, 'POST', '/v1/auth/register', undefined, { email: 'a@example.com', password: 'correct horse battery', displayName: 'A' });
    await h.worker.runOnce();
    const r = await h.db.query<{ status: string }>(`select status from notifications where channel='email'`);
    expect(r.rows[0]!.status).toBe('failed');
    expect((await h.db.query(`select 1 from jobs where queue='notification.send' and status='pending' and attempts=1`)).rowCount).toBe(1);
  });

  it('returns 503 provider_not_configured instead of faking payment or storage', async () => {
    const h = await setup({ payments: undefined, storage: undefined });
    const seller = await user(h, 'seller');
    const created = await newTx(h, seller);
    const ev = await call(h, 'POST', `/v1/transactions/${created.body.id}/evidence`, seller.token, { phase: 'seller_condition', contentType: 'image/jpeg', sizeBytes: 3, sha256: sha('abc') });
    expect(ev.status).toBe(503);
    expect(ev.body.error.code).toBe('provider_not_configured');
    const kyc = await call(h, 'POST', '/v1/seller/verification', seller.token, {});
    expect(kyc.status).toBe(503);
  });
});
