import { and, asc, eq, inArray, isNotNull, max, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import { canInCourse, getCourseAccess, type CourseAccess, type CoursePermission } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import { normalizeSafeHttpUrl } from '../content/urls.js';
import type { Database } from '../db/client.js';
import { activities, sections, type ActivityConfig } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';
import { decodeCursor, paginationQuerySchema, toPage, type PaginationQuery } from '../http/pagination.js';
import {
  activityCreateSchema,
  activityReviewSchema,
  activitySchema,
  activityUpdateSchema,
  CONTENT_TYPES,
  courseActivityParamsSchema,
  courseSectionParamsSchema,
  type ContentType,
} from './activity-schemas.js';
import { pageSchema } from './course-schemas.js';

type SectionParams = { id: string; sectionId: string };
type ActivityParams = { id: string; activityId: string };
type PageInput = { title: string; body: string };
type LinkInput = { title: string; url: string; description?: string };
type CreateBody = ({ type: 'page' } & PageInput) | ({ type: 'link' } & LinkInput);
type UpdateBody = PageInput | LinkInput;
type ReviewBody = { decision: 'approve' | 'return'; comment?: string };

type ActivityRecord = typeof activities.$inferSelect;
type Executor = Pick<Database, 'select' | 'insert' | 'update'>;

const notFound = (what: string) => new ApiProblem(404, 'NOT_FOUND', `${what} not found.`);
const forbidden = () => new ApiProblem(403, 'FORBIDDEN', 'You do not have permission to perform this action.');

/** Validated, type-specific content stored in `config`. Lesson text is stored as plain text. */
function buildContent(type: ContentType, input: UpdateBody): ActivityConfig {
  const isPage = 'body' in input;
  if ((type === 'page') !== isPage) {
    throw new ApiProblem(422, 'CONTENT_TYPE_MISMATCH', `The request body does not match this ${type} activity.`);
  }
  if ('body' in input) return { body: input.body };
  const url = normalizeSafeHttpUrl(input.url);
  if (!url) {
    throw new ApiProblem(422, 'INVALID_URL', 'Only absolute http or https URLs without embedded credentials are allowed.');
  }
  return { url, description: input.description?.trim() || null };
}

/**
 * Staff see the working copy plus review metadata and the live (approved) version.
 * Students only ever see the approved live version, without review metadata.
 */
function toResponse(row: ActivityRecord, courseId: string, staffView: boolean) {
  const base = {
    id: row.id,
    courseId,
    sectionId: row.sectionId,
    type: row.type,
    position: row.position,
    isVisible: row.isVisible,
    createdAt: row.createdAt,
  };
  if (!staffView) {
    return { ...base, title: row.approvedTitle, content: row.approvedConfig, review: null, liveVersion: null, updatedAt: row.approvedAt };
  }
  return {
    ...base,
    title: row.title,
    content: row.config,
    review: {
      status: row.reviewStatus,
      comment: row.reviewComment,
      submittedAt: row.submittedAt,
      submittedByUserId: row.submittedByUserId,
      reviewedAt: row.reviewedAt,
      reviewedByUserId: row.reviewedByUserId,
    },
    liveVersion:
      row.approvedConfig && row.approvedTitle && row.approvedAt
        ? { title: row.approvedTitle, content: row.approvedConfig, approvedAt: row.approvedAt }
        : null,
    updatedAt: row.updatedAt,
  };
}

const snapshot = (row: ActivityRecord) => ({ title: row.title, content: row.config, reviewStatus: row.reviewStatus });

export const activityRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  // Guards run before body/params validation so unauthenticated or forged requests are rejected first.
  const authenticated = { preValidation: [app.requireAuth] };
  const authenticatedWrite = { preValidation: [app.requireAuth, app.requireCsrf] };

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  /** Default deny: 404 unless the caller may see the course (cross-course access is impossible). */
  async function courseAccess(request: FastifyRequest, courseId: string): Promise<CourseAccess> {
    const access = await getCourseAccess(db, getAuth(request).user, courseId);
    if (!access) throw notFound('Course');
    return access;
  }

  function requirePermission(access: CourseAccess, permission: CoursePermission) {
    if (!canInCourse(access, permission)) throw forbidden();
  }

  /** Loads an activity of this course (row-locked inside transactions). Students only reach approved, visible content. */
  async function findActivity(executor: Executor, access: CourseAccess, activityId: string, lock: boolean) {
    const query = executor
      .select({ activity: activities, sectionVisible: sections.isVisible })
      .from(activities)
      .innerJoin(sections, eq(sections.id, activities.sectionId))
      .where(and(eq(activities.id, activityId), eq(sections.courseId, access.course.id), inArray(activities.type, CONTENT_TYPES)))
      .limit(1);
    const [row] = lock ? await query.for('update', { of: activities }) : await query;
    if (!row) throw notFound('Activity');
    if (!canInCourse(access, 'content.viewUnapproved')) {
      const readable = row.sectionVisible && row.activity.isVisible && row.activity.approvedConfig !== null;
      if (!readable) throw notFound('Activity');
    }
    return row.activity;
  }

  app.get<{ Params: SectionParams; Querystring: PaginationQuery }>(
    '/courses/:id/sections/:sectionId/activities',
    {
      ...authenticated,
      schema: {
        params: courseSectionParamsSchema,
        querystring: paginationQuerySchema,
        response: { 200: pageSchema(activitySchema) },
      },
    },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      const staffView = canInCourse(access, 'content.viewUnapproved');
      const [section] = await db
        .select()
        .from(sections)
        .where(and(eq(sections.id, request.params.sectionId), eq(sections.courseId, access.course.id)));
      if (!section || (!section.isVisible && !canInCourse(access, 'sections.viewHidden'))) throw notFound('Section');

      const { limit } = request.query;
      const after = decodeCursor(request.query.cursor, 'number');
      const rows = await db
        .select()
        .from(activities)
        .where(
          and(
            eq(activities.sectionId, section.id),
            inArray(activities.type, CONTENT_TYPES),
            staffView ? undefined : and(isNotNull(activities.approvedConfig), eq(activities.isVisible, true)),
            after ? sql`(${activities.position}, ${activities.id}) > (${after.key}::int, ${after.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(activities.position), asc(activities.id))
        .limit(limit + 1);
      const page = toPage(rows, limit, (row) => [row.position, row.id]);
      return { items: page.items.map((row) => toResponse(row, access.course.id, staffView)), nextCursor: page.nextCursor };
    },
  );

  app.post<{ Params: SectionParams; Body: CreateBody }>(
    '/courses/:id/sections/:sectionId/activities',
    { ...authenticatedWrite, schema: { params: courseSectionParamsSchema, body: activityCreateSchema, response: { 201: activitySchema } } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'content.edit');
      const { type, ...input } = request.body;
      const config = buildContent(type, input);

      const created = await db.transaction(async (tx) => {
        // Lock the section so concurrent additions get distinct positions.
        const [section] = await tx
          .select({ id: sections.id })
          .from(sections)
          .where(and(eq(sections.id, request.params.sectionId), eq(sections.courseId, access.course.id)))
          .for('update');
        if (!section) throw notFound('Section');
        const [{ last } = { last: null }] = await tx
          .select({ last: max(activities.position) })
          .from(activities)
          .where(eq(activities.sectionId, section.id));
        const [row] = await tx
          .insert(activities)
          .values({ sectionId: section.id, type, title: input.title.trim(), config, position: (last ?? -1) + 1, reviewStatus: 'draft' })
          .returning();
        if (!row) throw new Error('Activity was not created');
        await recordAudit(tx, request, {
          action: 'activity.created',
          entityType: 'activity',
          entityId: row.id,
          before: null,
          after: { courseId: access.course.id, sectionId: section.id, type, ...snapshot(row) },
        });
        return row;
      });
      return reply.code(201).send(toResponse(created, access.course.id, true));
    },
  );

  app.get<{ Params: ActivityParams }>(
    '/courses/:id/activities/:activityId',
    { ...authenticated, schema: { params: courseActivityParamsSchema, response: { 200: activitySchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      const row = await findActivity(db, access, request.params.activityId, false);
      return toResponse(row, access.course.id, canInCourse(access, 'content.viewUnapproved'));
    },
  );

  app.put<{ Params: ActivityParams; Body: UpdateBody }>(
    '/courses/:id/activities/:activityId',
    { ...authenticatedWrite, schema: { params: courseActivityParamsSchema, body: activityUpdateSchema, response: { 200: activitySchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'content.edit');

      const updated = await db.transaction(async (tx) => {
        const current = await findActivity(tx, access, request.params.activityId, true);
        if (current.reviewStatus === 'submitted') {
          throw new ApiProblem(409, 'ACTIVITY_UNDER_REVIEW', 'Content that is waiting for review cannot be edited.');
        }
        const config = buildContent(current.type as ContentType, request.body);
        // Editing approved content starts a new draft revision; the approved live version is untouched.
        const reviewStatus = current.reviewStatus === 'returned' ? 'returned' : 'draft';
        const [row] = await tx
          .update(activities)
          .set({ title: request.body.title.trim(), config, reviewStatus })
          .where(eq(activities.id, current.id))
          .returning();
        if (!row) throw new Error('Activity was not updated');
        await recordAudit(tx, request, {
          action: 'activity.updated',
          entityType: 'activity',
          entityId: row.id,
          before: snapshot(current),
          after: snapshot(row),
        });
        return row;
      });
      return toResponse(updated, access.course.id, true);
    },
  );

  app.post<{ Params: ActivityParams }>(
    '/courses/:id/activities/:activityId/submit',
    { ...authenticatedWrite, schema: { params: courseActivityParamsSchema, response: { 200: activitySchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'content.submit');
      const { user } = getAuth(request);

      const submitted = await db.transaction(async (tx) => {
        const current = await findActivity(tx, access, request.params.activityId, true);
        if (current.reviewStatus !== 'draft' && current.reviewStatus !== 'returned') {
          throw new ApiProblem(409, 'INVALID_REVIEW_STATE', `Only draft or returned content can be submitted (current status: ${current.reviewStatus}).`);
        }
        const [row] = await tx
          .update(activities)
          .set({ reviewStatus: 'submitted', submittedAt: sql`now()`, submittedByUserId: user.id })
          .where(eq(activities.id, current.id))
          .returning();
        if (!row) throw new Error('Activity was not submitted');
        await recordAudit(tx, request, {
          action: 'activity.submitted',
          entityType: 'activity',
          entityId: row.id,
          before: { reviewStatus: current.reviewStatus },
          after: { reviewStatus: row.reviewStatus, title: row.title, content: row.config },
        });
        return row;
      });
      return toResponse(submitted, access.course.id, true);
    },
  );

  app.post<{ Params: ActivityParams; Body: ReviewBody }>(
    '/courses/:id/activities/:activityId/review',
    { ...authenticatedWrite, schema: { params: courseActivityParamsSchema, body: activityReviewSchema, response: { 200: activitySchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'content.review');
      const { user } = getAuth(request);
      const { decision } = request.body;
      const comment = request.body.comment?.trim() || null;
      if (decision === 'return' && !comment) {
        throw new ApiProblem(422, 'REVIEW_COMMENT_REQUIRED', 'Explain what needs to change when returning content.');
      }

      const reviewed = await db.transaction(async (tx) => {
        const current = await findActivity(tx, access, request.params.activityId, true);
        if (current.reviewStatus !== 'submitted') {
          throw new ApiProblem(409, 'INVALID_REVIEW_STATE', `Only submitted content can be reviewed (current status: ${current.reviewStatus}).`);
        }
        if (decision === 'approve' && current.submittedByUserId === user.id) {
          throw new ApiProblem(403, 'SELF_REVIEW_NOT_ALLOWED', 'Content must be approved by someone other than the person who submitted it.');
        }
        const reviewFields = { reviewComment: comment, reviewedAt: sql`now()`, reviewedByUserId: user.id };
        const [row] = await tx
          .update(activities)
          .set(
            decision === 'approve'
              ? {
                  ...reviewFields,
                  reviewStatus: 'approved' as const,
                  // Publish exactly what was reviewed (editing is blocked while submitted).
                  approvedTitle: current.title,
                  approvedConfig: current.config,
                  approvedAt: sql`now()`,
                  approvedByUserId: user.id,
                }
              : { ...reviewFields, reviewStatus: 'returned' as const },
          )
          .where(eq(activities.id, current.id))
          .returning();
        if (!row) throw new Error('Review was not recorded');
        await recordAudit(tx, request, {
          action: decision === 'approve' ? 'activity.approved' : 'activity.returned',
          entityType: 'activity',
          entityId: row.id,
          before: {
            reviewStatus: current.reviewStatus,
            liveVersion: current.approvedTitle ? { title: current.approvedTitle, content: current.approvedConfig } : null,
          },
          after: {
            reviewStatus: row.reviewStatus,
            comment,
            liveVersion: row.approvedTitle ? { title: row.approvedTitle, content: row.approvedConfig } : null,
          },
        });
        return row;
      });
      return toResponse(reviewed, access.course.id, true);
    },
  );
};
