import type { Config } from './config.js';
import type { Providers } from './providers/types.js';
import { S3StorageProvider } from './providers/s3.js';
import { StripePaymentProvider } from './providers/stripe.js';
import { ResendEmailProvider, TwilioSmsProvider } from './providers/messaging.js';

/** Builds only the providers whose credentials are present. Missing ones surface as 503 / failed jobs, never as fake success. */
export function providersFromConfig(c: Config): { providers: Providers; missing: string[] } {
  const providers: Providers = {};
  const missing: string[] = [];
  if (c.STRIPE_SECRET_KEY && c.STRIPE_WEBHOOK_SECRET) {
    providers.payments = new StripePaymentProvider(c.STRIPE_SECRET_KEY, c.STRIPE_WEBHOOK_SECRET);
  } else missing.push('payments (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET)');
  if (c.S3_BUCKET) {
    providers.storage = new S3StorageProvider(c.S3_BUCKET, { region: c.S3_REGION, endpoint: c.S3_ENDPOINT, forcePathStyle: c.S3_FORCE_PATH_STYLE });
  } else missing.push('evidence storage (S3_BUCKET + AWS credentials)');
  if (c.RESEND_API_KEY && c.EMAIL_FROM) {
    providers.email = new ResendEmailProvider(c.RESEND_API_KEY, c.EMAIL_FROM);
  } else missing.push('email (RESEND_API_KEY, EMAIL_FROM)');
  if (c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN && c.TWILIO_FROM) {
    providers.sms = new TwilioSmsProvider(c.TWILIO_ACCOUNT_SID, c.TWILIO_AUTH_TOKEN, c.TWILIO_FROM);
  } else missing.push('sms (TWILIO_*)');
  missing.push('kyc (no provider adapter implemented yet)');
  return { providers, missing };
}
