import { loadConfig } from '../config.js';
import { createPgDb } from '../db/db.js';
import { migrate } from '../db/migrate.js';

const config = loadConfig();
const db = createPgDb({ url: config.DATABASE_URL, max: 2, ssl: config.DATABASE_SSL });
const applied = await migrate(db, (m) => console.log(m));
console.log(applied.length ? `applied ${applied.length} migration(s)` : 'database up to date');
await db.close();
