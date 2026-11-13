import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { canInCourse, getCourseAccess, type CourseAccess } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import { ApiProblem } from '../http/errors.js';
import { buildQualityReport } from '../quality/report.js';
import { courseActivityParamsSchema } from './activity-schemas.js';
import { findActivity } from './activities.js';
import { qualityCourseParamsSchema, qualityReportSchema } from './quality-schemas.js';

/**
 * AP-029 content quality reports. Read-only and computed on demand from the working copies. Only people who may
 * author content (`content.edit`: instructors, the design team, administrators) or review it (`content.review`:
 * the design team, administrators) can read them; non-editing instructors and students get 403, anyone outside
 * the course 404 (the course's existence is not revealed).
 */
export const qualityRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const authenticated = { preValidation: [app.requireAuth] };

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  async function qualityAccess(request: FastifyRequest, courseId: string): Promise<CourseAccess> {
    const access = await getCourseAccess(db, getAuth(request).user, courseId);
    if (!access) throw new ApiProblem(404, 'NOT_FOUND', 'Course not found.');
    if (!canInCourse(access, 'content.edit') && !canInCourse(access, 'content.review')) {
      throw new ApiProblem(403, 'FORBIDDEN', 'Only course authors and reviewers can check content quality.');
    }
    return access;
  }

  app.get<{ Params: { id: string } }>(
    '/courses/:id/quality',
    { ...authenticated, schema: { params: qualityCourseParamsSchema, response: { 200: qualityReportSchema } } },
    async (request) => {
      const access = await qualityAccess(request, request.params.id);
      return buildQualityReport(db, access, app.now());
    },
  );

  app.get<{ Params: { id: string; activityId: string } }>(
    '/courses/:id/activities/:activityId/quality',
    { ...authenticated, schema: { params: courseActivityParamsSchema, response: { 200: qualityReportSchema } } },
    async (request) => {
      const access = await qualityAccess(request, request.params.id);
      // 404 for activities outside this course (and for non-content types), exactly as the activity endpoint.
      await findActivity(db, access, request.params.activityId, false);
      return buildQualityReport(db, access, app.now(), request.params.activityId);
    },
  );
};
