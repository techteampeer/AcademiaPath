import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import { canAsCourseRole, canInCourse, getCourseAccess, type CourseAccess } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import type { Database } from '../db/client.js';
import { getPgError } from '../db/errors.js';
import { activities, activityCompletions, courses, enrollments, sectionPrerequisites, sections, users } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';
import { decodeCursor, paginationQuerySchema, toPage, type PaginationQuery } from '../http/pagination.js';
import {
  assertSectionOpen,
  completedAtSql,
  eligibleActivity,
  hasCycle,
  isReadingType,
  learnerProgress,
  summarize,
  type LearnerProgress,
  type LearnerSection,
} from '../progress/model.js';
import { courseActivityParamsSchema, courseSectionParamsSchema } from './activity-schemas.js';
import { courseIdParamsSchema } from './course-schemas.js';
import {
  completionSchema,
  courseProgressSchema,
  myProgressListSchema,
  prerequisiteListSchema,
  prerequisiteUpdateSchema,
  sectionPrerequisitesSchema,
  sectionProgressSchema,
  studentProgressPageSchema,
} from './progress-schemas.js';

type CourseParams = { id: string };
type SectionParams = { id: string; sectionId: string };
type ActivityParams = { id: string; activityId: string };
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const notFound = (what: string) => new ApiProblem(404, 'NOT_FOUND', `${what} not found.`);
const forbidden = (detail: string) => new ApiProblem(403, 'FORBIDDEN', detail);

/** One consistent snapshot for every figure in a response, even while other requests write. */
const SNAPSHOT = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

const sectionSummary = (section: LearnerSection) => ({
  sectionId: section.id,
  title: section.title,
  position: section.position,
  locked: section.locked,
  requiredSections: section.requiredSections,
  ...section.summary,
});

const courseSummary = (courseId: string, progress: LearnerProgress) => ({ courseId, continueAt: progress.continueAt, ...progress.summary });

/**
 * Learning progress (AP-020). Every figure is calculated by the server from stored records: a student's
 * own marks on reading activities, submitted quiz attempts and assignment submissions. Nothing reads
 * scores or grades, and progress never changes them.
 */
export const progressRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const authenticated = { preValidation: [app.requireAuth] };
  const authenticatedWrite = { preValidation: [app.requireAuth, app.requireCsrf] };
  const adminWrite = { preValidation: [app.requireAuth, app.requireCsrf, app.requireAdministrator] };

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  /** Default deny: 404 unless the caller may see the course (draft courses are invisible to students). */
  async function courseAccess(request: FastifyRequest, courseId: string): Promise<CourseAccess> {
    const access = await getCourseAccess(db, getAuth(request).user, courseId);
    if (!access) throw notFound('Course');
    return access;
  }

  /** Own progress is a student role only: administrators and staff cannot read or write it as their own. */
  function requireStudent(access: CourseAccess) {
    if (!canAsCourseRole(access, 'progress.own')) throw forbidden('Only students enrolled in this course have learning progress.');
  }

  // ---- Student: own progress ----

  app.get('/me/progress', { ...authenticated, schema: { response: { 200: myProgressListSchema } } }, async (request) => {
    const { user } = getAuth(request);
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({ courseId: courses.id })
        .from(enrollments)
        .innerJoin(courses, eq(courses.id, enrollments.courseId))
        .where(and(eq(enrollments.userId, user.id), eq(enrollments.role, 'student'), eq(enrollments.status, 'active'), eq(courses.status, 'published')))
        .orderBy(asc(courses.code), asc(courses.id));
      const items = [];
      for (const row of rows) items.push(courseSummary(row.courseId, await learnerProgress(tx, row.courseId, user.id)));
      return { items };
    }, SNAPSHOT);
  });

  app.get<{ Params: CourseParams }>(
    '/courses/:id/progress',
    { ...authenticated, schema: { params: courseIdParamsSchema, response: { 200: courseProgressSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireStudent(access);
      const progress = await db.transaction((tx) => learnerProgress(tx, access.course.id, access.userId), SNAPSHOT);
      return { ...courseSummary(access.course.id, progress), sections: progress.sections.map(sectionSummary) };
    },
  );

  app.get<{ Params: SectionParams }>(
    '/courses/:id/sections/:sectionId/progress',
    { ...authenticated, schema: { params: courseSectionParamsSchema, response: { 200: sectionProgressSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireStudent(access);
      const progress = await db.transaction((tx) => learnerProgress(tx, access.course.id, access.userId), SNAPSHOT);
      // Only visible sections of this course are part of a student's progress.
      const section = progress.sections.find((candidate) => candidate.id === request.params.sectionId);
      if (!section) throw notFound('Section');
      return {
        ...sectionSummary(section),
        // A locked section reports its counts only; its activities are not revealed until it opens.
        activities: section.locked
          ? []
          : section.activities.map((activity) => ({
              activityId: activity.activityId,
              type: activity.type,
              title: activity.title,
              completion: isReadingType(activity.type) ? ('manual' as const) : ('automatic' as const),
              completed: activity.completedAt !== null,
              completedAt: activity.completedAt,
            })),
      };
    },
  );

  /**
   * Shared checks for marking and unmarking, inside the writing transaction: the caller's own active
   * student enrollment and an eligible reading activity of this course in an open section. The rows
   * are locked FOR SHARE, so a concurrent deactivation or content change waits for this write.
   */
  async function lockReadingActivity(tx: Tx, access: CourseAccess, activityId: string) {
    const [enrollment] = await tx
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.courseId, access.course.id),
          eq(enrollments.userId, access.userId),
          eq(enrollments.role, 'student'),
          eq(enrollments.status, 'active'),
        ),
      )
      .for('share');
    if (!enrollment) throw forbidden('Only students enrolled in this course have learning progress.');
    const [row] = await tx
      .select({ id: activities.id, type: activities.type, sectionId: activities.sectionId })
      .from(activities)
      .innerJoin(sections, eq(sections.id, activities.sectionId))
      .where(and(eq(activities.id, activityId), eligibleActivity(access.course.id)))
      .for('share', { of: [activities, sections] });
    if (!row) throw notFound('Activity');
    if (!isReadingType(row.type)) {
      throw new ApiProblem(422, 'COMPLETION_AUTOMATIC', 'Quizzes and assignments are completed automatically when you submit them.');
    }
    await assertSectionOpen(tx, access, row.sectionId);
    return { enrollmentId: enrollment.id, activity: row };
  }

  app.put<{ Params: ActivityParams }>(
    '/courses/:id/activities/:activityId/completion',
    { ...authenticatedWrite, schema: { params: courseActivityParamsSchema, response: { 200: completionSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireStudent(access);
      return db.transaction(async (tx) => {
        const { enrollmentId, activity } = await lockReadingActivity(tx, access, request.params.activityId);
        // Idempotent: a repeated or concurrent mark keeps the first completion time and is audited once.
        const [inserted] = await tx
          .insert(activityCompletions)
          .values({ activityId: activity.id, courseId: access.course.id, enrollmentId, userId: access.userId })
          .onConflictDoNothing({ target: [activityCompletions.activityId, activityCompletions.userId] })
          .returning();
        if (inserted) {
          await recordAudit(tx, request, {
            action: 'activity.completion_marked',
            entityType: 'activity',
            entityId: activity.id,
            before: null,
            after: { courseId: access.course.id, sectionId: activity.sectionId, userId: access.userId },
          });
        }
        const [current] = await tx
          .select({ completedAt: activityCompletions.completedAt })
          .from(activityCompletions)
          .where(and(eq(activityCompletions.activityId, activity.id), eq(activityCompletions.userId, access.userId)));
        return { activityId: activity.id, sectionId: activity.sectionId, completed: true, completedAt: current?.completedAt ?? null };
      });
    },
  );

  app.delete<{ Params: ActivityParams }>(
    '/courses/:id/activities/:activityId/completion',
    { ...authenticatedWrite, schema: { params: courseActivityParamsSchema, response: { 200: completionSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireStudent(access);
      return db.transaction(async (tx) => {
        const { activity } = await lockReadingActivity(tx, access, request.params.activityId);
        const [removed] = await tx
          .delete(activityCompletions)
          .where(and(eq(activityCompletions.activityId, activity.id), eq(activityCompletions.userId, access.userId)))
          .returning();
        if (removed) {
          await recordAudit(tx, request, {
            action: 'activity.completion_unmarked',
            entityType: 'activity',
            entityId: activity.id,
            before: { courseId: access.course.id, sectionId: activity.sectionId, userId: access.userId, completedAt: removed.completedAt.toISOString() },
            after: null,
          });
        }
        return { activityId: activity.id, sectionId: activity.sectionId, completed: false, completedAt: null };
      });
    },
  );

  // ---- Staff: progress of the course's students (read-only) ----

  app.get<{ Params: CourseParams; Querystring: PaginationQuery }>(
    '/courses/:id/progress/students',
    { ...authenticated, schema: { params: courseIdParamsSchema, querystring: paginationQuerySchema, response: { 200: studentProgressPageSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      // Instructors, non-editing instructors and administrators; never the design team or students.
      if (!canInCourse(access, 'progress.viewAll')) throw forbidden('You cannot view student progress in this course.');
      const courseId = access.course.id;
      const { limit } = request.query;
      const after = decodeCursor(request.query.cursor, 'string');
      return db.transaction(async (tx) => {
        const [{ total } = { total: 0 }] = await tx
          .select({ total: count() })
          .from(activities)
          .innerJoin(sections, eq(sections.id, activities.sectionId))
          .where(eligibleActivity(courseId));
        // Per student: eligible activities with a completion (same rules as the student's own view).
        const completed = tx
          .select({ n: sql`count(*)::int` })
          .from(activities)
          .innerJoin(sections, eq(sections.id, activities.sectionId))
          .where(and(eligibleActivity(courseId), sql`(${completedAtSql(sql`"enrollments"."user_id"`)}) IS NOT NULL`));
        const emailKey = sql<string>`lower(${users.email})`;
        const rows = await tx
          .select({
            student: { id: users.id, email: users.email, givenName: users.givenName, familyName: users.familyName },
            emailKey,
            enrollmentId: enrollments.id,
            completedCount: sql<number>`(${completed})`.mapWith(Number),
          })
          .from(enrollments)
          .innerJoin(users, eq(users.id, enrollments.userId))
          .where(
            and(
              eq(enrollments.courseId, courseId),
              eq(enrollments.role, 'student'),
              eq(enrollments.status, 'active'),
              after ? sql`(${emailKey}, ${enrollments.id}) > (${after.key}, ${after.id}::uuid)` : undefined,
            ),
          )
          .orderBy(asc(emailKey), asc(enrollments.id))
          .limit(limit + 1);
        const page = toPage(rows, limit, (row) => [row.emailKey, row.enrollmentId]);
        return {
          totalCount: total,
          items: page.items.map((row) => ({ student: row.student, ...summarize(row.completedCount, total) })),
          nextCursor: page.nextCursor,
        };
      }, SNAPSHOT);
    },
  );

  // ---- Section prerequisites ----

  /** Requirements per section, in course order (staff and administrators; students see theirs in progress). */
  async function prerequisiteItems(executor: Pick<Database, 'select'>, courseId: string) {
    const rows = await executor
      .select({ sectionId: sectionPrerequisites.sectionId, requiredSectionId: sectionPrerequisites.requiredSectionId })
      .from(sectionPrerequisites)
      .innerJoin(sections, eq(sections.id, sectionPrerequisites.requiredSectionId))
      .where(eq(sectionPrerequisites.courseId, courseId))
      .orderBy(asc(sections.position), asc(sections.id));
    const grouped = new Map<string, string[]>();
    for (const row of rows) grouped.set(row.sectionId, [...(grouped.get(row.sectionId) ?? []), row.requiredSectionId]);
    return [...grouped].map(([sectionId, requiredSectionIds]) => ({ sectionId, requiredSectionIds }));
  }

  app.get<{ Params: CourseParams }>(
    '/courses/:id/section-prerequisites',
    { ...authenticated, schema: { params: courseIdParamsSchema, response: { 200: prerequisiteListSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      if (!canInCourse(access, 'sections.viewHidden')) throw forbidden('Only course staff can see the prerequisite settings.');
      return { items: await prerequisiteItems(db, access.course.id) };
    },
  );

  app.put<{ Params: SectionParams; Body: { requiredSectionIds: string[] } }>(
    '/courses/:id/sections/:sectionId/prerequisites',
    { ...adminWrite, schema: { params: courseSectionParamsSchema, body: prerequisiteUpdateSchema, response: { 200: sectionPrerequisitesSchema } } },
    async (request) => {
      const { id: courseId, sectionId } = request.params;
      const required = request.body.requiredSectionIds;
      return db
        .transaction(async (tx) => {
          // Serializes prerequisite changes per course, so two edits cannot combine into a cycle.
          // (NO KEY UPDATE does not block enrollments, completions and other rows that reference the course.)
          const [course] = await tx.select({ id: courses.id }).from(courses).where(eq(courses.id, courseId)).for('no key update');
          if (!course) throw notFound('Course');
          const courseSections = await tx.select({ id: sections.id }).from(sections).where(eq(sections.courseId, course.id));
          const known = new Set(courseSections.map((section) => section.id));
          if (!known.has(sectionId)) throw notFound('Section');
          if (required.includes(sectionId)) {
            throw new ApiProblem(422, 'PREREQUISITE_SELF', 'A section cannot require itself.');
          }
          if (required.some((id) => !known.has(id))) {
            throw new ApiProblem(422, 'PREREQUISITE_SECTION_NOT_FOUND', 'Every required section must belong to this course.');
          }
          const existing = await tx
            .select({ sectionId: sectionPrerequisites.sectionId, requiredSectionId: sectionPrerequisites.requiredSectionId })
            .from(sectionPrerequisites)
            .where(eq(sectionPrerequisites.courseId, course.id));
          const proposed = [...existing.filter((edge) => edge.sectionId !== sectionId), ...required.map((id) => ({ sectionId, requiredSectionId: id }))];
          if (hasCycle(proposed)) {
            throw new ApiProblem(422, 'PREREQUISITE_CYCLE', 'These prerequisites would create a cycle, so some sections could never open.');
          }
          const before = existing.filter((edge) => edge.sectionId === sectionId).map((edge) => edge.requiredSectionId);
          await tx.delete(sectionPrerequisites).where(eq(sectionPrerequisites.sectionId, sectionId));
          if (required.length) {
            await tx.insert(sectionPrerequisites).values(
              required.map((requiredSectionId) => ({ courseId: course.id, sectionId, requiredSectionId, createdByUserId: getAuth(request).user.id })),
            );
          }
          const saved = (await prerequisiteItems(tx, course.id)).find((item) => item.sectionId === sectionId)?.requiredSectionIds ?? [];
          await recordAudit(tx, request, {
            action: 'section.prerequisites_updated',
            entityType: 'section',
            entityId: sectionId,
            before: { courseId: course.id, requiredSectionIds: before },
            after: { courseId: course.id, requiredSectionIds: saved },
          });
          return { sectionId, requiredSectionIds: saved };
        })
        .catch((error: unknown) => {
          // Database backstop (section_prerequisites_acyclic trigger).
          if (getPgError(error)?.code === '23514') {
            throw new ApiProblem(422, 'PREREQUISITE_CYCLE', 'These prerequisites would create a cycle, so some sections could never open.');
          }
          throw error;
        });
    },
  );
};
