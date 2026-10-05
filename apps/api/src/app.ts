import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import client from 'prom-client';
import type { Ctx, AuthUser } from './modules/context.js';
import { isStaff } from './modules/context.js';
import { AppError, badRequest, forbidden, notConfigured, notFound, unauthorized } from './lib/errors.js';
import { withIdempotency } from './lib/idempotency.js';
import { enqueue } from './jobs/queue.js';
import * as auth from './modules/auth.js';
import * as txs from './modules/transactions.js';
import * as evidence from './modules/evidence.js';
import * as payments from './modules/payments.js';
import { audit } from './modules/notifications.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    bearer: string | null;
  }
}

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const money = z.number().int().positive().max(100_000_000_00);
const currency = z.string().length(3).regex(/^[a-zA-Z]{3}$/);

const S = {
  register: z.object({ email: z.string().email().max(254), password: z.string().min(10).max(200), displayName: z.string().trim().min(1).max(80) }),
  login: z.object({ email: z.string().email(), password: z.string().min(1).max(200) }),
  token: z.object({ token: z.string().min(10).max(200) }),
  createTx: z.object({
    title: z.string().trim().min(1).max(140),
    description: z.string().max(4000).default(''),
    channel: z.enum(['tiktok', 'instagram', 'facebook', 'whatsapp', 'snapchat', 'x', 'other']).default('other'),
    amountMinor: money,
    currency,
    spec: z.object({
      items: z
        .array(z.object({ key: z.string().regex(/^[a-z0-9_-]{1,40}$/), description: z.string().trim().min(1).max(500) }))
        .min(1)
        .max(50)
        .refine((a) => new Set(a.map((i) => i.key)).size === a.length, 'item keys must be unique'),
      conditionNotes: z.string().max(2000).optional(),
    }),
  }),
  accept: z.object({ specHash: z.string().regex(/^[0-9a-f]{64}$/) }),
  cancel: z.object({ reason: z.string().trim().min(1).max(500) }),
  condition: z.object({ notes: z.string().max(2000).default('') }),
  dispatch: z.object({ carrier: z.string().trim().min(1).max(80), trackingNumber: z.string().trim().min(1).max(120) }),
  inspection: z.object({
    items: z
      .array(z.object({ specKey: z.string(), result: z.enum(['matches', 'mismatch', 'damaged', 'missing']), note: z.string().max(1000).optional() }))
      .min(1)
      .max(50),
  }),
  dispute: z.object({
    reasonCode: z.enum(['not_delivered', 'not_as_described', 'damaged', 'missing_items', 'counterfeit', 'other']),
    description: z.string().trim().min(10).max(4000),
  }),
  statement: z.object({ statement: z.string().trim().min(1).max(4000) }),
  resolve: z.object({
    resolution: z.enum(['full_refund', 'partial_refund', 'release_to_seller']),
    refundAmountMinor: z.number().int().positive().optional(),
    reason: z.string().trim().min(10).max(4000),
  }),
  upload: z.object({
    phase: z.enum(['seller_condition', 'dispatch', 'delivery', 'unboxing', 'inspection', 'dispute']),
    contentType: z.string().max(100),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    capturedAt: z.string().datetime().optional(),
  }),
  list: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), before: z.string().datetime().optional() }),
  payoutAccount: z.object({ accountRef: z.string().regex(/^acct_[A-Za-z0-9]+$/) }),
};

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('validation_error', 'Request validation failed', r.error.flatten());
  return r.data;
}

export async function buildApp(ctx: Ctx, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: ctx.config.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["stripe-signature"]'],
          },
    trustProxy: ctx.config.TRUST_PROXY,
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
  });

  // ---- metrics
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const httpHist = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: ctx.config.CORS_ORIGINS ? ctx.config.CORS_ORIGINS.split(',').map((s) => s.trim()) : false,
    credentials: false,
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key'],
  });
  await app.register(rateLimit, { max: ctx.config.RATE_LIMIT_MAX, timeWindow: '1 minute' });

  app.decorateRequest('user', null);
  app.decorateRequest('bearer', null);

  app.addHook('onResponse', async (req, reply) => {
    httpHist.observe(
      { method: req.method, route: req.routeOptions?.url ?? 'unmatched', status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'validation_error', message: 'Request validation failed', requestId: req.id } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message, requestId: req.id } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Internal server error', requestId: req.id } });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'Route not found', requestId: req.id } }),
  );

  // ---- auth helpers
  const authed = async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) throw unauthorized();
    const user = await auth.authenticate(ctx, token);
    if (!user) throw unauthorized('Invalid or expired session');
    req.user = user;
    req.bearer = token;
  };
  const staff = (...roles: AuthUser['role'][]) => async (req: FastifyRequest) => {
    await authed(req);
    if (!roles.includes(req.user!.role)) throw forbidden();
  };
  const me = (req: FastifyRequest) => req.user!;
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  // ---- ops endpoints
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await ctx.db.query('select 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not_ready' });
    }
  });
  app.get('/metrics', { config: { rateLimit: false } }, async (req, reply) => {
    if (ctx.config.METRICS_TOKEN && req.headers.authorization !== `Bearer ${ctx.config.METRICS_TOKEN}`) throw unauthorized();
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  // ---- payment webhook (raw body needed for signature verification)
  await app.register(async (hook) => {
    hook.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    hook.post('/v1/webhooks/stripe', { config: { rateLimit: false } }, async (req, reply) => {
      const provider = ctx.providers.payments;
      if (!provider) throw notConfigured('Payment provider');
      const evt = provider.verifyWebhook(req.body as Buffer, req.headers['stripe-signature'] as string | undefined);
      // Persist first, ack fast, process asynchronously. Unique (provider,event id) makes redelivery a no-op.
      await ctx.db.tx(async (q) => {
        const ins = await q.query<{ id: string }>(
          `insert into payment_webhook_events (provider, provider_event_id, type, payload) values ($1,$2,$3,$4)
           on conflict do nothing returning id`,
          [provider.name, evt.id, evt.type, JSON.stringify(evt.data ?? {})],
        );
        if (ins.rows[0]) await enqueue(q, 'webhook.process', { eventId: ins.rows[0].id }, { dedupeKey: `webhook:${provider.name}:${evt.id}` });
      });
      return reply.status(200).send({ received: true });
    });
  });

  // ---- v1 API
  await app.register(
    async (v1) => {
      // auth
      v1.post('/auth/register', strict, async (req, reply) => {
        const b = parse(S.register, req.body);
        const u = await auth.register(ctx, { ...b, ip: req.ip });
        return reply.status(201).send({ id: u.id, emailVerification: 'queued' });
      });
      v1.post('/auth/login', strict, async (req) => {
        const b = parse(S.login, req.body);
        const s = await auth.login(ctx, { ...b, ip: req.ip, userAgent: req.headers['user-agent'] });
        return { token: s.token, expiresAt: s.expiresAt };
      });
      v1.post('/auth/logout', { preHandler: authed }, async (req, reply) => {
        await auth.logout(ctx, req.bearer!);
        return reply.status(204).send();
      });
      v1.post('/auth/verify-email', strict, async (req, reply) => {
        await auth.confirmEmail(ctx, parse(S.token, req.body).token);
        return reply.status(204).send();
      });
      v1.post('/auth/verify-email/resend', { preHandler: authed, ...strict }, async (req, reply) => {
        await auth.resendVerification(ctx, me(req));
        return reply.status(202).send({ status: 'queued' });
      });
      v1.get('/me', { preHandler: authed }, async (req) => me(req));

      // seller verification (KYC): real provider required; never self-asserted
      v1.post('/seller/verification', { preHandler: authed }, async (req, reply) => {
        const kyc = ctx.providers.kyc;
        if (!kyc) throw notConfigured('Identity verification (KYC) provider');
        const out = await kyc.startVerification({ userId: me(req).id, email: me(req).email });
        await ctx.db.query(
          `update seller_profiles set verification_status='pending', kyc_reference=$2 where user_id=$1 and verification_status<>'verified'`,
          [me(req).id, out.reference],
        );
        return reply.status(202).send({ status: 'pending', url: out.url });
      });
      v1.get('/users/:id/trust', { preHandler: authed }, async (req) => {
        const { id } = parse(idParam, req.params);
        const r = await ctx.db.query<Record<string, number | string>>(
          `select coalesce(sp.verification_status,'unverified') as verification_status,
             (select count(*)::int from transactions where seller_id=$1 and state='completed') as completed_as_seller,
             (select count(*)::int from transactions where buyer_id=$1 and state='completed') as completed_as_buyer,
             (select count(*)::int from disputes d join transactions t on t.id=d.transaction_id where t.seller_id=$1) as disputes_as_seller,
             (select count(*)::int from disputes d join transactions t on t.id=d.transaction_id
                where t.seller_id=$1 and d.resolution in ('full_refund','partial_refund')) as disputes_lost_as_seller,
             (select count(*)::int from disputes where opened_by=$1) as disputes_opened_as_buyer
           from users u left join seller_profiles sp on sp.user_id = u.id where u.id = $1`,
          [id],
        );
        if (!r.rows[0]) throw notFound('User');
        return r.rows[0];
      });

      // transactions
      v1.post('/transactions', { preHandler: authed }, async (req, reply) => {
        const b = parse(S.createTx, req.body);
        const out = await withIdempotency(
          ctx.db,
          { userId: me(req).id, key: req.headers['idempotency-key'] as string | undefined, endpoint: 'POST /transactions', body: b },
          async () => ({ status: 201, body: serializeTx(await txs.createTransaction(ctx, me(req), b)) }),
        );
        return reply.status(out.status).send(out.body);
      });
      v1.get('/transactions', { preHandler: authed }, async (req) => {
        const q = parse(S.list, req.query);
        return { items: (await txs.listTransactions(ctx, me(req), q.limit, q.before)).map(serializeTx) };
      });
      v1.get('/transactions/:id', { preHandler: authed }, async (req) => {
        const { id } = parse(idParam, req.params);
        return serializeTx(await txs.getTransaction(ctx, me(req), id));
      });
      v1.get('/transactions/:id/preview', { preHandler: authed }, async (req) =>
        txs.previewTransaction(ctx, me(req), parse(idParam, req.params).id),
      );
      v1.get('/transactions/:id/timeline', { preHandler: authed }, async (req) =>
        txs.timeline(ctx, me(req), parse(idParam, req.params).id),
      );
      v1.get('/transactions/:id/comparison', { preHandler: authed }, async (req) =>
        txs.compareEvidence(ctx, me(req), parse(idParam, req.params).id),
      );
      v1.post('/transactions/:id/accept', { preHandler: authed }, async (req) =>
        serializeTx(await txs.acceptAgreement(ctx, me(req), parse(idParam, req.params).id, parse(S.accept, req.body).specHash)),
      );
      v1.post('/transactions/:id/cancel', { preHandler: authed }, async (req) =>
        serializeTx(await txs.cancelTransaction(ctx, me(req), parse(idParam, req.params).id, parse(S.cancel, req.body).reason)),
      );
      v1.post('/transactions/:id/condition', { preHandler: authed }, async (req) =>
        serializeTx(await txs.submitCondition(ctx, me(req), parse(idParam, req.params).id, parse(S.condition, req.body).notes)),
      );
      v1.post('/transactions/:id/checkout', { preHandler: authed }, async (req, reply) => {
        const { id } = parse(idParam, req.params);
        const out = await withIdempotency(
          ctx.db,
          { userId: me(req).id, key: req.headers['idempotency-key'] as string | undefined, endpoint: `POST /transactions/${id}/checkout`, body: {} },
          async () => ({ status: 200, body: await payments.startCheckout(ctx, me(req), id) }),
        );
        return reply.status(out.status).send(out.body);
      });
      v1.post('/transactions/:id/dispatch', { preHandler: authed }, async (req) =>
        serializeTx(await txs.dispatchGoods(ctx, me(req), parse(idParam, req.params).id, parse(S.dispatch, req.body))),
      );
      v1.post('/transactions/:id/delivery', { preHandler: authed }, async (req) =>
        serializeTx(await txs.confirmDelivery(ctx, me(req), parse(idParam, req.params).id)),
      );
      v1.post('/transactions/:id/inspection', { preHandler: authed }, async (req) =>
        serializeTx(await txs.submitInspection(ctx, me(req), parse(idParam, req.params).id, parse(S.inspection, req.body).items)),
      );
      v1.post('/transactions/:id/approve', { preHandler: authed }, async (req) =>
        serializeTx(await txs.approve(ctx, me(req), parse(idParam, req.params).id)),
      );
      v1.post('/transactions/:id/dispute', { preHandler: authed }, async (req, reply) => {
        const out = await txs.openDispute(ctx, me(req), parse(idParam, req.params).id, parse(S.dispute, req.body));
        return reply.status(201).send({ transaction: serializeTx(out.transaction as txs.TxRow), disputeId: out.disputeId });
      });
      v1.post('/transactions/:id/dispute/statements', { preHandler: authed }, async (req, reply) => {
        await txs.addDisputeStatement(ctx, me(req), parse(idParam, req.params).id, parse(S.statement, req.body).statement);
        return reply.status(201).send({ status: 'recorded' });
      });
      v1.post('/transactions/:id/dispute/resolve', { preHandler: staff('arbiter', 'admin') }, async (req) =>
        serializeTx(await txs.resolveDispute(ctx, me(req), parse(idParam, req.params).id, parse(S.resolve, req.body))),
      );

      // evidence
      v1.get('/transactions/:id/evidence', { preHandler: authed }, async (req) => ({
        items: await evidence.listEvidence(ctx, me(req), parse(idParam, req.params).id),
      }));
      v1.post('/transactions/:id/evidence', { preHandler: authed }, async (req, reply) =>
        reply.status(201).send(await evidence.requestUpload(ctx, me(req), parse(idParam, req.params).id, parse(S.upload, req.body))),
      );
      v1.post('/evidence/:id/confirm', { preHandler: authed }, async (req) =>
        evidence.confirmUpload(ctx, me(req), parse(idParam, req.params).id),
      );
      v1.get('/evidence/:id/download', { preHandler: authed }, async (req) =>
        evidence.downloadUrl(ctx, me(req), parse(idParam, req.params).id),
      );

      // notifications
      v1.get('/notifications', { preHandler: authed }, async (req) => {
        const r = await ctx.db.query(
          `select id, template, data, read_at, created_at from notifications
           where user_id = $1 and channel = 'in_app' order by created_at desc limit 50`,
          [me(req).id],
        );
        return { items: r.rows };
      });
      v1.post('/notifications/:id/read', { preHandler: authed }, async (req, reply) => {
        await ctx.db.query('update notifications set read_at = now() where id = $1 and user_id = $2 and read_at is null', [
          parse(idParam, req.params).id,
          me(req).id,
        ]);
        return reply.status(204).send();
      });

      // admin / operations
      v1.get('/admin/disputes', { preHandler: staff('support', 'arbiter', 'admin') }, async () => {
        const r = await ctx.db.query(
          `select d.*, t.title, t.amount_minor, t.currency from disputes d join transactions t on t.id = d.transaction_id
           where d.status = 'open' order by d.created_at`,
        );
        return { items: r.rows };
      });
      v1.get('/admin/jobs/dead', { preHandler: staff('admin') }, async () => {
        const r = await ctx.db.query(
          `select id, queue, payload, attempts, last_error, finished_at from jobs where status = 'dead' order by finished_at desc limit 100`,
        );
        return { items: r.rows };
      });
      v1.get('/admin/audit', { preHandler: staff('admin') }, async (req) => {
        const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
        const r = await ctx.db.query('select * from audit_log order by id desc limit $1', [q.limit]);
        return { items: r.rows };
      });
      v1.post('/admin/users/:id/suspend', { preHandler: staff('admin') }, async (req, reply) => {
        const { id } = parse(idParam, req.params);
        await ctx.db.tx(async (q) => {
          await q.query(`update users set status='suspended' where id=$1`, [id]);
          await q.query('update sessions set revoked_at = now() where user_id=$1 and revoked_at is null', [id]);
          await audit(q, { actorId: me(req).id, action: 'user.suspended', entityType: 'user', entityId: id, ip: req.ip });
        });
        return reply.status(204).send();
      });
      // Interim: payout destination is set by an admin until Stripe Connect onboarding webhooks are wired in.
      v1.put('/admin/sellers/:id/payout-account', { preHandler: staff('admin') }, async (req, reply) => {
        const { id } = parse(idParam, req.params);
        const b = parse(S.payoutAccount, req.body);
        await ctx.db.tx(async (q) => {
          await q.query('update seller_profiles set payout_account_ref=$2 where user_id=$1', [id, b.accountRef]);
          await audit(q, { actorId: me(req).id, action: 'seller.payout_account_set', entityType: 'user', entityId: id, ip: req.ip });
        });
        return reply.status(204).send();
      });
    },
    { prefix: '/v1' },
  );

  return app;
}

function serializeTx(t: txs.TxRow) {
  return {
    id: t.id,
    sellerId: t.seller_id,
    buyerId: t.buyer_id,
    title: t.title,
    description: t.description,
    channel: t.channel,
    amountMinor: t.amount_minor,
    currency: t.currency,
    spec: t.spec,
    specHash: t.spec_hash,
    state: t.state,
    carrier: t.carrier,
    trackingNumber: t.tracking_number,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}
