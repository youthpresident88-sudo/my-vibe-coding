import { loadConfig } from './config.js';
import { createPgDb } from './db/db.js';
import { buildApp } from './app.js';
import { providersFromConfig } from './bootstrap.js';

const config = loadConfig();
const db = createPgDb({ url: config.DATABASE_URL, max: config.DATABASE_POOL_MAX, ssl: config.DATABASE_SSL });
const { providers, missing } = providersFromConfig(config);
const app = await buildApp({ db, config, providers });

for (const m of missing) app.log.warn(`provider not configured: ${m}`);

const shutdown = async (sig: string) => {
  app.log.info({ sig }, 'shutting down');
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: '0.0.0.0' });
