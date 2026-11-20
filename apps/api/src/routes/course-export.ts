import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import { canInCourse, getCourseAccess, type CourseAccess } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import type { DocumentStorage } from '../documents/storage.js';
import { ApiProblem } from '../http/errors.js';
import { ARCHIVE_FORMAT_VERSION, ARCHIVE_MAX_BYTES, buildCourseArchive, CourseArchiveError } from '../portability/course-archive.js';
import { buildCoursePackage, serializePackage } from '../portability/course-package.js';
import { courseParamsSchema } from './grading-schemas.js';

export type CourseExportRouteOptions = { storage: Pick<DocumentStorage, 'exists' | 'read'> };

/**
 * AP-038C1D archive export limits. Both are per API instance (Cloud Run may run several): they bound this process's
 * memory, not the service as a whole. An archive holds up to ARCHIVE_MAX_BYTES of files in memory twice while it is
 * written, so two at a time stay near 100 MB on the 1 GiB instance. A busy instance answers 503 instead of queueing.
 */
export const ARCHIVE_EXPORT_MAX_CONCURRENT = 2;
export const ARCHIVE_EXPORT_RATE_LIMIT = { max: 10, timeWindow: 10 * 60_000 };

const archiveMb = ARCHIVE_MAX_BYTES / (1024 * 1024);
const archiveProblem = (error: CourseArchiveError) => {
  switch (error.problem) {
    case 'ARCHIVE_TOO_LARGE':
      return new ApiProblem(422, 'COURSE_ARCHIVE_TOO_LARGE', `This course's archive with its documents would exceed ${archiveMb} MB. The JSON export is still available.`);
    case 'ASSET_MISSING':
      return new ApiProblem(500, 'COURSE_ARCHIVE_DOCUMENT_MISSING', 'A document file of this course is missing from storage, so no archive was created. Contact an administrator.');
    case 'ASSET_CORRUPT':
      return new ApiProblem(500, 'COURSE_ARCHIVE_DOCUMENT_CORRUPT', 'A document file of this course failed its integrity check, so no archive was created. Contact an administrator.');
    case 'STORAGE_UNAVAILABLE':
      return new ApiProblem(503, 'DOCUMENT_STORAGE_UNAVAILABLE', 'Document storage is temporarily unavailable. Try again later or contact an administrator.');
    default:
      // ASSET_INVALID: an internal inconsistency; the generic error handler answers without details.
      return error;
  }
};

/**
 * AP-038A: download one course's content package (JSON). Read-only: nothing in the course changes; the export itself
 * is audited with counts only. See `portability/course-package.ts` and docs/course-package-format.md.
 */
export const courseExportRoutes: FastifyPluginAsync<CourseExportRouteOptions> = async (app, { storage }) => {
  const { db } = app;
  const authenticated = { preValidation: [app.requireAuth] };

  async function courseAccess(request: FastifyRequest, courseId: string): Promise<CourseAccess> {
    const access = await getCourseAccess(db, getAuth(request).user, courseId);
    if (!access) throw new ApiProblem(404, 'NOT_FOUND', 'Course not found.');
    return access;
  }

  app.get<{ Params: { id: string } }>(
    '/courses/:id/export',
    { ...authenticated, schema: { params: courseParamsSchema } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      if (!canInCourse(access, 'content.export')) {
        throw new ApiProblem(403, 'FORBIDDEN', 'Only the course authors (design team and instructors) and administrators can export course content.');
      }
      // One consistent snapshot of the course, even while staff keep editing.
      const packaged = await db.transaction((tx) => buildCoursePackage(tx, access.course.id, storage, app.now()), { isolationLevel: 'repeatable read', accessMode: 'read only' });
      const json = serializePackage(packaged);
      await recordAudit(db, request, {
        action: 'course.exported',
        entityType: 'course',
        entityId: access.course.id,
        before: null,
        after: { formatVersion: packaged.formatVersion, contentHash: packaged.contentHash, ...packaged.counts, warnings: packaged.warnings.length },
      });
      const safeCode = access.course.code.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="course-${safeCode}.academiapath.json"`)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(json);
    },
  );

  /**
   * AP-038C1D: the course as a portable ZIP (course.json exactly as above, its document files, a manifest with sizes
   * and SHA-256 hashes; see portability/course-archive.ts). Same permission as the JSON export. The archive is built
   * completely in memory and verified before anything is sent: any failure is a problem response, never a partial
   * file. Audited with counts only (no storage keys, file names or content).
   */
  let activeArchives = 0;
  app.get<{ Params: { id: string } }>(
    '/courses/:id/export/archive',
    {
      ...authenticated,
      schema: { params: courseParamsSchema },
      config: {
        rateLimit: { ...ARCHIVE_EXPORT_RATE_LIMIT, hook: 'preHandler', keyGenerator: (request: FastifyRequest) => `course-archive:${getAuth(request).user.id}` },
      },
    },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      if (!canInCourse(access, 'content.export')) {
        throw new ApiProblem(403, 'FORBIDDEN', 'Only the course authors (design team and instructors) and administrators can export course content.');
      }
      if (activeArchives >= ARCHIVE_EXPORT_MAX_CONCURRENT) {
        reply.header('retry-after', '30');
        throw new ApiProblem(503, 'COURSE_ARCHIVE_BUSY', 'Other course archives are being prepared. Try again in a minute.');
      }
      activeArchives += 1;
      let built: Awaited<ReturnType<typeof buildCourseArchive>>;
      try {
        built = await buildCourseArchive(db, access.course.id, storage, app.now());
      } catch (error) {
        if (!(error instanceof CourseArchiveError)) throw error;
        // Diagnostics name the course and the package-local asset key only, never a storage key or path.
        request.log.error({ courseId: access.course.id, problem: error.problem, assetKey: error.assetKey }, 'Course archive was not created');
        throw archiveProblem(error);
      } finally {
        activeArchives -= 1;
      }
      const { archive, manifest, packaged } = built;
      await recordAudit(db, request, {
        action: 'course.archive_exported',
        entityType: 'course',
        entityId: access.course.id,
        before: null,
        after: {
          archiveFormatVersion: ARCHIVE_FORMAT_VERSION,
          formatVersion: packaged.formatVersion,
          contentHash: packaged.contentHash,
          ...packaged.counts,
          assetBytes: manifest.totals.assetBytes,
          archiveBytes: archive.length,
          warnings: packaged.warnings.length,
        },
      });
      const safeCode = access.course.code.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="course-${safeCode}.academiapath.zip"`)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(archive);
    },
  );
};
