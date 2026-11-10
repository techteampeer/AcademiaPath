import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { createAuthHooks, createOriginCheck } from './auth/hooks.js';
import type { AppConfig } from './config.js';
import type { Database } from './db/client.js';
import { registerErrorHandling } from './http/errors.js';
import { academicRoutes } from './routes/academic.js';
import { activityRoutes } from './routes/activities.js';
import { authRoutes } from './routes/auth.js';
import { courseRoutes } from './routes/courses.js';
import { documentRoutes, type DocumentRouteOptions } from './routes/documents.js';
import { noMalwareScanner } from './documents/scanner.js';
import { LocalDocumentStorage } from './documents/storage.js';
import { mockSummaryProvider } from './documents/summary.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { gradingRoutes } from './routes/grading.js';
import { gradebookRoutes } from './routes/gradebook.js';
import { quizRoutes } from './routes/quizzes.js';
import { tutorRoutes } from './routes/tutor.js';
import { courseLifecycleRoutes } from './routes/course-lifecycle.js';
import { programManagerRoutes } from './routes/program-managers.js';
import { enrollmentRoutes } from './routes/enrollments.js';
import { userRoutes } from './routes/users.js';
import { progressRoutes } from './routes/progress.js';
import { resourceRoutes } from './routes/resources.js';

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
  /** Defaults: private local storage from config, no malware scanner connected, mock summary provider. */
  documents?: Partial<DocumentRouteOptions>;
  /** The API server clock (default: the system clock). Tests inject a controlled clock for timer boundaries. */
  clock?: () => Date;
};

export function buildApp({ config, database, logger = false, documents = {}, clock = () => new Date() }: BuildAppOptions) {
  const app = Fastify({
    logger: logger === false ? false : { ...logger, redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' } },
    trustProxy: config.trustProxy,
    // Reject unexpected request properties instead of silently dropping them.
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.decorate('config', config);
  app.decorate('db', database);
  app.decorate('now', clock);
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
  app.register(enrollmentRoutes, { prefix: API_PREFIX });
  app.register(courseLifecycleRoutes, { prefix: API_PREFIX });
  app.register(programManagerRoutes, { prefix: API_PREFIX });
  app.register(userRoutes, { prefix: API_PREFIX });
  app.register(activityRoutes, { prefix: API_PREFIX });
  app.register(quizRoutes, { prefix: API_PREFIX });
  app.register(gradingRoutes, { prefix: API_PREFIX });
  app.register(gradebookRoutes, { prefix: API_PREFIX });
  app.register(tutorRoutes, { prefix: API_PREFIX });
  app.register(progressRoutes, { prefix: API_PREFIX });
  app.register(resourceRoutes, { prefix: API_PREFIX });
  app.register(documentRoutes, {
    prefix: API_PREFIX,
    storage: documents.storage ?? new LocalDocumentStorage(config.documents.storageDir),
    scanner: documents.scanner ?? noMalwareScanner,
    provider: documents.provider ?? mockSummaryProvider,
  });

  return app;
}
