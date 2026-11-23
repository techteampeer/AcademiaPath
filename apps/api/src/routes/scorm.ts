import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { canInCourse, getCourseAccess } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import { ApiProblem } from '../http/errors.js';
import { readUploadedFile } from '../http/uploads.js';
import { inspectInWorker } from '../scorm/inspection.js';
import { SCORM_LIMITS } from '../scorm/limits.js';
import { courseIdParamsSchema } from './course-schemas.js';
import { scormInspectionReportSchema } from './scorm-schemas.js';

type Params = { id: string };

/** Inspections per user and window: each one decompresses up to 250 MB in a worker. */
const RATE_LIMIT = { max: 30, timeWindow: 10 * 60_000 };

/**
 * AP-033B: dry-run SCORM package inspection. Content editors and administrators upload a .zip and receive a
 * structural report. Nothing is written to the database or to storage, no activity is created, nothing is published
 * or launched, and the package's content is never executed.
 */
export const scormRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  // Multipart parsing is registered for this route only: exactly one file part, at most 25 MB.
  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: { fileSize: SCORM_LIMITS.maxPackageBytes, files: 1, fields: 1, parts: 2, fieldSize: 1024, fieldNameSize: 64, headerPairs: 50 },
  });

  app.post<{ Params: Params }>(
    '/courses/:id/scorm-inspections',
    {
      // Authentication and CSRF run before the body is read (Origin is checked for every request).
      preValidation: [app.requireAuth, app.requireCsrf],
      config: {
        rateLimit: { ...RATE_LIMIT, hook: 'preHandler', keyGenerator: (request: Parameters<typeof getAuth>[0]) => `scorm-inspection:${getAuth(request).user.id}` },
      },
      schema: { params: courseIdParamsSchema, response: { 200: scormInspectionReportSchema } },
    },
    async (request, reply) => {
      const access = await getCourseAccess(db, getAuth(request).user, request.params.id);
      if (!access) throw new ApiProblem(404, 'NOT_FOUND', 'Course not found.');
      if (!canInCourse(access, 'content.edit')) throw new ApiProblem(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
      if (!request.isMultipart()) {
        throw new ApiProblem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload the SCORM package as multipart/form-data with a "file" field.');
      }
      const part = await request.file();
      if (!part || part.fieldname !== 'file') {
        part?.file.resume();
        throw new ApiProblem(400, 'VALIDATION_ERROR', 'Attach exactly one file in the "file" field.');
      }
      if (!/\.zip$/i.test(part.filename ?? '')) {
        part.file.resume();
        throw new ApiProblem(415, 'UNSUPPORTED_FILE_TYPE', 'A SCORM package must be a .zip file.');
      }
      // A package cut off at the limit is refused, never inspected as if it were complete (AP-SEC-02).
      const bytes = await readUploadedFile(part, () => new ApiProblem(413, 'PAYLOAD_TOO_LARGE', `The package exceeds the ${SCORM_LIMITS.maxPackageBytes / (1024 * 1024)} MB inspection limit.`));

      const report = await inspectInWorker(bytes, { fileName: part.filename });
      // Diagnostics only: no file name, title or package content.
      request.log.info(
        {
          courseId: access.course.id,
          scormInspection: { status: report.status, version: report.standard.version, format: report.standard.format, errors: report.issues.filter((issue) => issue.severity === 'error').length, bytes: bytes.length },
        },
        'SCORM package inspected (dry run)',
      );
      reply.header('cache-control', 'no-store');
      return report;
    },
  );
};
