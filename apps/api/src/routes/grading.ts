import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { readAssignment, rubricTotal, validateScores } from '../assignments/model.js';
import { recordAudit } from '../audit.js';
import { canAsCourseRole, canInCourse, getCourseAccess, type CourseAccess, type CoursePermission } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import type { Database } from '../db/client.js';
import { getPgError } from '../db/errors.js';
import {
  activities,
  assignmentCriterionScores,
  assignmentSubmissions,
  enrollments,
  grades,
  sections,
  users,
  type ReleasedGradeDetail,
} from '../db/schema/index.js';
import { gradeStatus, releasedGradeColumns, releasedGradeView, staffGradeView, type GradeRecord, type ReleasedGradeRow } from '../grading/grades.js';
import { courseTotal, GRADE_SCALE_MAX, toScale20 } from '../grading/scale.js';
import { ApiProblem } from '../http/errors.js';
import { decodeCursor, paginationQuerySchema, toPage, type PaginationQuery } from '../http/pagination.js';
import { readSnapshotQuestions } from '../quizzes/model.js';
import { courseActivityParamsSchema } from './activity-schemas.js';
import {
  courseParamsSchema,
  gradebookSchema,
  gradeInputSchema,
  releaseResultSchema,
  studentAssignmentStatusSchema,
  studentGradesSchema,
  studentSubmissionSchema,
  submissionCreateSchema,
  submissionDetailSchema,
  submissionPageSchema,
  submissionParamsSchema,
} from './grading-schemas.js';

type ActivityParams = { id: string; activityId: string };
type SubmissionParams = ActivityParams & { submissionId: string };
type GradeBody = { scores: Array<{ criterionId: string; points: number }>; feedback?: string };
type Executor = Pick<Database, 'select' | 'insert' | 'update'>;
type ActivityRecord = typeof activities.$inferSelect;
type SubmissionRecord = typeof assignmentSubmissions.$inferSelect;
type StudentRecord = { id: string; email: string; givenName: string; familyName: string };
type GradableType = 'quiz' | 'assignment';

const GRADABLE: GradableType[] = ['quiz', 'assignment'];
const notFound = (what: string) => new ApiProblem(404, 'NOT_FOUND', `${what} not found.`);
const forbidden = (detail: string) => new ApiProblem(403, 'FORBIDDEN', detail);
const submissionExists = () =>
  new ApiProblem(409, 'SUBMISSION_EXISTS', 'You have already submitted this assignment. Only one final submission is allowed.');
const submissionClosed = () => new ApiProblem(409, 'SUBMISSION_CLOSED', 'The submission deadline for this assignment has passed.');
const studentColumns = { id: users.id, email: users.email, givenName: users.givenName, familyName: users.familyName };

/** Points available in the approved version of a quiz or assignment. */
function approvedMaxPoints(activity: Pick<ActivityRecord, 'type' | 'approvedConfig'>): number {
  if (activity.type === 'assignment') return rubricTotal(readAssignment(activity.approvedConfig).rubric);
  return readSnapshotQuestions(activity.approvedConfig).reduce((total, question) => total + question.points, 0);
}

/** A student's own submission: the grade appears only once released (copied at release time). */
function studentSubmissionView(submission: SubmissionRecord, released: ReleasedGradeRow | undefined) {
  const grade = releasedGradeView(released);
  return {
    id: submission.id,
    activityId: submission.activityId,
    body: submission.body,
    submittedAt: submission.submittedAt,
    isLate: submission.isLate,
    gradeStatus: grade ? ('released' as const) : ('pending' as const),
    grade,
  };
}

function submissionSummary(submission: SubmissionRecord, student: StudentRecord, grade: GradeRecord | null) {
  return {
    id: submission.id,
    student,
    submittedAt: submission.submittedAt,
    isLate: submission.isLate,
    status: gradeStatus(grade, true),
    grade: staffGradeView(grade),
  };
}

export const gradingRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const authenticated = { preValidation: [app.requireAuth] };
  const authenticatedWrite = { preValidation: [app.requireAuth, app.requireCsrf] };

  async function courseAccess(request: FastifyRequest, courseId: string): Promise<CourseAccess> {
    const access = await getCourseAccess(db, getAuth(request).user, courseId);
    if (!access) throw notFound('Course');
    return access;
  }

  /** Staff reports: instructors, non-editing instructors, and administrators (read-only). */
  function requireView(access: CourseAccess) {
    if (!canInCourse(access, 'grades.view')) throw forbidden('You cannot view grades in this course.');
  }

  /** Student-only and grader-only actions: explicit course role, never the administrator override. */
  function requireRole(access: CourseAccess, permission: CoursePermission, detail: string) {
    if (!canAsCourseRole(access, permission)) throw forbidden(detail);
  }

  /** A quiz or assignment of this course. Students only reach approved, visible ones in visible sections. */
  async function loadActivity(executor: Pick<Database, 'select'>, access: CourseAccess, activityId: string, types: GradableType[], label: string) {
    const [row] = await executor
      .select({ activity: activities, sectionVisible: sections.isVisible })
      .from(activities)
      .innerJoin(sections, eq(sections.id, activities.sectionId))
      .where(and(eq(activities.id, activityId), eq(sections.courseId, access.course.id), inArray(activities.type, types)))
      .limit(1);
    if (!row) throw notFound(label);
    if (!canInCourse(access, 'content.viewUnapproved')) {
      const available = row.sectionVisible && row.activity.isVisible && row.activity.approvedConfig !== null && row.activity.approvedAt !== null;
      if (!available) throw notFound(label);
    }
    return row.activity;
  }

  async function submissionDetail(executor: Pick<Database, 'select'>, submission: SubmissionRecord, student: StudentRecord, grade: GradeRecord | null) {
    const scores = await executor.select().from(assignmentCriterionScores).where(eq(assignmentCriterionScores.submissionId, submission.id));
    const byCriterion = new Map(scores.map((score) => [score.criterionId, score]));
    return {
      ...submissionSummary(submission, student, grade),
      body: submission.body,
      rubric: submission.rubric,
      scores: submission.rubric
        .filter((criterion) => byCriterion.has(criterion.id))
        .map((criterion) => ({ criterionId: criterion.id, title: criterion.title, points: byCriterion.get(criterion.id)!.points, maxPoints: criterion.maxPoints })),
      feedback: grade?.feedback ?? null,
    };
  }

  // ---- Assignment submissions (students) ----

  app.post<{ Params: ActivityParams; Body: { body: string } }>(
    '/courses/:id/activities/:activityId/submissions',
    { ...authenticatedWrite, schema: { params: courseActivityParamsSchema, body: submissionCreateSchema, response: { 201: studentSubmissionSchema } } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      requireRole(access, 'assignment.submit', 'Only enrolled students can submit assignments.');
      const { user } = getAuth(request);
      const submission = await db
        .transaction(async (tx) => {
          const assignment = await loadActivity(tx, access, request.params.activityId, ['assignment'], 'Assignment');
          const settings = readAssignment(assignment.approvedConfig);
          if (!assignment.approvedAt || !settings.rubric.length) throw notFound('Assignment');
          // Serializes submissions per student and course.
          const [enrollment] = await tx
            .select({ id: enrollments.id })
            .from(enrollments)
            .where(and(eq(enrollments.courseId, access.course.id), eq(enrollments.userId, user.id), eq(enrollments.status, 'active')))
            .for('update');
          if (!enrollment) throw notFound('Assignment');
          const [existing] = await tx
            .select({ id: assignmentSubmissions.id })
            .from(assignmentSubmissions)
            .where(and(eq(assignmentSubmissions.activityId, assignment.id), eq(assignmentSubmissions.userId, user.id)));
          if (existing) throw submissionExists();
          // The server clock sets submitted_at; the database rejects submissions outside the window.
          const [row] = await tx
            .insert(assignmentSubmissions)
            .values({
              activityId: assignment.id,
              courseId: access.course.id,
              enrollmentId: enrollment.id,
              userId: user.id,
              body: request.body.body,
              rubric: settings.rubric,
              maxPoints: rubricTotal(settings.rubric),
              assignmentVersionApprovedAt: assignment.approvedAt,
              dueAt: new Date(settings.dueAt),
              lateUntil: settings.lateUntil ? new Date(settings.lateUntil) : null,
              isLate: sql`now() > ${settings.dueAt}::timestamptz`,
            })
            .returning();
          if (!row) throw new Error('Submission was not recorded');
          await recordAudit(tx, request, {
            action: 'assignment.submitted',
            entityType: 'assignment_submission',
            entityId: row.id,
            before: null,
            after: { activityId: row.activityId, isLate: row.isLate, submittedAt: row.submittedAt, characters: row.body.length },
          });
          return row;
        })
        .catch((error: unknown) => {
          const pg = getPgError(error);
          if (pg?.code === '23505' && pg.constraint === 'assignment_submissions_activity_user_unique') throw submissionExists();
          if (pg?.code === '23514' && pg.constraint === 'assignment_submissions_window_check') throw submissionClosed();
          throw error;
        });
      return reply.code(201).send(studentSubmissionView(submission, undefined));
    },
  );

  app.get<{ Params: ActivityParams }>(
    '/courses/:id/activities/:activityId/submissions/mine',
    { ...authenticated, schema: { params: courseActivityParamsSchema, response: { 200: studentAssignmentStatusSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireRole(access, 'assignment.submit', 'Only enrolled students submit assignments.');
      const { user } = getAuth(request);
      const assignment = await loadActivity(db, access, request.params.activityId, ['assignment'], 'Assignment');
      const settings = readAssignment(assignment.approvedConfig);
      const [submission] = await db
        .select()
        .from(assignmentSubmissions)
        .where(and(eq(assignmentSubmissions.activityId, assignment.id), eq(assignmentSubmissions.userId, user.id)));
      const [released] = submission
        ? await db.select(releasedGradeColumns).from(grades).where(and(eq(grades.activityId, assignment.id), eq(grades.userId, user.id)))
        : [];
      const deadline = settings.lateUntil ?? settings.dueAt;
      const window = await db.execute<{ open: boolean }>(sql`SELECT now() <= ${deadline}::timestamptz AS "open"`);
      return {
        dueAt: settings.dueAt,
        lateUntil: settings.lateUntil,
        acceptingSubmissions: !submission && window.rows[0]?.open === true,
        submission: submission ? studentSubmissionView(submission, released) : null,
      };
    },
  );

  // ---- Submissions and rubric grading (staff) ----

  app.get<{ Params: ActivityParams; Querystring: PaginationQuery }>(
    '/courses/:id/activities/:activityId/submissions',
    { ...authenticated, schema: { params: courseActivityParamsSchema, querystring: paginationQuerySchema, response: { 200: submissionPageSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireView(access);
      const assignment = await loadActivity(db, access, request.params.activityId, ['assignment'], 'Assignment');
      const { limit } = request.query;
      const after = decodeCursor(request.query.cursor, 'string');
      const sortKey = sql<string>`lower(${users.email})`;
      const rows = await db
        .select({ submission: assignmentSubmissions, student: studentColumns, grade: grades, sortKey })
        .from(assignmentSubmissions)
        .innerJoin(users, eq(users.id, assignmentSubmissions.userId))
        .leftJoin(grades, eq(grades.submissionId, assignmentSubmissions.id))
        .where(
          and(
            eq(assignmentSubmissions.activityId, assignment.id),
            eq(assignmentSubmissions.courseId, access.course.id),
            after ? sql`(${sortKey}, ${assignmentSubmissions.id}) > (${after.key}, ${after.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(sortKey), asc(assignmentSubmissions.id))
        .limit(limit + 1);
      const page = toPage(rows, limit, (row) => [row.sortKey, row.submission.id]);
      return { items: page.items.map((row) => submissionSummary(row.submission, row.student, row.grade)), nextCursor: page.nextCursor };
    },
  );

  app.get<{ Params: SubmissionParams }>(
    '/courses/:id/activities/:activityId/submissions/:submissionId',
    { ...authenticated, schema: { params: submissionParamsSchema, response: { 200: submissionDetailSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireView(access);
      const assignment = await loadActivity(db, access, request.params.activityId, ['assignment'], 'Assignment');
      const [row] = await db
        .select({ submission: assignmentSubmissions, student: studentColumns, grade: grades })
        .from(assignmentSubmissions)
        .innerJoin(users, eq(users.id, assignmentSubmissions.userId))
        .leftJoin(grades, eq(grades.submissionId, assignmentSubmissions.id))
        .where(
          and(
            eq(assignmentSubmissions.id, request.params.submissionId),
            eq(assignmentSubmissions.activityId, assignment.id),
            eq(assignmentSubmissions.courseId, access.course.id),
          ),
        );
      if (!row) throw notFound('Submission');
      return submissionDetail(db, row.submission, row.student, row.grade);
    },
  );

  app.put<{ Params: SubmissionParams; Body: GradeBody }>(
    '/courses/:id/activities/:activityId/submissions/:submissionId/grade',
    { ...authenticatedWrite, schema: { params: submissionParamsSchema, body: gradeInputSchema, response: { 200: submissionDetailSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireRole(access, 'grades.grade', 'Only instructors and non-editing instructors assigned to this course can grade.');
      const { user } = getAuth(request);
      return db.transaction(async (tx) => {
        const assignment = await loadActivity(tx, access, request.params.activityId, ['assignment'], 'Assignment');
        // Lock order (submission, then grade) serializes concurrent grading of one submission.
        const [row] = await tx
          .select({ submission: assignmentSubmissions, student: studentColumns })
          .from(assignmentSubmissions)
          .innerJoin(users, eq(users.id, assignmentSubmissions.userId))
          .where(
            and(
              eq(assignmentSubmissions.id, request.params.submissionId),
              eq(assignmentSubmissions.activityId, assignment.id),
              eq(assignmentSubmissions.courseId, access.course.id),
            ),
          )
          .for('update', { of: assignmentSubmissions });
        if (!row) throw notFound('Submission');
        const { submission, student } = row;
        const scored = validateScores(submission.rubric, request.body.scores);
        const points = scored.reduce((total, score) => total + score.points, 0);
        const feedback = request.body.feedback?.trim() || null;

        const [current] = await tx.select().from(grades).where(eq(grades.submissionId, submission.id)).for('update');
        const currentScores = await tx.select().from(assignmentCriterionScores).where(eq(assignmentCriterionScores.submissionId, submission.id));
        const previous = new Map(currentScores.map((score) => [score.criterionId, score.points]));
        const unchanged =
          current !== undefined &&
          current.points === points &&
          current.feedback === feedback &&
          scored.every((score) => previous.get(score.criterionId) === score.points);
        if (unchanged) return submissionDetail(tx, submission, student, current);

        for (const score of scored) {
          await tx
            .insert(assignmentCriterionScores)
            .values({ submissionId: submission.id, criterionId: score.criterionId, points: score.points, maxPoints: score.maxPoints })
            .onConflictDoUpdate({
              target: [assignmentCriterionScores.submissionId, assignmentCriterionScores.criterionId],
              set: { points: score.points, maxPoints: score.maxPoints },
            });
        }
        const [grade] = await tx
          .insert(grades)
          .values({
            courseId: access.course.id,
            activityId: assignment.id,
            userId: submission.userId,
            enrollmentId: submission.enrollmentId,
            source: 'assignment',
            submissionId: submission.id,
            points,
            maxPoints: submission.maxPoints,
            feedback,
            gradedByUserId: user.id,
            gradedAt: sql`now()`,
          })
          .onConflictDoUpdate({
            target: [grades.activityId, grades.userId],
            set: { points, maxPoints: submission.maxPoints, feedback, gradedByUserId: user.id, gradedAt: sql`now()`, revision: sql`${grades.revision} + 1` },
          })
          .returning();
        if (!grade) throw new Error('Grade was not recorded');
        await recordAudit(tx, request, {
          action: 'assignment.graded',
          entityType: 'assignment_submission',
          entityId: submission.id,
          before: current
            ? { points: current.points, maxPoints: current.maxPoints, feedback: current.feedback, scores: Object.fromEntries(previous), revision: current.revision }
            : null,
          after: {
            studentUserId: submission.userId,
            points: grade.points,
            maxPoints: grade.maxPoints,
            feedback: grade.feedback,
            scores: Object.fromEntries(scored.map((score) => [score.criterionId, score.points])),
            revision: grade.revision,
          },
        });
        return submissionDetail(tx, submission, student, grade);
      });
    },
  );

  // ---- Grade release (staff) ----

  /** What students see after release: feedback and rubric scores of assignments (nothing else for quizzes). */
  async function releaseDetails(tx: Executor, pending: GradeRecord[]): Promise<Map<string, ReleasedGradeDetail>> {
    const submissionIds = pending.flatMap((grade) => (grade.submissionId ? [grade.submissionId] : []));
    const scores = submissionIds.length
      ? await tx.select().from(assignmentCriterionScores).where(inArray(assignmentCriterionScores.submissionId, submissionIds))
      : [];
    const rubrics = submissionIds.length
      ? await tx
          .select({ id: assignmentSubmissions.id, rubric: assignmentSubmissions.rubric })
          .from(assignmentSubmissions)
          .where(inArray(assignmentSubmissions.id, submissionIds))
      : [];
    const rubricById = new Map(rubrics.map((row) => [row.id, row.rubric]));
    return new Map(
      pending.map((grade): [string, ReleasedGradeDetail] => {
        if (!grade.submissionId) return [grade.id, { feedback: null, criteria: [] }];
        const own = new Map(scores.filter((score) => score.submissionId === grade.submissionId).map((score) => [score.criterionId, score.points]));
        const criteria = (rubricById.get(grade.submissionId) ?? [])
          .filter((criterion) => own.has(criterion.id))
          .map((criterion) => ({ criterionId: criterion.id, title: criterion.title, points: own.get(criterion.id)!, maxPoints: criterion.maxPoints }));
        return [grade.id, { feedback: grade.feedback, criteria }];
      }),
    );
  }

  app.post<{ Params: ActivityParams }>(
    '/courses/:id/activities/:activityId/grades/release',
    { ...authenticatedWrite, schema: { params: courseActivityParamsSchema, response: { 200: releaseResultSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireRole(access, 'grades.release', 'Only instructors and non-editing instructors assigned to this course can release grades.');
      const { user } = getAuth(request);
      return db.transaction(async (tx) => {
        const activity = await loadActivity(tx, access, request.params.activityId, GRADABLE, 'Activity');
        // Locked rows changed by a concurrent release are re-checked, so a grade is released once per revision.
        const pending = await tx
          .select()
          .from(grades)
          .where(and(eq(grades.activityId, activity.id), sql`${grades.releasedRevision} IS DISTINCT FROM ${grades.revision}`))
          .orderBy(asc(grades.id))
          .for('update');
        if (!pending.length) return { activityId: activity.id, releasedCount: 0, releasedAt: null };
        const details = await releaseDetails(tx, pending);
        const released: GradeRecord[] = [];
        for (const grade of pending) {
          const [row] = await tx
            .update(grades)
            .set({
              releasedRevision: grade.revision,
              releasedPoints: grade.points,
              releasedMaxPoints: grade.maxPoints,
              releasedDetail: details.get(grade.id) ?? { feedback: null, criteria: [] },
              releasedAt: sql`now()`,
              releasedByUserId: user.id,
            })
            .where(eq(grades.id, grade.id))
            .returning();
          if (row) released.push(row);
        }
        await recordAudit(tx, request, {
          action: 'grades.released',
          entityType: 'activity',
          entityId: activity.id,
          before: null,
          after: {
            releasedCount: released.length,
            grades: released.map((grade) => ({
              gradeId: grade.id,
              userId: grade.userId,
              points: grade.releasedPoints,
              maxPoints: grade.releasedMaxPoints,
              revision: grade.releasedRevision,
            })),
          },
        });
        return { activityId: activity.id, releasedCount: released.length, releasedAt: released[0]?.releasedAt ?? null };
      });
    },
  );

  // ---- Gradebook (staff) and released grades (students) ----

  app.get<{ Params: { id: string }; Querystring: PaginationQuery }>(
    '/courses/:id/gradebook',
    { ...authenticated, schema: { params: courseParamsSchema, querystring: paginationQuerySchema, response: { 200: gradebookSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireView(access);
      const { limit } = request.query;
      const after = decodeCursor(request.query.cursor, 'string');
      const columnRows = await db
        .select({ id: activities.id, type: activities.type, title: activities.approvedTitle, approvedConfig: activities.approvedConfig })
        .from(activities)
        .innerJoin(sections, eq(sections.id, activities.sectionId))
        .where(and(eq(sections.courseId, access.course.id), inArray(activities.type, GRADABLE), isNotNull(activities.approvedConfig)))
        .orderBy(asc(sections.position), asc(activities.position), asc(activities.id));
      const columns = columnRows.map((column) => ({
        activityId: column.id,
        title: column.title ?? '',
        type: column.type as GradableType,
        maxPoints: approvedMaxPoints(column),
      }));

      const sortKey = sql<string>`lower(${users.email})`;
      const studentRows = await db
        .select({ student: studentColumns, sortKey })
        .from(enrollments)
        .innerJoin(users, eq(users.id, enrollments.userId))
        .where(
          and(
            eq(enrollments.courseId, access.course.id),
            eq(enrollments.role, 'student'),
            eq(enrollments.status, 'active'),
            after ? sql`(${sortKey}, ${users.id}) > (${after.key}, ${after.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(sortKey), asc(users.id))
        .limit(limit + 1);
      const page = toPage(studentRows, limit, (row) => [row.sortKey, row.student.id]);
      const userIds = page.items.map((row) => row.student.id);
      const activityIds = columns.map((column) => column.activityId);
      const scope = userIds.length && activityIds.length;
      const [gradeRows, submissionRows] = scope
        ? await Promise.all([
            db
              .select()
              .from(grades)
              .where(and(eq(grades.courseId, access.course.id), inArray(grades.userId, userIds), inArray(grades.activityId, activityIds))),
            db
              .select({ activityId: assignmentSubmissions.activityId, userId: assignmentSubmissions.userId })
              .from(assignmentSubmissions)
              .where(
                and(
                  eq(assignmentSubmissions.courseId, access.course.id),
                  inArray(assignmentSubmissions.userId, userIds),
                  inArray(assignmentSubmissions.activityId, activityIds),
                ),
              ),
          ])
        : [[], []];
      const gradeByKey = new Map(gradeRows.map((grade) => [`${grade.activityId}|${grade.userId}`, grade]));
      const submitted = new Set(submissionRows.map((row) => `${row.activityId}|${row.userId}`));

      const items = page.items.map(({ student }) => {
        const cells = columns.map((column) => {
          const key = `${column.activityId}|${student.id}`;
          const grade = gradeByKey.get(key) ?? null;
          return {
            activityId: column.activityId,
            status: gradeStatus(grade, submitted.has(key)),
            points: grade?.points ?? null,
            maxPoints: grade?.maxPoints ?? null,
            grade20: grade ? toScale20(grade.points, grade.maxPoints) : null,
            releasedAt: grade?.releasedAt ?? null,
          };
        });
        const graded = cells.flatMap((cell) => (cell.points !== null && cell.maxPoints !== null ? [{ points: cell.points, maxPoints: cell.maxPoints }] : []));
        return { student, cells, total: courseTotal(graded) };
      });
      return { scaleMax: GRADE_SCALE_MAX, columns, items, nextCursor: page.nextCursor };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/courses/:id/grades/mine',
    { ...authenticated, schema: { params: courseParamsSchema, response: { 200: studentGradesSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireRole(access, 'grades.viewOwn', 'Only students have grades in a course.');
      const { user } = getAuth(request);
      // Only released columns are read: current (unreleased) grades are never loaded for a student.
      const released = await db
        .select(releasedGradeColumns)
        .from(grades)
        .where(and(eq(grades.courseId, access.course.id), eq(grades.userId, user.id), isNotNull(grades.releasedRevision)));
      const releasedByActivity = new Map(released.map((row) => [row.activityId, row]));
      const rows = await db
        .select({ id: activities.id, type: activities.type, title: activities.approvedTitle, isVisible: activities.isVisible, sectionVisible: sections.isVisible })
        .from(activities)
        .innerJoin(sections, eq(sections.id, activities.sectionId))
        .where(and(eq(sections.courseId, access.course.id), inArray(activities.type, GRADABLE), isNotNull(activities.approvedConfig)))
        .orderBy(asc(sections.position), asc(activities.position), asc(activities.id));
      const items = rows
        .filter((row) => (row.isVisible && row.sectionVisible) || releasedByActivity.has(row.id))
        .map((row) => {
          const grade = releasedGradeView(releasedByActivity.get(row.id));
          return { activityId: row.id, title: row.title ?? '', type: row.type as GradableType, status: grade ? ('released' as const) : ('pending' as const), grade };
        });
      const counted = items.flatMap((item) => (item.grade ? [{ points: item.grade.points, maxPoints: item.grade.maxPoints }] : []));
      return { scaleMax: GRADE_SCALE_MAX, items, total: courseTotal(counted) };
    },
  );
};
