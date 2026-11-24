import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { createAuthHooks, createOriginCheck } from './auth/hooks.js';
import type { AppConfig } from './config.js';
import type { Database } from './db/client.js';
import { registerErrorHandling } from './http/errors.js';
import { academicRoutes } from './routes/academic.js';
import { activityRoutes } from './routes/activities.js';
import { qualityRoutes } from './routes/quality.js';
import { authRoutes } from './routes/auth.js';
import { courseRoutes } from './routes/courses.js';
import { courseExportRoutes } from './routes/course-export.js';
import { courseImportRoutes } from './routes/course-import.js';
import { courseArchiveImportRoutes } from './routes/course-archive-import.js';
import { courseArchiveConfirmRoutes } from './routes/course-archive-confirm.js';
import { documentRoutes, type DocumentRouteOptions } from './routes/documents.js';
import { ClamdScanner } from './documents/clamd.js';
import { noMalwareScanner, type MalwareScanner } from './documents/scanner.js';
import { isMountPoint as detectMountPoint } from './documents/mounts.js';
import { checkStorageReadiness } from './documents/readiness.js';
import { LocalDocumentStorage } from './documents/storage.js';
import { systemRoutes } from './routes/system.js';
import { scormRoutes } from './routes/scorm.js';
import { cartridgeRoutes } from './routes/cartridge.js';
import { mockSummaryProvider } from './documents/summary.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { gradingRoutes } from './routes/grading.js';
import { gradebookRoutes } from './routes/gradebook.js';
import { certificateRoutes } from './routes/certificates.js';
import { announcementRoutes } from './routes/announcements.js';
import { calendarRoutes } from './routes/calendar.js';
import { messagingRoutes } from './routes/messaging.js';
import { courseEmailRoutes } from './routes/course-email.js';
import { notificationRoutes } from './routes/notifications.js';
import { forumRoutes } from './routes/forums.js';
import { groupRoutes } from './routes/groups.js';
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
  /** Defaults: private local storage from config, the configured malware scanner (none by default), mock summary provider. */
  documents?: Partial<DocumentRouteOptions>;
  /** The API server clock (default: the system clock). Tests inject a controlled clock for timer boundaries. */
  clock?: () => Date;
  /** AP-040B: mount detection used by the storage readiness check (tests replace it; default: the mount table). */
  isMountPoint?: (path: string) => Promise<boolean>;
};

/** AP-040B: how long `enforce` waits for the startup storage check before refusing to start. */
const STORAGE_STARTUP_CHECK_MS = 10_000;

/** The promise's value, or null once `ms` have passed (the timer never keeps the process alive). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref();
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

export function buildApp({ config, database, logger = false, documents = {}, clock = () => new Date(), isMountPoint = detectMountPoint }: BuildAppOptions) {
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
  app.decorate('storageReadiness', () => checkStorageReadiness(config.documents.storageDir, config.documents.mountCheck, { isMountPoint, now: clock }));

  // AP-040E: one scanner for document uploads and archive imports (none unless explicitly configured).
  const scanning = config.malwareScanning;
  const clamd =
    scanning.scanner === 'clamd' && scanning.clamd
      ? new ClamdScanner({ endpoint: scanning.clamd, timeoutMs: scanning.timeoutMs, maxBytes: scanning.maxBytes, maxConcurrent: scanning.maxConcurrent })
      : null;
  const malwareScanner: MalwareScanner = documents.scanner ?? clamd ?? noMalwareScanner;
  // Says at startup what protects new documents; checking that clamd answers never delays or stops the API.
  app.addHook('onReady', async () => {
    const summary = { malwareScanning: { scanner: scanning.scanner, enforcement: scanning.enforcement } };
    if (!clamd) {
      app.log.info(summary, 'Malware scanning is not configured: new documents are recorded as not_scanned');
      return;
    }
    void clamd.ping(5_000).then((reachable) => {
      if (reachable) app.log.info(summary, 'Malware scanning: clamd is reachable');
      else if (scanning.enforcement === 'strict') app.log.error(summary, 'Malware scanning: clamd is not reachable; new documents are refused until it is');
      else app.log.warn(summary, 'Malware scanning: clamd is not reachable; new documents are recorded as not_scanned until it is');
    });
  });

  // AP-040B: check document storage once at startup and say what was found (never the directory's contents). Only
  // `enforce` waits for the check (at most STORAGE_STARTUP_CHECK_MS) and stops the API when storage is not ready.
  // `report` (the production default) runs it in the background: an unverified check on the Cloud Storage mount can
  // neither stop nor delay the API's startup.
  app.addHook('onReady', async () => {
    if (config.documents.mountCheck === 'off') return;
    const check = withTimeout(app.storageReadiness(), STORAGE_STARTUP_CHECK_MS).then((readiness) => {
      if (!readiness) {
        app.log.error({ storage: { mountCheck: config.documents.mountCheck } }, `Document storage check did not finish within ${STORAGE_STARTUP_CHECK_MS / 1000} s`);
        return null;
      }
      const summary = { storage: { status: readiness.status, mountCheck: readiness.mountCheck, directory: readiness.directory, access: readiness.access, mount: readiness.mount } };
      if (readiness.status === 'ready') app.log.info(summary, 'Document storage is ready');
      else if (readiness.status === 'degraded') app.log.warn(summary, 'Document storage is usable, but no mount was detected at its directory');
      else app.log.error(summary, 'Document storage does not look usable: uploads and downloads are expected to fail');
      return readiness;
    });
    if (config.documents.mountCheck === 'report') {
      check.catch((error: unknown) => app.log.error({ err: error }, 'Document storage check failed'));
      return;
    }
    const readiness = await check;
    if (readiness?.status !== 'ready') {
      throw new Error(
        readiness
          ? `Document storage is not ready (directory ${readiness.directory}, access ${readiness.access}, mount ${readiness.mount}); DOCUMENT_STORAGE_MOUNT_CHECK=enforce`
          : 'Document storage is not ready (the check timed out); DOCUMENT_STORAGE_MOUNT_CHECK=enforce',
      );
    }
  });

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
  app.register(qualityRoutes, { prefix: API_PREFIX });
  app.register(quizRoutes, { prefix: API_PREFIX });
  app.register(gradingRoutes, { prefix: API_PREFIX });
  app.register(gradebookRoutes, { prefix: API_PREFIX });
  app.register(certificateRoutes, { prefix: API_PREFIX });
  app.register(announcementRoutes, { prefix: API_PREFIX });
  app.register(calendarRoutes, { prefix: API_PREFIX });
  app.register(messagingRoutes, { prefix: API_PREFIX });
  app.register(courseEmailRoutes, { prefix: API_PREFIX });
  app.register(notificationRoutes, { prefix: API_PREFIX });
  app.register(forumRoutes, { prefix: API_PREFIX });
  app.register(groupRoutes, { prefix: API_PREFIX });
  app.register(tutorRoutes, { prefix: API_PREFIX });
  app.register(progressRoutes, { prefix: API_PREFIX });
  app.register(resourceRoutes, { prefix: API_PREFIX });
  const documentStorage = documents.storage ?? new LocalDocumentStorage(config.documents.storageDir, { createRoot: config.documents.createStorageDir });
  app.register(systemRoutes, { prefix: API_PREFIX });
  app.register(scormRoutes, { prefix: API_PREFIX });
  app.register(cartridgeRoutes, { prefix: API_PREFIX });
  app.register(courseExportRoutes, { prefix: API_PREFIX, storage: documentStorage });
  app.register(courseImportRoutes, { prefix: API_PREFIX });
  app.register(courseArchiveImportRoutes, { prefix: API_PREFIX });
  app.register(courseArchiveConfirmRoutes, {
    prefix: API_PREFIX,
    storage: documentStorage,
    scanner: malwareScanner,
    provider: documents.provider ?? mockSummaryProvider,
  });
  app.register(documentRoutes, {
    prefix: API_PREFIX,
    storage: documentStorage,
    scanner: malwareScanner,
    provider: documents.provider ?? mockSummaryProvider,
    ...(documents.extract ? { extract: documents.extract } : {}),
  });

  return app;
}
