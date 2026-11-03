import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { createAuthHooks, createOriginCheck } from './auth/hooks.js';
import type { AppConfig } from './config.js';
import type { Database } from './db/client.js';
import { registerErrorHandling } from './http/errors.js';
import { academicRoutes } from './routes/academic.js';
import { authRoutes } from './routes/auth.js';
import { courseRoutes } from './routes/courses.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';

export const API_PREFIX = '/api/v1';

/** Defense in depth: credentials, cookies and tokens are redacted even if a serializer starts logging them. */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.csrfToken',
];

export type BuildAppOptions = {
  config: AppConfig;
  database: Database;
  logger?: false | { level: string; stream?: { write(message: string): void } };
};

export function buildApp({ config, database, logger = false }: BuildAppOptions) {
  const app = Fastify({
    logger: logger === false ? false : { ...logger, redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' } },
    trustProxy: config.trustProxy,
    // Reject unexpected request properties instead of silently dropping them.
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.decorate('config', config);
  app.decorate('db', database);
  app.decorateRequest('auth', null);

  const hooks = createAuthHooks({ db: database, config });
  app.decorate('requireAuth', hooks.requireAuth);
  app.decorate('requireCsrf', hooks.requireCsrf);
  app.decorate('requireAdministrator', hooks.requireAdministrator);

  registerErrorHandling(app);
  app.addHook('onRequest', createOriginCheck(config));

  app.register(cookie);
  app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({ statusCode: 429, message: 'Too many attempts. Try again later.' }),
  });

  app.register(healthRoutes, { prefix: API_PREFIX });
  app.register(authRoutes, { prefix: API_PREFIX });
  app.register(meRoutes, { prefix: API_PREFIX });
  app.register(academicRoutes, { prefix: API_PREFIX });
  app.register(courseRoutes, { prefix: API_PREFIX });

  return app;
}
