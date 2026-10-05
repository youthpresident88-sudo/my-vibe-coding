import { loadConfig } from '../config.js';
import { createPgDb } from '../db/db.js';
import { hashPassword } from '../lib/crypto.js';

// Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_ROLE=admin|arbiter|support npm run create-admin -w @evidence-trust/api
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const role = process.env.ADMIN_ROLE ?? 'admin';
if (!email || !password || password.length < 12 || !['admin', 'arbiter', 'support'].includes(role)) {
  console.error('Set ADMIN_EMAIL, ADMIN_PASSWORD (>=12 chars) and optionally ADMIN_ROLE');
  process.exit(1);
}
const config = loadConfig();
const db = createPgDb({ url: config.DATABASE_URL, max: 2, ssl: config.DATABASE_SSL });
const r = await db.query(
  `insert into users (email, password_hash, display_name, role, email_verified_at)
   values ($1,$2,$3,$4, now()) on conflict do nothing`,
  [email, await hashPassword(password), `Staff ${role}`, role],
);
console.log(r.rowCount ? `created ${role} ${email}` : 'user already exists; nothing changed');
await db.close();
