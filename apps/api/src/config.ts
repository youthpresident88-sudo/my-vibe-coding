import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z
  .object({
    APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
    PORT: z.coerce.number().int().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().min(1),
    DATABASE_POOL_MAX: z.coerce.number().int().default(20),
    DATABASE_SSL: bool,
    CORS_ORIGINS: z.string().default(''),
    PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
    SESSION_TTL_HOURS: z.coerce.number().int().default(168),
    RATE_LIMIT_MAX: z.coerce.number().int().default(300),
    METRICS_TOKEN: z.string().optional(),
    TRUST_PROXY: bool,

    PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(5000).default(0),
    SUPPORTED_CURRENCIES: z.string().default('usd'),
    // When true, only sellers with verification_status = 'verified' may create transactions.
    REQUIRE_SELLER_KYC: bool,

    // Payments (Stripe). Absent => payment endpoints return 503 provider_not_configured.
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),

    // Evidence storage (S3-compatible). Credentials come from the AWS default provider chain.
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_ENDPOINT: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool,
    MAX_EVIDENCE_BYTES: z.coerce.number().int().default(500 * 1024 * 1024),

    // Email (Resend) and SMS (Twilio). Absent => notifications fail visibly, never "sent".
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_FROM: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if ((c.APP_ENV === 'production' || c.APP_ENV === 'staging') && !c.CORS_ORIGINS) {
      ctx.addIssue({ code: 'custom', message: 'CORS_ORIGINS is required in staging/production', path: ['CORS_ORIGINS'] });
    }
    if (c.APP_ENV === 'production' && !c.METRICS_TOKEN) {
      ctx.addIssue({ code: 'custom', message: 'METRICS_TOKEN is required in production', path: ['METRICS_TOKEN'] });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  return parsed.data;
}
