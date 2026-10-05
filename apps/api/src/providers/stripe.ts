import { createHmac, timingSafeEqual } from 'node:crypto';
import { badRequest } from '../lib/errors.js';
import { form, httpJson } from './http.js';
import type { CheckoutInput, PaymentProvider, ProviderWebhookEvent } from './types.js';

const API = 'https://api.stripe.com/v1';
const TOLERANCE_SEC = 300;

/** Pure function so signature handling is unit-testable. Mirrors Stripe's documented v1 scheme. */
export function verifyStripeSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): void {
  if (!header) throw badRequest('invalid_signature', 'Missing signature');
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || sigs.length === 0) throw badRequest('invalid_signature', 'Malformed signature');
  if (Math.abs(nowSec - Number(t)) > TOLERANCE_SEC) throw badRequest('invalid_signature', 'Stale signature');
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const ok = sigs.some((s) => {
    const b = Buffer.from(s, 'hex');
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
  if (!ok) throw badRequest('invalid_signature', 'Signature mismatch');
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
  ) {}

  private headers(idempotencyKey: string) {
    return {
      authorization: `Bearer ${this.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': idempotencyKey,
    };
  }

  async createCheckout(i: CheckoutInput) {
    const { body } = await httpJson(`${API}/checkout/sessions`, {
      method: 'POST',
      headers: this.headers(`checkout:${i.paymentId}`),
      body: form({
        mode: 'payment',
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
        client_reference_id: i.paymentId,
        'line_items[0][quantity]': 1,
        'line_items[0][price_data][currency]': i.currency.toLowerCase(),
        'line_items[0][price_data][unit_amount]': i.amountMinor,
        'line_items[0][price_data][product_data][name]': i.title,
        'metadata[payment_id]': i.paymentId,
        'metadata[transaction_id]': i.transactionId,
        'payment_intent_data[transfer_group]': i.transactionId,
        'payment_intent_data[metadata][payment_id]': i.paymentId,
      }),
    });
    if (!body?.id || !body?.url) throw new Error('Stripe returned an unexpected checkout response');
    return { sessionRef: body.id as string, url: body.url as string };
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): ProviderWebhookEvent {
    verifyStripeSignature(rawBody, signatureHeader, this.webhookSecret);
    const evt = JSON.parse(rawBody.toString('utf8'));
    return { id: evt.id, type: evt.type, data: evt.data?.object };
  }

  async refund(i: { idempotencyKey: string; paymentRef: string; amountMinor: number }) {
    const { body } = await httpJson(`${API}/refunds`, {
      method: 'POST',
      headers: this.headers(i.idempotencyKey),
      body: form({ payment_intent: i.paymentRef, amount: i.amountMinor }),
    });
    return { ref: body.id as string };
  }

  async payout(i: {
    idempotencyKey: string;
    destinationAccount: string;
    amountMinor: number;
    currency: string;
    transferGroup: string;
  }) {
    const { body } = await httpJson(`${API}/transfers`, {
      method: 'POST',
      headers: this.headers(i.idempotencyKey),
      body: form({
        amount: i.amountMinor,
        currency: i.currency.toLowerCase(),
        destination: i.destinationAccount,
        transfer_group: i.transferGroup,
      }),
    });
    return { ref: body.id as string };
  }
}
