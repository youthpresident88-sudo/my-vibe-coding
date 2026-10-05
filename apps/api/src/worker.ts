import pino from 'pino';
import { loadConfig } from './config.js';
import { createPgDb } from './db/db.js';
import { providersFromConfig } from './bootstrap.js';
import { buildHandlers } from './jobs/handlers.js';
import { Worker } from './jobs/queue.js';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, base: { service: 'worker' } });
const db = createPgDb({ url: config.DATABASE_URL, max: config.DATABASE_POOL_MAX, ssl: config.DATABASE_SSL });
const { providers } = providersFromConfig(config);
const worker = new Worker(db, buildHandlers({ db, config, providers }, log), log);

worker.start();
log.info('worker started');

const shutdown = async () => {
  await worker.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
