import type { Queryable } from '../db/db.js';
import { enqueue } from '../jobs/queue.js';

export async function audit(
  q: Queryable,
  e: { actorId: string | null; action: string; entityType: string; entityId?: string; ip?: string; metadata?: object },
): Promise<void> {
  await q.query(
    'insert into audit_log (actor_id, action, entity_type, entity_id, ip, metadata) values ($1,$2,$3,$4,$5,$6)',
    [e.actorId, e.action, e.entityType, e.entityId ?? null, e.ip ?? null, JSON.stringify(e.metadata ?? {})],
  );
}

export type Template =
  | 'verify_email'
  | 'agreement_accepted'
  | 'condition_documented'
  | 'payment_confirmed'
  | 'goods_dispatched'
  | 'delivery_confirmed'
  | 'inspection_submitted'
  | 'transaction_completed'
  | 'dispute_opened'
  | 'dispute_resolved'
  | 'payout_sent'
  | 'refund_sent'
  | 'transaction_cancelled';

/** Queues an in-app and an email notification in the caller's DB transaction. Delivery happens in the worker. */
export async function notify(q: Queryable, userId: string, template: Template, data: Record<string, unknown> = {}): Promise<void> {
  for (const channel of ['in_app', 'email'] as const) {
    const r = await q.query<{ id: string }>(
      `insert into notifications (user_id, channel, template, data, status, sent_at)
       values ($1,$2,$3,$4, $5, case when $2 = 'in_app' then now() end) returning id`,
      [userId, channel, template, JSON.stringify(data), channel === 'in_app' ? 'sent' : 'queued'],
    );
    if (channel === 'email') {
      await enqueue(q, 'notification.send', { notificationId: r.rows[0]!.id });
    }
  }
}

const COPY: Record<Template, (d: any) => { subject: string; text: string }> = {
  verify_email: (d) => ({ subject: 'Verify your email', text: `Your verification code: ${d.token}` }),
  agreement_accepted: (d) => ({ subject: 'Agreement accepted', text: `The buyer accepted the specification for "${d.title}".` }),
  condition_documented: (d) => ({ subject: 'Seller documented the item condition', text: `Review the evidence for "${d.title}" before paying.` }),
  payment_confirmed: (d) => ({ subject: 'Payment secured', text: `Payment for "${d.title}" was confirmed by the payment provider and is held until completion.` }),
  goods_dispatched: (d) => ({ subject: 'Your item was dispatched', text: `"${d.title}" was dispatched via ${d.carrier} (${d.trackingNumber}).` }),
  delivery_confirmed: (d) => ({ subject: 'Delivery confirmed', text: `The buyer confirmed delivery of "${d.title}".` }),
  inspection_submitted: (d) => ({ subject: 'Inspection submitted', text: `The buyer submitted an inspection for "${d.title}": ${d.overall}.` }),
  transaction_completed: (d) => ({ subject: 'Transaction completed', text: `"${d.title}" is complete.` }),
  dispute_opened: (d) => ({ subject: 'A dispute was opened', text: `A dispute was opened on "${d.title}" (${d.reason}). Add your evidence.` }),
  dispute_resolved: (d) => ({ subject: 'Dispute decided', text: `Decision for "${d.title}": ${d.resolution}. Reason: ${d.reason}` }),
  payout_sent: (d) => ({ subject: 'Payout sent', text: `Payout for "${d.title}" was accepted by the payment provider.` }),
  refund_sent: (d) => ({ subject: 'Refund issued', text: `A refund for "${d.title}" was accepted by the payment provider.` }),
  transaction_cancelled: (d) => ({ subject: 'Transaction cancelled', text: `"${d.title}" was cancelled.` }),
};

export const renderEmail = (template: Template, data: unknown) => COPY[template](data);
