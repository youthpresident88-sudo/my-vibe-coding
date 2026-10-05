export interface StorageProvider {
  presignUpload(i: {
    key: string;
    contentType: string;
    sizeBytes: number;
    sha256Hex: string;
    expiresSec: number;
  }): Promise<{ url: string; headers: Record<string, string> }>;
  /** Returns null when the object does not exist. sha256Hex is returned only if the store computed/verified it. */
  head(key: string): Promise<{ sizeBytes: number; sha256Hex?: string } | null>;
  presignDownload(key: string, expiresSec: number): Promise<string>;
}

export interface CheckoutInput {
  paymentId: string;
  transactionId: string;
  title: string;
  amountMinor: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

export interface ProviderWebhookEvent {
  id: string;
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export interface PaymentProvider {
  readonly name: string;
  createCheckout(i: CheckoutInput): Promise<{ sessionRef: string; url: string }>;
  /** Throws AppError(400) if the signature is missing/invalid/stale. */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): ProviderWebhookEvent;
  refund(i: { idempotencyKey: string; paymentRef: string; amountMinor: number }): Promise<{ ref: string }>;
  payout(i: {
    idempotencyKey: string;
    destinationAccount: string;
    amountMinor: number;
    currency: string;
    transferGroup: string;
  }): Promise<{ ref: string }>;
}

export interface EmailProvider {
  send(i: { to: string; subject: string; text: string }): Promise<{ messageId: string }>;
}

export interface SmsProvider {
  send(i: { to: string; body: string }): Promise<{ messageId: string }>;
}

export interface KycProvider {
  /** Starts a hosted verification flow. 'verified' may only be set from a provider-signed result. */
  startVerification(i: { userId: string; email: string }): Promise<{ reference: string; url: string }>;
}

export interface Providers {
  storage?: StorageProvider;
  payments?: PaymentProvider;
  email?: EmailProvider;
  sms?: SmsProvider;
  kyc?: KycProvider;
}
