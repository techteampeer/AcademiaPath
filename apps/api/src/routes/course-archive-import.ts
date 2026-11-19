import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { getAuth } from '../auth/hooks.js';
import { ApiProblem } from '../http/errors.js';
import { validateCourseArchiveInWorker } from '../portability/archive-preview.js';
import { ARCHIVE_VALIDATION_LIMITS } from '../portability/archive-validation.js';
import { archivePreviewReportSchema } from './course-archive-import-schemas.js';

/** Previews per administrator and window: each one decompresses up to 45 MB in a worker. */
export const ARCHIVE_PREVIEW_RATE_LIMIT = { max: 10, timeWindow: 10 * 60_000 };
/** Previews held by one API instance at once (uploading, waiting for a worker or validating); more are refused, not queued. */
export const ARCHIVE_PREVIEW_MAX_IN_FLIGHT = 2;

const archiveMb = ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes / (1024 * 1024);

/**
 * AP-038C2C: validation and import preview of a portable AcademiaPath course archive (the ZIP of AP-038C1C), for
 * administrators, who are the only role that can import a course. A read-only dry run: the archive is validated in an
 * isolated worker and only its report is returned. Nothing is written to the database or to document storage, no
 * course is created, nothing in the archive is executed and no address in it is fetched. Only the uploaded bytes are
 * trusted as input: any other form field (a client-made "preview", for example) is ignored.
 */
export const courseArchiveImportRoutes: FastifyPluginAsync = async (app) => {
  // Multipart parsing is registered for this plugin only (the JSON import routes are unchanged): one file, 25 MB.
  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: { fileSize: ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes, files: 1, fields: 1, parts: 2, fieldSize: 1024, fieldNameSize: 64, headerPairs: 50 },
  });
  let inFlight = 0;

  app.post(
    '/course-imports/archive/preview',
    {
      // Authentication, CSRF and the administrator check run before the body is read (Origin is checked for every request).
      preValidation: [app.requireAuth, app.requireCsrf, app.requireAdministrator],
      config: {
        rateLimit: { ...ARCHIVE_PREVIEW_RATE_LIMIT, hook: 'preHandler', keyGenerator: (request: Parameters<typeof getAuth>[0]) => `archive-preview:${getAuth(request).user.id}` },
      },
      schema: { response: { 200: archivePreviewReportSchema } },
    },
    async (request, reply) => {
      if (!request.isMultipart()) {
        throw new ApiProblem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload the course archive as multipart/form-data with a "file" field.');
      }
      if (inFlight >= ARCHIVE_PREVIEW_MAX_IN_FLIGHT) {
        reply.header('retry-after', '30');
        throw new ApiProblem(503, 'ARCHIVE_PREVIEW_BUSY', 'Other course archives are being checked. Try again in a minute.');
      }
      inFlight += 1;
      try {
        const part = await request.file();
        if (!part || part.fieldname !== 'file') {
          part?.file.resume();
          throw new ApiProblem(400, 'VALIDATION_ERROR', 'Attach exactly one file in the "file" field.');
        }
        if (!/\.zip$/i.test(part.filename ?? '')) {
          part.file.resume();
          throw new ApiProblem(415, 'UNSUPPORTED_FILE_TYPE', 'A course archive must be a .zip file exported by AcademiaPath.');
        }
        let bytes: Buffer;
        try {
          bytes = await part.toBuffer();
        } catch (error) {
          if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
            throw new ApiProblem(413, 'PAYLOAD_TOO_LARGE', `The archive exceeds the ${archiveMb} MB limit.`);
          }
          throw error;
        }
        const report = await validateCourseArchiveInWorker(bytes);
        // Diagnostics only: no file name, title, entry name or archive content.
        request.log.info(
          {
            archivePreview: {
              status: report.status,
              formatVersion: report.manifest.formatVersion,
              entries: report.archive.entries,
              documents: report.preview?.documents.length ?? 0,
              errors: report.issues.filter((issue) => issue.severity === 'error').length,
              codes: [...new Set(report.issues.map((issue) => issue.code))].slice(0, 10),
              bytes: bytes.length,
            },
          },
          'Course archive previewed (dry run)',
        );
        reply.header('cache-control', 'no-store');
        return report;
      } finally {
        inFlight -= 1;
      }
    },
  );
};
