import { and, asc, count, eq, inArray, isNotNull, max, sql, sum } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import { canInCourse, getCourseAccess, type CourseAccess, type CoursePermission } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import { normalizeResourceUrl, RESOURCE_KINDS, type ResourceKind } from '../content/urls.js';
import type { Database } from '../db/client.js';
import { activities, quizQuestions, resourceFolders, sections, type ActivityConfig } from '../db/schema/index.js';
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
import { readSettings, readSnapshotQuestions, settingsFromInput, type QuizSettingsInput, type QuizSnapshot } from '../quizzes/model.js';
import { assignmentFromInput, readAssignment, rubricTotal, type AssignmentInput } from '../assignments/model.js';
import { presentDocumentContent } from '../documents/model.js';
import { assertSectionOpen } from '../progress/model.js';

type SectionParams = { id: string; sectionId: string };
type ActivityParams = { id: string; activityId: string };
type PageInput = { title: string; body: string };
type LinkInput = { title: string; url: string; description?: string; kind?: ResourceKind };
type CreateBody =
  | ({ type: 'page'; folderId?: string } & PageInput)
  | ({ type: 'link'; folderId?: string } & LinkInput)
  | ({ type: 'quiz' } & QuizSettingsInput)
  | ({ type: 'assignment' } & AssignmentInput);
type UpdateBody = PageInput | LinkInput | QuizSettingsInput | AssignmentInput;
type QuizStats = { questionCount: number; totalPoints: number };
type ReviewBody = { decision: 'approve' | 'return'; comment?: string };

type ActivityRecord = typeof activities.$inferSelect;
type Executor = Pick<Database, 'select' | 'insert' | 'update'>;

const notFound = (what: string) => new ApiProblem(404, 'NOT_FOUND', `${what} not found.`);
const forbidden = () => new ApiProblem(403, 'FORBIDDEN', 'You do not have permission to perform this action.');

/** Validated, type-specific content stored in `config`. Lesson text is stored as plain text. */
function buildContent(type: ContentType, input: UpdateBody): ActivityConfig {
  const kind: ContentType = 'body' in input ? 'page' : 'url' in input ? 'link' : 'rubric' in input ? 'assignment' : 'quiz';
  if (kind !== type) {
    throw new ApiProblem(422, 'CONTENT_TYPE_MISMATCH', `The request body does not match this ${type} activity.`);
  }
  if ('body' in input) return { body: input.body };
  if ('rubric' in input) return assignmentFromInput(input);
  if (!('url' in input)) return settingsFromInput(input);
  // AP-021: new and edited resources must use https on a registered domain (stored links stay readable).
  const url = normalizeResourceUrl(input.url);
  if (!url) {
    throw new ApiProblem(422, 'INVALID_URL', 'Only https URLs on a domain name, without embedded credentials, are allowed.');
  }
  return { url, description: input.description?.trim() || null, kind: input.kind ?? 'website' };
}

const readKind = (config: ActivityConfig): ResourceKind =>
  (RESOURCE_KINDS as readonly string[]).includes(String(config.kind)) ? (config.kind as ResourceKind) : 'website';

const snapshotStats = (config: ActivityConfig | null): QuizStats => {
  const questions = readSnapshotQuestions(config);
  return { questionCount: questions.length, totalPoints: questions.reduce((total, q) => total + q.points, 0) };
};

/**
 * Content as exposed by the API. Quizzes expose only settings and totals, never questions or answer keys.
 * Documents expose only their file name, format and summary revision.
 */
function presentContent(type: ActivityRecord['type'], config: ActivityConfig | null, stats: QuizStats): ActivityConfig | null {
  if (type === 'file') return presentDocumentContent(config);
  if (type === 'assignment') {
    const assignment = readAssignment(config);
    return { ...assignment, totalPoints: rubricTotal(assignment.rubric) };
  }
  // Links stored before AP-021 have no kind: they are general websites.
  if (type === 'link') return config ? { ...config, kind: readKind(config) } : config;
  if (type !== 'quiz') return config;
  return { ...readSettings(config), ...stats };
}

/** Question counts and points of the working question bank, per quiz. */
async function workingQuizStats(executor: Executor, rows: ActivityRecord[]): Promise<Map<string, QuizStats>> {
  const quizIds = rows.filter((row) => row.type === 'quiz').map((row) => row.id);
  if (!quizIds.length) return new Map();
  const stats = await executor
    .select({ activityId: quizQuestions.activityId, questionCount: count(), totalPoints: sum(quizQuestions.points).mapWith(Number) })
    .from(quizQuestions)
    .where(inArray(quizQuestions.activityId, quizIds))
    .groupBy(quizQuestions.activityId);
  return new Map(stats.map(({ activityId, ...rest }) => [activityId, rest]));
}

const NO_QUESTIONS: QuizStats = { questionCount: 0, totalPoints: 0 };

/**
 * Staff see the working copy plus review metadata and the live (approved) version.
 * Students only ever see the approved live version, without review metadata.
 */
function toResponse(row: ActivityRecord, courseId: string, staffView: boolean, working: QuizStats = NO_QUESTIONS) {
  const base = {
    id: row.id,
    courseId,
    sectionId: row.sectionId,
    type: row.type,
    position: row.position,
    isVisible: row.isVisible,
    folderId: row.folderId,
    createdAt: row.createdAt,
  };
  if (!staffView) {
    return {
      ...base,
      title: row.approvedTitle,
      content: presentContent(row.type, row.approvedConfig, snapshotStats(row.approvedConfig)),
      review: null,
      liveVersion: null,
      updatedAt: row.approvedAt,
    };
  }
  return {
    ...base,
    title: row.title,
    content: presentContent(row.type, row.config, working),
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
        ? { title: row.approvedTitle, content: presentContent(row.type, row.approvedConfig, snapshotStats(row.approvedConfig)), approvedAt: row.approvedAt }
        : null,
    updatedAt: row.updatedAt,
  };
}

const snapshot = (row: ActivityRecord) => ({ title: row.title, content: row.config, reviewStatus: row.reviewStatus });

/**
 * Approved version for the audit log. A quiz snapshot contains answer keys, which are never written to the
 * append-only audit log: only its settings, totals and question ids are recorded.
 */
function auditLiveVersion(type: ActivityRecord['type'], title: string | null, config: ActivityConfig | null) {
  if (!title) return null;
  if (type !== 'quiz') return { title, content: config };
  return {
    title,
    content: presentContent(type, config, snapshotStats(config)),
    questionIds: readSnapshotQuestions(config).map((question) => question.id),
  };
}

/**
 * Loads an activity of this course (row-locked inside transactions). Students only reach approved,
 * visible content in visible sections; anything else is 404 (shared with the document routes). A
 * section that is locked by a prerequisite answers 403 SECTION_LOCKED without revealing content.
 */
export async function findActivity(executor: Executor, access: CourseAccess, activityId: string, lock: boolean) {
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
    await assertSectionOpen(executor, access, row.activity.sectionId);
  }
  return row.activity;
}

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
      await assertSectionOpen(db, access, section.id);

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
      const stats = staffView ? await workingQuizStats(db, page.items) : new Map<string, QuizStats>();
      return {
        items: page.items.map((row) => toResponse(row, access.course.id, staffView, stats.get(row.id))),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.post<{ Params: SectionParams; Body: CreateBody }>(
    '/courses/:id/sections/:sectionId/activities',
    { ...authenticatedWrite, schema: { params: courseSectionParamsSchema, body: activityCreateSchema, response: { 201: activitySchema } } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'content.edit');
      // `folderId` is accepted for lessons and links only (the request schema refuses it elsewhere).
      const { type, folderId, ...input } = request.body as CreateBody & { folderId?: string };
      const config = buildContent(type, input);

      const created = await db.transaction(async (tx) => {
        // Lock the section so concurrent additions get distinct positions.
        const [section] = await tx
          .select({ id: sections.id })
          .from(sections)
          .where(and(eq(sections.id, request.params.sectionId), eq(sections.courseId, access.course.id)))
          .for('update');
        if (!section) throw notFound('Section');
        if (folderId) {
          const [folder] = await tx
            .select({ id: resourceFolders.id })
            .from(resourceFolders)
            .where(and(eq(resourceFolders.id, folderId), eq(resourceFolders.sectionId, section.id), eq(resourceFolders.courseId, access.course.id)));
          if (!folder) throw new ApiProblem(422, 'RESOURCE_FOLDER_NOT_FOUND', 'The folder does not exist in this section.');
        }
        const [{ last } = { last: null }] = await tx
          .select({ last: max(activities.position) })
          .from(activities)
          .where(eq(activities.sectionId, section.id));
        const [row] = await tx
          .insert(activities)
          .values({ sectionId: section.id, type, title: input.title.trim(), config, position: (last ?? -1) + 1, reviewStatus: 'draft', folderId: folderId ?? null })
          .returning();
        if (!row) throw new Error('Activity was not created');
        await recordAudit(tx, request, {
          action: 'activity.created',
          entityType: 'activity',
          entityId: row.id,
          before: null,
          after: { courseId: access.course.id, sectionId: section.id, folderId: row.folderId, type, ...snapshot(row) },
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
      const staffView = canInCourse(access, 'content.viewUnapproved');
      const stats = staffView ? await workingQuizStats(db, [row]) : new Map<string, QuizStats>();
      return toResponse(row, access.course.id, staffView, stats.get(row.id));
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
      return toResponse(updated, access.course.id, true, (await workingQuizStats(db, [updated])).get(updated.id));
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
        if (current.type === 'quiz' && !(await workingQuizStats(tx, [current])).get(current.id)?.questionCount) {
          throw new ApiProblem(422, 'QUIZ_HAS_NO_QUESTIONS', 'Add at least one question before submitting the quiz for review.');
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
      return toResponse(submitted, access.course.id, true, (await workingQuizStats(db, [submitted])).get(submitted.id));
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
        // Quizzes publish their settings together with a snapshot of the reviewed questions.
        let approvedConfig: ActivityConfig = current.config;
        if (current.type === 'quiz' && decision === 'approve') {
          const questions = await tx
            .select()
            .from(quizQuestions)
            .where(eq(quizQuestions.activityId, current.id))
            .orderBy(asc(quizQuestions.position), asc(quizQuestions.id));
          if (!questions.length) {
            throw new ApiProblem(422, 'QUIZ_HAS_NO_QUESTIONS', 'A quiz without questions cannot be approved.');
          }
          const snapshot: QuizSnapshot = {
            ...readSettings(current.config),
            questions: questions.map(({ id, type, prompt, options, correctAnswer, points }) => ({ id, type, prompt, options, correctAnswer, points })),
          };
          approvedConfig = snapshot;
        }
        const [row] = await tx
          .update(activities)
          .set(
            decision === 'approve'
              ? {
                  ...reviewFields,
                  reviewStatus: 'approved' as const,
                  // Publish exactly what was reviewed (editing is blocked while submitted).
                  approvedTitle: current.title,
                  approvedConfig,
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
            liveVersion: auditLiveVersion(current.type, current.approvedTitle, current.approvedConfig),
          },
          after: {
            reviewStatus: row.reviewStatus,
            comment,
            liveVersion: auditLiveVersion(row.type, row.approvedTitle, row.approvedConfig),
          },
        });
        return row;
      });
      return toResponse(reviewed, access.course.id, true, (await workingQuizStats(db, [reviewed])).get(reviewed.id));
    },
  );
};
