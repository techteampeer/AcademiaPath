import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { canInCourse, getCourseAccess } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import { inspectCartridgeInWorker } from '../cartridge/inspection.js';
import { CARTRIDGE_LIMITS } from '../cartridge/report.js';
import { ApiProblem } from '../http/errors.js';
import { readUploadedFile } from '../http/uploads.js';
import { cartridgeInspectionReportSchema } from './cartridge-schemas.js';
import { courseIdParamsSchema } from './course-schemas.js';

type Params = { id: string };
/** Inspections per user and window: each one decompresses up to 250 MB in a worker. */
const RATE_LIMIT = { max: 30, timeWindow: 10 * 60_000 };

/**
 * AP-038D: dry-run inspection of an IMS Common Cartridge (.imscc), such as a Canvas course export. Content editors
 * and administrators upload a package and receive a compatibility report. Nothing is written to the database or to
 * storage, nothing is imported, published or executed, and no address in the package is fetched.
 */
export const cartridgeRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  // Multipart parsing is registered for this route only: exactly one file part, at most 25 MB.
  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: { fileSize: CARTRIDGE_LIMITS.maxPackageBytes, files: 1, fields: 1, parts: 2, fieldSize: 1024, fieldNameSize: 64, headerPairs: 50 },
  });

  app.post<{ Params: Params }>(
    '/courses/:id/cartridge-inspections',
    {
      // Authentication and CSRF run before the body is read (Origin is checked for every request).
      preValidation: [app.requireAuth, app.requireCsrf],
      config: {
        rateLimit: { ...RATE_LIMIT, hook: 'preHandler', keyGenerator: (request: Parameters<typeof getAuth>[0]) => `cartridge-inspection:${getAuth(request).user.id}` },
      },
      schema: { params: courseIdParamsSchema, response: { 200: cartridgeInspectionReportSchema } },
    },
    async (request, reply) => {
      const access = await getCourseAccess(db, getAuth(request).user, request.params.id);
      if (!access) throw new ApiProblem(404, 'NOT_FOUND', 'Course not found.');
      if (!canInCourse(access, 'content.edit')) throw new ApiProblem(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
      if (!request.isMultipart()) {
        throw new ApiProblem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload the Common Cartridge as multipart/form-data with a "file" field.');
      }
      const part = await request.file();
      if (!part || part.fieldname !== 'file') {
        part?.file.resume();
        throw new ApiProblem(400, 'VALIDATION_ERROR', 'Attach exactly one file in the "file" field.');
      }
      if (!/\.(imscc|zip)$/i.test(part.filename ?? '')) {
        part.file.resume();
        throw new ApiProblem(415, 'UNSUPPORTED_FILE_TYPE', 'A Common Cartridge must be an .imscc (or .zip) file.');
      }
      // A package cut off at the limit is refused, never inspected as if it were complete (AP-SEC-02).
      const bytes = await readUploadedFile(part, () => new ApiProblem(413, 'PAYLOAD_TOO_LARGE', `The package exceeds the ${CARTRIDGE_LIMITS.maxPackageBytes / (1024 * 1024)} MB inspection limit.`));
      const report = await inspectCartridgeInWorker(bytes, { fileName: part.filename });
      // Diagnostics only: no file name, title or package content.
      request.log.info(
        {
          courseId: access.course.id,
          cartridgeInspection: { status: report.status, format: report.format, version: report.version, canvas: report.canvas.detected, resources: report.counts.resources, errors: report.issues.filter((issue) => issue.severity === 'error').length, bytes: bytes.length },
        },
        'Common Cartridge inspected (dry run)',
      );
      reply.header('cache-control', 'no-store');
      return report;
    },
  );
};
