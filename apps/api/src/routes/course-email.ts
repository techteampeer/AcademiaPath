/**
 * Course e-mail composition (AP-044). Instructors (and administrators) get the BCC list of the course's active
 * students to write one e-mail in their own e-mail application. Nothing is sent, queued or tracked here: the web
 * app only opens the user's e-mail application. Every listing is audited with counts only (never addresses), and
 * addresses are never logged. Unknown or unrelated courses answer 404; other course roles answer 403.
 */
import type { FastifyPluginAsync } from 'fastify';
import { recordAudit } from '../audit.js';
import { canInCourse, getCourseAccess } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import { ApiProblem } from '../http/errors.js';
import { loadEmailRecipients } from '../messaging/email-recipients.js';
import { courseEmailRecipientsSchema } from './course-email-schemas.js';
import { courseParamsSchema } from './grading-schemas.js';

export const courseEmailRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  app.get<{ Params: { id: string } }>(
    '/courses/:id/email-recipients',
    { preValidation: [app.requireAuth], schema: { params: courseParamsSchema, response: { 200: courseEmailRecipientsSchema } } },
    async (request, reply) => {
      const access = await getCourseAccess(db, getAuth(request).user, request.params.id);
      if (!access) throw new ApiProblem(404, 'NOT_FOUND', 'Course not found.');
      if (!canInCourse(access, 'students.email')) {
        throw new ApiProblem(403, 'FORBIDDEN', 'Only instructors of this course and administrators can e-mail its students.');
      }
      const list = await loadEmailRecipients(db, access.course.id);
      await recordAudit(db, request, {
        action: 'course.email_recipients_listed',
        entityType: 'course',
        entityId: access.course.id,
        before: null,
        after: { recipients: list.recipients.length, ...list.excluded },
      });
      reply.header('cache-control', 'no-store');
      return {
        course: { id: access.course.id, code: access.course.code, title: access.course.title },
        recipientCount: list.recipients.length,
        recipients: list.recipients,
        excluded: list.excluded,
      };
    },
  );
};
