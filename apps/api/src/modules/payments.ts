import { randomUUID } from 'node:crypto';
import type { Ctx, AuthUser } from './context.js';
import { AppError, conflict, forbidden, notConfigured } from '../lib/errors.js';
import { lockTx, requireVerifiedEmail, transition } from './transactions.js';

interface PaymentRow {
  id: string;
  status: string;
  checkout_url: string | null;
  updated_at: Date;
}

/**
 * Buyer starts (or resumes) hosted checkout. The transaction only becomes 'funded' later, when the
 * provider's signed webhook confirms payment. Nothing here ever marks money as received.
 */
export async function startCheckout(ctx: Ctx, buyer: AuthUser, txId: string) {
  const provider = ctx.providers.payments;
  if (!provider) throw notConfigured('Payment provider');
  requireVerifiedEmail(buyer);

  // Phase 1: reserve a payment attempt.
  const reserved = await ctx.db.tx(async (q) => {
    const tx = await lockTx(q, txId);
    if (tx.buyer_id !== buyer.id) throw forbidden('Only the buyer can pay');
    if (tx.state !== 'condition_documented' && tx.state !== 'awaiting_payment') {
      throw conflict('invalid_state', `Cannot pay while transaction is ${tx.state}`);
    }
    const live = await q.query<PaymentRow>(
      `select id, status, checkout_url, updated_at from payments where transaction_id = $1
         and status in ('creating','pending','succeeded')`,
      [txId],
    );
    const p = live.rows[0];
    if (p?.status === 'pending' && p.checkout_url) return { reuse: p.checkout_url, tx };
    if (p?.status === 'succeeded') throw conflict('already_paid', 'Payment already confirmed');
    if (p?.status === 'creating') {
      if (Date.now() - new Date(p.updated_at).getTime() < 120_000) throw conflict('checkout_in_progress', 'Checkout is being created');
      await q.query(`update payments set status='failed', last_error='abandoned while creating', updated_at=now() where id=$1`, [p.id]);
    }
    const id = randomUUID();
    await q.query(
      `insert into payments (id, transaction_id, provider, status, amount_minor, currency) values ($1,$2,$3,'creating',$4,$5)`,
      [id, txId, provider.name, tx.amount_minor, tx.currency],
    );
    return { paymentId: id, tx };
  });
  if ('reuse' in reserved) return { checkoutUrl: reserved.reuse, status: 'pending' as const };

  // Phase 2: call the provider outside any DB transaction. Idempotent on paymentId.
  let session: { sessionRef: string; url: string };
  try {
    session = await provider.createCheckout({
      paymentId: reserved.paymentId,
      transactionId: txId,
      title: reserved.tx.title,
      amountMinor: reserved.tx.amount_minor,
      currency: reserved.tx.currency,
      successUrl: `${ctx.config.PUBLIC_WEB_URL}/transactions/${txId}?checkout=return`,
      cancelUrl: `${ctx.config.PUBLIC_WEB_URL}/transactions/${txId}?checkout=cancelled`,
    });
  } catch (e) {
    await ctx.db.query(`update payments set status='failed', last_error=$2, updated_at=now() where id=$1`, [
      reserved.paymentId,
      String(e).slice(0, 500),
    ]);
    throw new AppError(502, 'payment_provider_error', 'Could not start checkout with the payment provider');
  }

  // Phase 3: record the session and the event.
  await ctx.db.tx(async (q) => {
    const tx = await lockTx(q, txId);
    await q.query(
      `update payments set status='pending', provider_session_ref=$2, checkout_url=$3, updated_at=now() where id=$1`,
      [reserved.paymentId, session.sessionRef, session.url],
    );
    await transition(q, tx, 'payment.checkout_started', { id: buyer.id, role: 'buyer' }, { paymentId: reserved.paymentId, provider: provider.name });
  });
  return { checkoutUrl: session.url, status: 'pending' as const };
}
