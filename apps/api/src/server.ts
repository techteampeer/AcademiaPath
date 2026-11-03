import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';

const host = process.env.API_HOST ?? '127.0.0.1';
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 4000);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid API_PORT: ${process.env.API_PORT ?? process.env.PORT}`);
}

const config = loadConfig();
const { db, pool } = createDatabase();

const app = buildApp({
  config,
  database: db,
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});
app.addHook('onClose', async () => {
  await pool.end();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`Received ${signal}, shutting down`);
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

try {
  await app.listen({ host, port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
