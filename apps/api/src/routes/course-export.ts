import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import { canInCourse, getCourseAccess, type CourseAccess } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import type { DocumentStorage } from '../documents/storage.js';
import { ApiProblem } from '../http/errors.js';
import { buildCoursePackage, serializePackage } from '../portability/course-package.js';
import { courseParamsSchema } from './grading-schemas.js';

export type CourseExportRouteOptions = { storage: Pick<DocumentStorage, 'exists'> };

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
};
