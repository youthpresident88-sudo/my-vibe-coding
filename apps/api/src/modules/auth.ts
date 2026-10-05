import type { Ctx, AuthUser } from './context.js';
import { hashPassword, hashToken, newToken, verifyPassword } from '../lib/crypto.js';
import { AppError, conflict, unauthorized } from '../lib/errors.js';
import { audit, notify } from './notifications.js';

const DUMMY_HASH = 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export async function register(
  ctx: Ctx,
  i: { email: string; password: string; displayName: string; ip?: string },
): Promise<{ id: string }> {
  const passwordHash = await hashPassword(i.password);
  return ctx.db.tx(async (q) => {
    const email = i.email.trim();
    const r = await q.query<{ id: string }>(
      `insert into users (email, password_hash, display_name) values ($1,$2,$3)
       on conflict do nothing returning id`,
      [email, passwordHash, i.displayName],
    );
    const user = r.rows[0];
    if (!user) throw conflict('email_taken', 'An account with this email already exists');
    await q.query('insert into seller_profiles (user_id) values ($1)', [user.id]);
    const token = newToken();
    await q.query(
      `insert into auth_tokens (user_id, purpose, token_hash, expires_at)
       values ($1,'verify_email',$2, now() + interval '24 hours')`,
      [user.id, hashToken(token)],
    );
    await notify(q, user.id, 'verify_email', { token });
    await audit(q, { actorId: user.id, action: 'user.registered', entityType: 'user', entityId: user.id, ip: i.ip });
    return { id: user.id };
  });
}

export async function login(
  ctx: Ctx,
  i: { email: string; password: string; ip?: string; userAgent?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const r = await ctx.db.query<{ id: string; password_hash: string; status: string }>(
    'select id, password_hash, status from users where lower(email) = lower($1)',
    [i.email.trim()],
  );
  const user = r.rows[0];
  // Always run a hash comparison so response time does not reveal whether the account exists.
  const ok = await verifyPassword(i.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Invalid email or password');
  if (user.status !== 'active') throw new AppError(403, 'account_suspended', 'Account is suspended');
  const token = newToken();
  const expiresAt = new Date(Date.now() + ctx.config.SESSION_TTL_HOURS * 3600_000);
  await ctx.db.tx(async (q) => {
    await q.query('insert into sessions (user_id, token_hash, expires_at, user_agent, ip) values ($1,$2,$3,$4,$5)', [
      user.id,
      hashToken(token),
      expiresAt.toISOString(),
      i.userAgent?.slice(0, 300) ?? null,
      i.ip ?? null,
    ]);
    await audit(q, { actorId: user.id, action: 'user.login', entityType: 'user', entityId: user.id, ip: i.ip });
  });
  return { token, expiresAt };
}

export async function logout(ctx: Ctx, token: string): Promise<void> {
  await ctx.db.query('update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [hashToken(token)]);
}

export async function authenticate(ctx: Ctx, token: string): Promise<AuthUser | null> {
  const r = await ctx.db.query<{
    id: string;
    email: string;
    display_name: string;
    role: AuthUser['role'];
    email_verified_at: Date | null;
  }>(
    `select u.id, u.email, u.display_name, u.role, u.email_verified_at
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.status = 'active'`,
    [hashToken(token)],
  );
  const u = r.rows[0];
  if (!u) return null;
  return { id: u.id, email: u.email, displayName: u.display_name, role: u.role, emailVerified: u.email_verified_at !== null };
}

export async function confirmEmail(ctx: Ctx, token: string): Promise<void> {
  await ctx.db.tx(async (q) => {
    const r = await q.query<{ id: string; user_id: string }>(
      `update auth_tokens set used_at = now()
       where token_hash = $1 and purpose = 'verify_email' and used_at is null and expires_at > now()
       returning id, user_id`,
      [hashToken(token)],
    );
    const row = r.rows[0];
    if (!row) throw new AppError(400, 'invalid_token', 'Token is invalid or expired');
    await q.query('update users set email_verified_at = now() where id = $1 and email_verified_at is null', [row.user_id]);
    await audit(q, { actorId: row.user_id, action: 'user.email_verified', entityType: 'user', entityId: row.user_id });
  });
}

export async function resendVerification(ctx: Ctx, user: AuthUser): Promise<void> {
  if (user.emailVerified) return;
  const token = newToken();
  await ctx.db.tx(async (q) => {
    await q.query(
      `insert into auth_tokens (user_id, purpose, token_hash, expires_at)
       values ($1,'verify_email',$2, now() + interval '24 hours')`,
      [user.id, hashToken(token)],
    );
    await notify(q, user.id, 'verify_email', { token });
  });
}
