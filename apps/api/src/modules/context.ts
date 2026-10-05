import type { Db } from '../db/db.js';
import type { Config } from '../config.js';
import type { Providers } from '../providers/types.js';

export interface Ctx {
  db: Db;
  config: Config;
  providers: Providers;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'support' | 'arbiter' | 'admin';
  emailVerified: boolean;
}

export const isStaff = (u: AuthUser) => u.role !== 'user';
