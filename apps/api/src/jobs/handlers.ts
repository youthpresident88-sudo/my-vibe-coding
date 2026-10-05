import type { Ctx } from '../modules/context.js';
import { lockTx, transition } from '../modules/transactions.js';
import { appendEvent } from '../modules/ledger.js';
import { audit, notify, renderEmail, type Template } from '../modules/notifications.js';
import { PermanentError, RetryableError } from '../providers/http.js';
import type { JobHandler } from './queue.js';

export function buildHandlers(ctx: Ctx, log: { warn: (o: object, m?: string) => void }): Record<string, JobHandler> {
  return {
    'webhook.process': (p) => processWebhook(ctx, log, p.eventId),
    'notification.send': (p) => sendNotification(ctx, p.notificationId),
    'payout.execute': (p) => executePayout(ctx, p.transactionId, p.amountMinor, p.feeMinor),
    'refund.execute': (p) => executeRefund(ctx, p.transactionId, p.amountMinor),
  };
}

async function processWebhook(ctx: Ctx, log: { warn: (o: object, m?: string) => void }, eventId: string): Promise<void> {
  const r = await ctx.db.query<{ type: string; payload: any; processed_at: Date | null }>(
    'select type, payload, processed_at from payment_webhook_events where id = $1',
    [eventId],
  );
  const evt = r.rows[0];
  if (!evt || evt.processed_at) return;
  const obj = evt.payload;
  const paymentId: string | undefined = obj?.metadata?.payment_id ?? obj?.client_reference_id;

  await ctx.db.tx(async (q) => {
    if (paymentId && ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(evt.type)) {
      const pr = await q.query<{ transaction_id: string }>('select transaction_id from payments where id = $1', [paymentId]);
      const row = pr.rows[0];
      if (row && obj.payment_status === 'paid') {
        const tx = await lockTx(q, row.transaction_id);
        const pay = (
          await q.query<{ status: string; amount_minor: number; currency: string }>(
            'select status, amount_minor, currency from payments where id = $1 for update',
            [paymentId],
          )
        ).rows[0]!;
        if (pay.status === 'succeeded') {
          // already applied (duplicate delivery from a different event id)
        } else if (obj.amount_total !== pay.amount_minor || String(obj.currency).toLowerCase() !== pay.currency.toLowerCase()) {
          await q.query(`update payments set status='failed', last_error='amount/currency mismatch', updated_at=now() where id=$1`, [paymentId]);
          await audit(q, {
            actorId: null,
            action: 'payment.mismatch',
            entityType: 'payment',
            entityId: paymentId,
            metadata: { expected: [pay.amount_minor, pay.currency], got: [obj.amount_total, obj.currency] },
          });
          log.warn({ paymentId }, 'payment amount mismatch - not funded, needs manual review');
        } else {
          await q.query(
            `update payments set status='succeeded', provider_payment_ref=$2, updated_at=now() where id=$1`,
            [paymentId, typeof obj.payment_intent === 'string' ? obj.payment_intent : null],
          );
          await q.query(
            `insert into money_ledger (transaction_id, entry_type, amount_minor, currency, provider_ref)
             values ($1,'escrow_in',$2,$3,$4) on conflict do nothing`,
            [tx.id, pay.amount_minor, pay.currency, String(obj.payment_intent ?? obj.id)],
          );
          if (tx.state === 'awaiting_payment') {
            await transition(q, tx, 'payment.confirmed', { id: null, role: 'system' }, {
              paymentId,
              providerEventType: evt.type,
              amountMinor: pay.amount_minor,
            });
            for (const uid of [tx.buyer_id!, tx.seller_id]) await notify(q, uid, 'payment_confirmed', { title: tx.title });
          } else {
            await audit(q, { actorId: null, action: 'payment.unexpected_state', entityType: 'transaction', entityId: tx.id, metadata: { state: tx.state } });
            log.warn({ txId: tx.id, state: tx.state }, 'payment confirmed while transaction not awaiting payment - manual review');
          }
        }
      }
    } else if (paymentId && evt.type === 'checkout.session.expired') {
      await q.query(`update payments set status='expired', updated_at=now() where id=$1 and status='pending'`, [paymentId]);
    } else if (paymentId && evt.type === 'checkout.session.async_payment_failed') {
      await q.query(`update payments set status='failed', last_error='async payment failed', updated_at=now() where id=$1 and status='pending'`, [paymentId]);
    }
    await q.query('update payment_webhook_events set processed_at = now() where id = $1', [eventId]);
  });
}

async function sendNotification(ctx: Ctx, notificationId: string): Promise<void> {
  const r = await ctx.db.query<{ status: string; template: Template; data: any; email: string }>(
    `select n.status, n.template, n.data, u.email from notifications n join users u on u.id = n.user_id
     where n.id = $1 and n.channel = 'email'`,
    [notificationId],
  );
  const n = r.rows[0];
  if (!n || n.status === 'sent') return;
  const email = ctx.providers.email;
  if (!email) {
    await ctx.db.query(`update notifications set status='failed', last_error='email provider not configured' where id=$1`, [notificationId]);
    throw new RetryableError('email provider not configured');
  }
  const { subject, text } = renderEmail(n.template, n.data);
  try {
    const out = await email.send({ to: n.email, subject, text });
    // Mark sent only after the provider accepted the message. Scrub one-time tokens from stored data.
    await ctx.db.query(
      `update notifications set status='sent', provider_message_id=$2, sent_at=now(), last_error=null,
         data = case when template = 'verify_email' then '{}'::jsonb else data end where id=$1`,
      [notificationId, out.messageId],
    );
  } catch (e) {
    await ctx.db.query(`update notifications set status='failed', last_error=$2 where id=$1`, [notificationId, String(e).slice(0, 500)]);
    throw e;
  }
}

async function executePayout(ctx: Ctx, txId: string, netMinor: number, feeMinor: number): Promise<void> {
  const provider = ctx.providers.payments;
  if (!provider) throw new RetryableError('payment provider not configured');
  const done = await ctx.db.query(`select 1 from money_ledger where transaction_id=$1 and entry_type='payout_out'`, [txId]);
  if (done.rowCount > 0) return;
  const r = await ctx.db.query<{ currency: string; title: string; seller_id: string; payout_account_ref: string | null }>(
    `select t.currency, t.title, t.seller_id, sp.payout_account_ref from transactions t
     left join seller_profiles sp on sp.user_id = t.seller_id where t.id = $1`,
    [txId],
  );
  const t = r.rows[0];
  if (!t) throw new PermanentError('transaction missing');
  if (!t.payout_account_ref) throw new RetryableError('seller has no payout account yet');
  const out = await provider.payout({
    idempotencyKey: `payout:${txId}`,
    destinationAccount: t.payout_account_ref,
    amountMinor: netMinor,
    currency: t.currency,
    transferGroup: txId,
  });
  await ctx.db.tx(async (q) => {
    await q.query(
      `insert into money_ledger (transaction_id, entry_type, amount_minor, currency, provider_ref) values ($1,'payout_out',$2,$3,$4) on conflict do nothing`,
      [txId, netMinor, t.currency, out.ref],
    );
    if (feeMinor > 0) {
      await q.query(
        `insert into money_ledger (transaction_id, entry_type, amount_minor, currency, provider_ref) values ($1,'platform_fee',$2,$3,$4) on conflict do nothing`,
        [txId, feeMinor, t.currency, out.ref],
      );
    }
    await lockTx(q, txId);
    await appendEvent(q, { transactionId: txId, type: 'payout.sent', actorId: null, actorRole: 'system', payload: { providerRef: out.ref, netMinor, feeMinor } });
    await notify(q, t.seller_id, 'payout_sent', { title: t.title });
  });
}

async function executeRefund(ctx: Ctx, txId: string, amountMinor: number): Promise<void> {
  const provider = ctx.providers.payments;
  if (!provider) throw new RetryableError('payment provider not configured');
  const done = await ctx.db.query(`select 1 from money_ledger where transaction_id=$1 and entry_type='refund_out'`, [txId]);
  if (done.rowCount > 0) return;
  const r = await ctx.db.query<{ currency: string; title: string; buyer_id: string; provider_payment_ref: string | null; amount_minor: number }>(
    `select t.currency, t.title, t.buyer_id, t.amount_minor, p.provider_payment_ref
     from transactions t join payments p on p.transaction_id = t.id and p.status in ('succeeded','partially_refunded')
     where t.id = $1`,
    [txId],
  );
  const t = r.rows[0];
  if (!t?.provider_payment_ref) throw new RetryableError('no confirmed payment reference to refund');
  const out = await provider.refund({ idempotencyKey: `refund:${txId}`, paymentRef: t.provider_payment_ref, amountMinor });
  await ctx.db.tx(async (q) => {
    await q.query(
      `insert into money_ledger (transaction_id, entry_type, amount_minor, currency, provider_ref) values ($1,'refund_out',$2,$3,$4) on conflict do nothing`,
      [txId, amountMinor, t.currency, out.ref],
    );
    await q.query(`update payments set status = $2, updated_at = now() where transaction_id = $1 and status in ('succeeded','partially_refunded')`, [
      txId,
      amountMinor >= t.amount_minor ? 'refunded' : 'partially_refunded',
    ]);
    await lockTx(q, txId);
    await appendEvent(q, { transactionId: txId, type: 'refund.sent', actorId: null, actorRole: 'system', payload: { providerRef: out.ref, amountMinor } });
    await notify(q, t.buyer_id, 'refund_sent', { title: t.title });
  });
}
