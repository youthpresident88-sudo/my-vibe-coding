import { PGlite } from '@electric-sql/pglite';
import type { Db, Queryable } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { buildHandlers } from '../src/jobs/handlers.js';
import { Worker } from '../src/jobs/queue.js';
import type { Ctx } from '../src/modules/context.js';
import type { PaymentProvider, Providers, StorageProvider } from '../src/providers/types.js';
import { StripePaymentProvider } from '../src/providers/stripe.js';
import { createHmac } from 'node:crypto';

/** Real Postgres (WASM) behind the production Db interface. Same SQL, triggers, partial indexes, SKIP LOCKED. */
export async function createTestDb(): Promise<Db> {
  const pg = new PGlite();
  const wrap = (c: PGlite | { query: PGlite['query']; exec: PGlite['exec'] }): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const r = await c.query<T>(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.rows.length > 0 ? r.rows.length : (r.affectedRows ?? 0) };
    },
    async exec(sql: string) {
      await c.exec(sql);
    },
  });
  const db: Db = {
    ...wrap(pg),
    tx: (fn) => pg.transaction((t) => fn(wrap(t as never))),
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}

export const WEBHOOK_SECRET = 'whsec_test';

export class FakeStorage implements StorageProvider {
  objects = new Map<string, { sizeBytes: number; sha256Hex?: string }>();
  async presignUpload(i: { key: string }) {
    return { url: `https://storage.test/${i.key}`, headers: {} };
  }
  async head(key: string) {
    return this.objects.get(key) ?? null;
  }
  async presignDownload(key: string) {
    return `https://storage.test/dl/${key}`;
  }
}

/** Records calls; webhook verification uses the real HMAC scheme so signature rules are exercised. */
export class FakePayments implements PaymentProvider {
  readonly name = 'stripe';
  checkouts: Array<{ paymentId: string; amountMinor: number }> = [];
  refunds: Array<{ paymentRef: string; amountMinor: number }> = [];
  payouts: Array<{ destinationAccount: string; amountMinor: number }> = [];
  async createCheckout(i: { paymentId: string; amountMinor: number }) {
    this.checkouts.push(i);
    return { sessionRef: `cs_${i.paymentId}`, url: `https://checkout.test/${i.paymentId}` };
  }
  private readonly real = new StripePaymentProvider('sk_test_unused', WEBHOOK_SECRET);
  verifyWebhook(raw: Buffer, header: string | undefined) {
    return this.real.verifyWebhook(raw, header);
  }
  async refund(i: { paymentRef: string; amountMinor: number }) {
    this.refunds.push(i);
    return { ref: `re_${this.refunds.length}` };
  }
  async payout(i: { destinationAccount: string; amountMinor: number }) {
    this.payouts.push(i);
    return { ref: `tr_${this.payouts.length}` };
  }
}

export function signWebhook(body: string, secret = WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

export async function setup(over: Partial<Providers> = {}) {
  const db = await createTestDb();
  const config = loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'pglite://memory',
    LOG_LEVEL: 'fatal',
    RATE_LIMIT_MAX: '100000',
    PLATFORM_FEE_BPS: '250',
  } as NodeJS.ProcessEnv);
  const storage = new FakeStorage();
  const payments = new FakePayments();
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const providers: Providers = {
    storage,
    payments,
    email: {
      async send(i) {
        sent.push(i);
        return { messageId: `msg_${sent.length}` };
      },
    },
    ...over,
  };
  const ctx: Ctx = { db, config, providers };
  const app = await buildApp(ctx, { logger: false });
  const worker = new Worker(db, buildHandlers(ctx, { warn: () => undefined }), { info: () => undefined, error: () => undefined });
  const drain = async () => {
    for (let i = 0; i < 20; i++) if ((await worker.runOnce()) === 0) break;
  };
  return { db, ctx, app, storage, payments, sent, worker, drain };
}
