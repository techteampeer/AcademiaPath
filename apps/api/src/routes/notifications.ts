/**
 * The notification center (AP-026): each person reads and marks only their own notifications, and only those
 * the shared visibility rule allows now (not withdrawn, available, course access still current).
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { getAuth } from '../auth/hooks.js';
import { courses, notifications } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';
import { notificationLink, visibleTo } from '../messaging/notify.js';
import { notificationListQuerySchema, notificationPageSchema, notificationParamsSchema, readAllResultSchema } from './messaging-schemas.js';

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const authenticated = { preValidation: [app.requireAuth] };
  const authenticatedWrite = { preValidation: [app.requireAuth, app.requireCsrf] };

  app.get<{ Querystring: { limit: number; cursor?: string; unread: boolean } }>(
    '/me/notifications',
    { ...authenticated, schema: { querystring: notificationListQuerySchema, response: { 200: notificationPageSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      const { limit, unread } = request.query;
      const cursor = decodeCursor(request.query.cursor, 'string');
      const rows = await db
        .select({ notification: notifications, eventKey: sql<string>`${notifications.eventAt}::text`, course: { id: courses.id, title: courses.title, code: courses.code } })
        .from(notifications)
        .leftJoin(courses, eq(courses.id, notifications.courseId))
        .where(
          and(
            visibleTo(user.id, app.now()),
            unread ? isNull(notifications.readAt) : undefined,
            cursor ? sql`(${notifications.eventAt}, ${notifications.id}) < (${cursor.key}::timestamptz, ${cursor.id}::uuid)` : undefined,
          ),
        )
        .orderBy(desc(notifications.eventAt), desc(notifications.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(({ notification: n, course }) => ({
          id: n.id,
          type: n.type,
          course: course?.id ? course : null,
          data: n.data,
          link: notificationLink(n),
          eventAt: n.eventAt,
          read: n.readAt !== null,
        })),
        nextCursor: rows.length > limit && last ? encodeCursor(last.eventKey, last.notification.id) : null,
      };
    },
  );

  app.put<{ Params: { notificationId: string } }>(
    '/me/notifications/:notificationId/read',
    { ...authenticatedWrite, schema: { params: notificationParamsSchema } },
    async (request, reply) => {
      const { user } = getAuth(request);
      const updated = await db
        .update(notifications)
        .set({ readAt: sql`coalesce(${notifications.readAt}, ${app.now().toISOString()}::timestamptz)` })
        .where(and(eq(notifications.id, request.params.notificationId), visibleTo(user.id, app.now())))
        .returning({ id: notifications.id });
      // Someone else's notification, or one no longer visible, is simply "not found".
      if (!updated.length) throw new ApiProblem(404, 'NOT_FOUND', 'Notification not found.');
      return reply.code(204).send();
    },
  );

  app.post('/me/notifications/read-all', { ...authenticatedWrite, schema: { response: { 200: readAllResultSchema } } }, async (request) => {
    const { user } = getAuth(request);
    const updated = await db
      .update(notifications)
      .set({ readAt: app.now() })
      .where(and(visibleTo(user.id, app.now()), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return { updated: updated.length };
  });
};
