import multipart from '@fastify/multipart';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { getAuth } from '../auth/hooks.js';
import { extractInWorker } from '../documents/extraction.js';
import type { MalwareScanner } from '../documents/scanner.js';
import type { DocumentStorage } from '../documents/storage.js';
import type { DocumentSummaryProvider } from '../documents/summary.js';
import { ApiProblem } from '../http/errors.js';
import { readUploadedFile } from '../http/uploads.js';
import { ArchiveImportError, importCourseArchive } from '../portability/archive-import.js';
import { readCourseArchiveInWorker } from '../portability/archive-preview.js';
import { ARCHIVE_VALIDATION_LIMITS } from '../portability/archive-validation.js';
import { archiveImportAvailabilitySchema, archiveImportFieldsSchema, archiveImportResultSchema } from './course-archive-import-schemas.js';

export type ArchiveConfirmRouteOptions = { storage: DocumentStorage; scanner: MalwareScanner; provider: DocumentSummaryProvider };

/** Imports per administrator and window: each one validates in a worker, then extracts and stores every document. */
export const ARCHIVE_IMPORT_RATE_LIMIT = { max: 5, timeWindow: 10 * 60_000 };
/** Imports one API instance runs at once (uploading, validating or storing); more are refused, not queued. */
export const ARCHIVE_IMPORT_MAX_IN_FLIGHT = 1;

/** The confirmation's form fields (in any order, before or after the `file` part). */
const FIELDS = ['programId', 'termId', 'code', 'title', 'versionPreference', 'acknowledgeSkipped', 'assignmentDueAt'] as const;
const MAX_FIELDS = 10;
const archiveMb = ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes / (1024 * 1024);

/** Why nothing was imported, as the API's stable problem codes (no storage key, path or stack ever leaves the server). */
function refusal(error: unknown, log: FastifyBaseLogger): ApiProblem {
  if (!(error instanceof ArchiveImportError)) {
    log.error({ err: error }, 'Course archive import failed unexpectedly; nothing was created');
    return new ApiProblem(500, 'ARCHIVE_IMPORT_FAILED', 'The import could not be completed; nothing was created.');
  }
  if (error.orphanedFiles > 0) {
    // Diagnostics only (a count, never keys): the files stay journaled, and storage recovery removes them (AP-040R).
    log.warn({ archiveImport: { problem: error.problem, orphanedFiles: error.orphanedFiles } }, 'Course archive import left unreferenced, journaled files in document storage; storage recovery removes them');
  }
  switch (error.problem) {
    case 'FORBIDDEN':
      return new ApiProblem(403, 'FORBIDDEN', 'Administrator access required.');
    case 'ARCHIVE_INVALID': {
      const first = error.detail.report?.issues.find((issue) => issue.severity === 'error');
      const where = first ? ` (${first.code}${first.path ? `: ${first.path.slice(0, 120)}` : ''})` : '';
      return new ApiProblem(422, 'ARCHIVE_IMPORT_INVALID', `The archive is not a valid AcademiaPath course archive${where}. Preview it to see every problem.`);
    }
    case 'ACKNOWLEDGEMENT_REQUIRED':
      return new ApiProblem(422, 'IMPORT_ACKNOWLEDGEMENT_REQUIRED', error.message);
    case 'DUE_DATE_REQUIRED':
      return new ApiProblem(422, 'IMPORT_DUE_DATE_REQUIRED', error.message);
    case 'PROGRAM_NOT_FOUND':
      return new ApiProblem(422, 'PROGRAM_NOT_FOUND', 'The program does not exist.');
    case 'PROGRAM_INACTIVE':
      return new ApiProblem(422, 'PROGRAM_INACTIVE', 'The program is not active.');
    case 'TERM_NOT_FOUND':
      return new ApiProblem(422, 'TERM_NOT_FOUND', 'The term does not exist.');
    case 'COURSE_CODE_TAKEN':
      return new ApiProblem(409, 'COURSE_CODE_TAKEN', 'A course with this code already exists in the term.');
    case 'DOCUMENT_REJECTED':
      return new ApiProblem(
        422,
        'ARCHIVE_IMPORT_DOCUMENT_REJECTED',
        `A document in the archive was rejected (${error.detail.documentCode ?? 'DOCUMENT_REJECTED'}${error.detail.assetKey ? `, ${error.detail.assetKey}` : ''}); nothing was created.`,
      );
    case 'SCAN_UNAVAILABLE':
      // Strict enforcement (AP-040E): no document could be verified clean, so nothing was imported.
      log.error(
        { archiveImport: { problem: error.problem, assetKey: error.detail.assetKey ?? null } },
        'Course archive import refused: a document could not be scanned for malware (strict enforcement)',
      );
      return new ApiProblem(503, 'ARCHIVE_IMPORT_SCAN_UNAVAILABLE', 'A document in the archive could not be checked for malware right now; nothing was created. Try again later.');
    case 'STORAGE_FAILED':
      return new ApiProblem(503, 'ARCHIVE_IMPORT_STORAGE_FAILED', 'Document storage could not keep the archive’s files; nothing was created. Try again later.');
    case 'IMPORT_FAILED':
      log.error({ err: error.cause }, 'Course archive import failed; nothing was created');
      return new ApiProblem(500, 'ARCHIVE_IMPORT_FAILED', 'The import could not be completed; nothing was created.');
  }
}

/**
 * AP-038C2E: confirms the import of a portable AcademiaPath course archive (AP-038C1C) as a NEW draft course, through
 * the AP-038C2B import engine. Administrators only, and only where `ARCHIVE_IMPORT_ENABLED=true` (off by default and
 * refused in production for now: see docs/course-package-format.md for the remaining blockers).
 *
 * The archive is validated again in full, in the isolated archive worker; no earlier preview or client-supplied data is
 * trusted. Documents are scanned (never marked clean without a scanner), extracted in their worker, stored and read
 * back, then one transaction creates the course; on any failure the stored files are removed again. A repeated or
 * concurrent confirmation cannot create a second course: the new course's code must be free in the term (409).
 */
export const courseArchiveConfirmRoutes: FastifyPluginAsync<ArchiveConfirmRouteOptions> = async (app, { storage, scanner, provider }) => {
  const { db, config } = app;
  // Multipart parsing for this route only: the form fields and exactly one file part of at most 25 MB.
  await app.register(multipart, {
    throwFileSizeLimit: true,
    // A few fields beyond the known ones are tolerated (and ignored), so an unexpected field does not fail the request.
    limits: { fileSize: ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes, files: 1, fields: MAX_FIELDS, parts: MAX_FIELDS + 1, fieldSize: 1024, fieldNameSize: 64, headerPairs: 50 },
  });
  let inFlight = 0;

  // AP-038C2F: whether this server accepts archive imports, so the interface shows an import action only when it does.
  app.get(
    '/course-imports/archive/availability',
    { preValidation: [app.requireAuth, app.requireAdministrator], schema: { response: { 200: archiveImportAvailabilitySchema } } },
    async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      return { enabled: config.archiveImport.enabled };
    },
  );

  app.post(
    '/course-imports/archive',
    {
      // Authentication, CSRF and the administrator check run before the body is read (Origin is checked for every request).
      preValidation: [app.requireAuth, app.requireCsrf, app.requireAdministrator],
      config: {
        rateLimit: { ...ARCHIVE_IMPORT_RATE_LIMIT, hook: 'preHandler', keyGenerator: (request: Parameters<typeof getAuth>[0]) => `archive-import:${getAuth(request).user.id}` },
      },
      schema: { response: { 201: archiveImportResultSchema } },
    },
    async (request, reply) => {
      if (!config.archiveImport.enabled) throw new ApiProblem(403, 'ARCHIVE_IMPORT_DISABLED', 'Importing course archives is not enabled on this server.');
      if (!request.isMultipart()) {
        throw new ApiProblem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the course archive as multipart/form-data with its form fields and a "file" field.');
      }
      if (inFlight >= ARCHIVE_IMPORT_MAX_IN_FLIGHT) {
        reply.header('retry-after', '60');
        throw new ApiProblem(503, 'ARCHIVE_IMPORT_BUSY', 'Another course archive is being imported. Try again in a minute.');
      }
      inFlight += 1;
      try {
        // The whole form is read before anything is decided, so the order of its parts never matters (a field that came
        // after a large file would otherwise depend on network timing). Only the known fields are kept.
        const fields: Record<string, string> = {};
        let bytes: Buffer | null = null;
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            if (part.fieldname !== 'file' || bytes) {
              part.file.resume();
              throw new ApiProblem(400, 'VALIDATION_ERROR', 'Attach exactly one file in the "file" field.');
            }
            if (!/\.zip$/i.test(part.filename ?? '')) {
              part.file.resume();
              throw new ApiProblem(415, 'UNSUPPORTED_FILE_TYPE', 'A course archive must be a .zip file exported by AcademiaPath.');
            }
            // A file cut off at the limit is refused, never imported as if it were complete (AP-SEC-02).
            bytes = await readUploadedFile(part, () => new ApiProblem(413, 'PAYLOAD_TOO_LARGE', `The archive exceeds the ${archiveMb} MB limit.`));
          } else if ((FIELDS as readonly string[]).includes(part.fieldname) && typeof part.value === 'string') {
            fields[part.fieldname] = part.value;
          }
        }
        if (!bytes) throw new ApiProblem(400, 'VALIDATION_ERROR', 'Attach exactly one file in the "file" field.');
        const validate = request.compileValidationSchema(archiveImportFieldsSchema);
        if (!validate(fields)) {
          const where = validate.errors?.[0]?.instancePath?.replace(/^\//, '') || validate.errors?.[0]?.params?.missingProperty || 'form';
          throw new ApiProblem(400, 'VALIDATION_ERROR', `Invalid or missing form field: ${String(where).slice(0, 40)}. Send programId, termId and code with the file.`);
        }

        let result: Awaited<ReturnType<typeof importCourseArchive>>;
        try {
          result = await importCourseArchive(
            {
              db,
              storage,
              scanner,
              scanEnforcement: config.malwareScanning.enforcement,
              provider,
              extract: (file, format) => extractInWorker(file, format, config.documents.extractionTimeoutMs),
              readArchive: (archive) => readCourseArchiveInWorker(archive),
            },
            {
              archive: bytes,
              actor: { userId: getAuth(request).user.id, ip: request.ip },
              programId: fields.programId!,
              termId: fields.termId!,
              code: fields.code!,
              title: fields.title,
              versionPreference: fields.versionPreference as 'approved' | 'working' | undefined,
              acknowledgeSkipped: fields.acknowledgeSkipped === 'true',
              assignmentDueAt: fields.assignmentDueAt,
            },
          );
        } catch (error) {
          throw refusal(error, request.log);
        }
        // Diagnostics only: identifiers and counts, no titles, file names or content.
        request.log.info({ archiveImport: { courseId: result.course.id, ...result.created, skipped: result.skipped.length, bytes: bytes.length } }, 'Course archive imported as a new draft course');
        reply.header('cache-control', 'no-store');
        return reply.code(201).send(result);
      } finally {
        inFlight -= 1;
      }
    },
  );
};
