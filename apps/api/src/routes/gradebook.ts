import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import { getPgError } from '../db/errors.js';
import { canAsCourseRole, canInCourse, getCourseAccess, type CourseAccess, type CoursePermission } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import {
  activities,
  courseGradingPolicies,
  enrollments,
  gradeCategories,
  gradeCategoryActivities,
  grades,
  quizAttempts,
  sections,
  users,
} from '../db/schema/index.js';
import { toCsv } from '../grading/csv.js';
import {
  auditReleasedGrades,
  GRADABLE,
  loadGradebookColumns,
  loadStudentWork,
  releasedCourseGrade,
  releaseGradeRows,
  workKey,
  type GradebookColumn,
} from '../grading/gradebook.js';
import type { GradeRecord } from '../grading/grades.js';
import { loadGradingPolicy, weightingCategories, type GradingPolicy } from '../grading/policy.js';
import { GRADE_SCALE_MAX, toScale20 } from '../grading/scale.js';
import { ApiProblem } from '../http/errors.js';
import { passed } from '../quizzes/model.js';
import { closeExpiredAttempts } from '../quizzes/attempts.js';
import {
  gradeReleaseInputSchema,
  gradeReleaseResultSchema,
  gradingPolicyInputSchema,
  gradingPolicySchema,
  studentGradebookSchema,
  studentParamsSchema,
} from './gradebook-schemas.js';
import { courseParamsSchema } from './grading-schemas.js';
import { columnView, policySummary, staffRow } from './grading.js';

type PolicyBody = {
  expectedVersion: number;
  status: 'draft' | 'published';
  categories: Array<{ name: string; weightPercent: number; activityIds: string[] }>;
};
type ReleaseBody = { items: Array<{ activityId: string; userId: string; revision: number }> };
type ReleaseOutcome = 'released' | 'already_released' | 'stale' | 'not_graded' | 'not_found';

const notFound = (what: string) => new ApiProblem(404, 'NOT_FOUND', `${what} not found.`);
const forbidden = (detail: string) => new ApiProblem(403, 'FORBIDDEN', detail);
const studentColumns = { id: users.id, email: users.email, givenName: users.givenName, familyName: users.familyName };

/** The policy as returned by the API (draft or published), with its total weight. */
function policyView(policy: GradingPolicy) {
  return {
    status: policy.status,
    version: policy.version,
    publishedAt: policy.publishedAt,
    updatedAt: policy.updatedAt,
    totalWeightPercent: policy.categories.reduce((total, category) => total + category.weightPercent, 0),
    categories: policy.categories.map((category) => ({ id: category.id, name: category.name, weightPercent: category.weightPercent, activityIds: category.activityIds })),
  };
}

/** Stable, documented CSV columns (see the export operation in the OpenAPI contract). */
const CSV_STATUS: Record<string, string> = {
  not_submitted: 'not_submitted',
  needs_grading: 'needs_grading',
  unreleased: 'unreleased',
  released: 'released',
  changed_since_release: 'changed_since_release',
};

export const gradebookRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const authenticated = { preValidation: [app.requireAuth] };
  const authenticatedWrite = { preValidation: [app.requireAuth, app.requireCsrf] };

  async function courseAccess(request: FastifyRequest, courseId: string): Promise<CourseAccess> {
    const access = await getCourseAccess(db, getAuth(request).user, courseId);
    if (!access) throw notFound('Course');
    return access;
  }

  /** Read and configure: course roles or the administrator override (program-management grants never count). */
  function requirePermission(access: CourseAccess, permission: CoursePermission, detail: string) {
    if (!canInCourse(access, permission)) throw forbidden(detail);
  }

  // ---- Grading policy: categories and weights ----

  app.get<{ Params: { id: string } }>(
    '/courses/:id/grading-policy',
    { ...authenticated, schema: { params: courseParamsSchema, response: { 200: gradingPolicySchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'grades.view', 'You cannot view the grading policy of this course.');
      return policyView(await loadGradingPolicy(db, access.course.id));
    },
  );

  app.put<{ Params: { id: string }; Body: PolicyBody }>(
    '/courses/:id/grading-policy',
    { ...authenticatedWrite, schema: { params: courseParamsSchema, body: gradingPolicyInputSchema, response: { 200: gradingPolicySchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'grades.configure', 'Only instructors of this course and administrators can change the grading policy.');
      const { user } = getAuth(request);
      const body = request.body;
      const categories = body.categories.map((category) => ({ ...category, name: category.name.trim() }));

      // Validation that needs no database: names, memberships and (when published) the total weight.
      const names = new Set<string>();
      for (const category of categories) {
        const key = category.name.toLocaleLowerCase('es');
        if (names.has(key)) throw new ApiProblem(422, 'GRADE_CATEGORY_DUPLICATE', `Two categories are named "${category.name}". Use a different name for each category.`);
        names.add(key);
      }
      const seen = new Set<string>();
      for (const activityId of categories.flatMap((category) => category.activityIds)) {
        if (seen.has(activityId)) throw new ApiProblem(422, 'GRADE_CATEGORY_ACTIVITY_DUPLICATE', 'An activity can belong to only one grade category.');
        seen.add(activityId);
      }
      const total = categories.reduce((sum, category) => sum + category.weightPercent, 0);
      if (body.status === 'published' && (!categories.length || total !== 100)) {
        throw new ApiProblem(422, 'GRADE_WEIGHTS_INVALID', `A published weighting policy needs at least one category and weights that total 100% (now ${total}%).`);
      }

      const saved = await db.transaction(async (tx) => {
        // The policy row lock serializes saves; the version check rejects saves based on an outdated copy.
        const before = await loadGradingPolicy(tx, access.course.id, { lock: true });
        if (before.version !== body.expectedVersion) {
          throw new ApiProblem(409, 'GRADING_POLICY_CONFLICT', 'The grading policy was changed by someone else. Reload it and try again.');
        }
        if (seen.size) {
          const valid = await tx
            .select({ id: activities.id })
            .from(activities)
            .innerJoin(sections, eq(sections.id, activities.sectionId))
            .where(and(inArray(activities.id, [...seen]), eq(sections.courseId, access.course.id), inArray(activities.type, GRADABLE)));
          if (valid.length !== seen.size) {
            throw new ApiProblem(422, 'GRADE_CATEGORY_ACTIVITY_INVALID', 'Grade categories can only contain quizzes and assignments of this course.');
          }
        }
        if (before.status === 'none') {
          const [created] = await tx
            .insert(courseGradingPolicies)
            .values({ courseId: access.course.id, status: body.status, version: 1, updatedByUserId: user.id, publishedAt: body.status === 'published' ? sql`now()` : null })
            .onConflictDoNothing()
            .returning();
          if (!created) throw new ApiProblem(409, 'GRADING_POLICY_CONFLICT', 'The grading policy was changed by someone else. Reload it and try again.');
        } else {
          await tx.delete(gradeCategories).where(eq(gradeCategories.courseId, access.course.id));
          await tx
            .update(courseGradingPolicies)
            .set({
              status: body.status,
              version: sql`${courseGradingPolicies.version} + 1`,
              updatedByUserId: user.id,
              // Keeps the first publication time while the policy stays published.
              publishedAt: body.status === 'published' ? (before.publishedAt ?? sql`now()`) : null,
            })
            .where(eq(courseGradingPolicies.courseId, access.course.id));
        }
        for (const [position, category] of categories.entries()) {
          const [row] = await tx
            .insert(gradeCategories)
            .values({ courseId: access.course.id, name: category.name, weightPercent: category.weightPercent, position })
            .returning({ id: gradeCategories.id });
          if (category.activityIds.length) {
            await tx.insert(gradeCategoryActivities).values(category.activityIds.map((activityId) => ({ activityId, categoryId: row!.id, courseId: access.course.id })));
          }
        }
        const after = await loadGradingPolicy(tx, access.course.id);
        const snapshot = (policy: GradingPolicy) => ({
          status: policy.status,
          version: policy.version,
          categories: policy.categories.map((category) => ({ name: category.name, weightPercent: category.weightPercent, activityIds: category.activityIds })),
        });
        await recordAudit(tx, request, {
          action: 'grading_policy.updated',
          entityType: 'course',
          entityId: access.course.id,
          before: before.status === 'none' ? null : snapshot(before),
          after: snapshot(after),
        });
        return after;
      }).catch((error: unknown) => {
        const pg = getPgError(error);
        if (pg?.code === '23505' && pg.constraint === 'grade_categories_course_name_unique') {
          throw new ApiProblem(422, 'GRADE_CATEGORY_DUPLICATE', 'Two categories have the same name. Use a different name for each category.');
        }
        if (pg?.code === '23505' && pg.constraint === 'course_grading_policies_pkey') {
          throw new ApiProblem(409, 'GRADING_POLICY_CONFLICT', 'The grading policy was changed by someone else. Reload it and try again.');
        }
        throw error;
      });
      return policyView(saved);
    },
  );

  // ---- One student's gradebook (staff drilldown) ----

  app.get<{ Params: { id: string; userId: string } }>(
    '/courses/:id/gradebook/students/:userId',
    { ...authenticated, schema: { params: studentParamsSchema, response: { 200: studentGradebookSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'grades.view', 'You cannot view grades in this course.');
      const [student] = await db
        .select(studentColumns)
        .from(enrollments)
        .innerJoin(users, eq(users.id, enrollments.userId))
        .where(
          and(
            eq(enrollments.courseId, access.course.id),
            eq(enrollments.userId, request.params.userId),
            eq(enrollments.role, 'student'),
            eq(enrollments.status, 'active'),
          ),
        );
      if (!student) throw notFound('Student');
      await db.transaction((tx) => closeExpiredAttempts(tx, request, { courseId: access.course.id, userId: student.id }));
      const policy = await loadGradingPolicy(db, access.course.id);
      const categories = weightingCategories(policy);
      const columns = await loadGradebookColumns(db, access.course.id, categories);
      const work = await loadStudentWork(db, access.course.id, columns.map((column) => column.activityId), [student.id]);
      const workFor = (activityId: string) => work.get(workKey(activityId, student.id));
      const attempts = await db
        .select({ id: quizAttempts.id, activityId: quizAttempts.activityId, passingScorePercent: quizAttempts.passingScorePercent })
        .from(quizAttempts)
        .where(and(eq(quizAttempts.courseId, access.course.id), eq(quizAttempts.userId, student.id)));
      const row = staffRow(columns, categories, workFor);
      return {
        scaleMax: GRADE_SCALE_MAX,
        student,
        policy: policySummary(policy),
        courseGrade: row.courseGrade,
        // Exactly what the student sees: released grades only.
        releasedCourseGrade: releasedCourseGrade(columns, categories, (activityId) => workFor(activityId)?.grade ?? undefined),
        counts: row.counts,
        activities: columns.map((column, index) => {
          const own = workFor(column.activityId);
          const grade = own?.grade ?? null;
          // A quiz grade is judged by the threshold saved with its counted attempt.
          const threshold = grade?.quizAttemptId ? (attempts.find((attempt) => attempt.id === grade.quizAttemptId)?.passingScorePercent ?? null) : null;
          return {
            activity: columnView(column),
            status: row.cells[index]!.status,
            grade: grade ? { points: grade.points, maxPoints: grade.maxPoints, grade20: toScale20(grade.points, grade.maxPoints), revision: grade.revision, gradedAt: grade.gradedAt } : null,
            released:
              grade && grade.releasedRevision !== null && grade.releasedPoints !== null && grade.releasedMaxPoints !== null && grade.releasedAt
                ? {
                    points: grade.releasedPoints,
                    maxPoints: grade.releasedMaxPoints,
                    grade20: toScale20(grade.releasedPoints, grade.releasedMaxPoints),
                    revision: grade.releasedRevision,
                    releasedAt: grade.releasedAt,
                  }
                : null,
            submittedAt: own?.submittedAt ?? null,
            isLate: own?.isLate ?? false,
            inProgress: own?.inProgress ?? false,
            attemptsUsed: column.type === 'quiz' ? attempts.filter((attempt) => attempt.activityId === column.activityId).length : null,
            passingScorePercent: column.type === 'quiz' ? threshold : null,
            passed: column.type === 'quiz' && grade ? passed(grade.points, grade.maxPoints, threshold) : null,
          };
        }),
      };
    },
  );

  // ---- Selective and bulk release ----

  app.post<{ Params: { id: string }; Body: ReleaseBody }>(
    '/courses/:id/grades/release',
    { ...authenticatedWrite, schema: { params: courseParamsSchema, body: gradeReleaseInputSchema, response: { 200: gradeReleaseResultSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      if (!canAsCourseRole(access, 'grades.release')) throw forbidden('Only instructors assigned to this course can release grades.');
      const { user } = getAuth(request);
      const items = request.body.items;
      const pairs = new Set(items.map((item) => workKey(item.activityId, item.userId)));
      if (pairs.size !== items.length) throw new ApiProblem(422, 'GRADE_RELEASE_DUPLICATE', 'Each student and activity can appear only once in a release.');
      const activityIds = [...new Set(items.map((item) => item.activityId))];
      const userIds = [...new Set(items.map((item) => item.userId))];

      return db.transaction(async (tx) => {
        const known = await tx
          .select({ id: activities.id, type: activities.type })
          .from(activities)
          .innerJoin(sections, eq(sections.id, activities.sectionId))
          .where(and(inArray(activities.id, activityIds), eq(sections.courseId, access.course.id), inArray(activities.type, GRADABLE)))
          // A fixed order, so concurrent releases always finalize (and lock) quiz attempts in the same order.
          .orderBy(asc(activities.id));
        const knownIds = new Set(known.map((activity) => activity.id));
        // Expired quiz attempts are finalized (and graded) first; a grade that changes as a result is "stale"
        // for the revision the instructor reviewed, and is not released.
        for (const activity of known) if (activity.type === 'quiz') await closeExpiredAttempts(tx, request, { activityId: activity.id });
        // Rows are locked in id order and re-checked under the lock, so concurrent releases release each grade once.
        const rows = knownIds.size
          ? await tx
              .select()
              .from(grades)
              .where(and(eq(grades.courseId, access.course.id), inArray(grades.activityId, [...knownIds]), inArray(grades.userId, userIds)))
              .orderBy(asc(grades.id))
              .for('update')
          : [];
        const byKey = new Map(rows.map((grade) => [workKey(grade.activityId, grade.userId), grade]));
        const eligible: GradeRecord[] = [];
        const outcomes: ReleaseOutcome[] = items.map((item) => {
          if (!knownIds.has(item.activityId)) return 'not_found';
          const grade = byKey.get(workKey(item.activityId, item.userId));
          // Ungraded or unsubmitted work has no grade, so there is never anything to release for it.
          if (!grade) return 'not_graded';
          if (grade.releasedRevision === grade.revision) return 'already_released';
          if (grade.revision !== item.revision) return 'stale';
          eligible.push(grade);
          return 'released';
        });
        const released = await releaseGradeRows(tx, user.id, eligible, app.now());
        const releasedIds = new Set(released.map((grade) => grade.id));
        const results = items.map((item, index) => {
          let outcome = outcomes[index]!;
          if (outcome === 'released' && !releasedIds.has(byKey.get(workKey(item.activityId, item.userId))!.id)) outcome = 'already_released';
          return { ...item, outcome };
        });
        await auditReleasedGrades(tx, request, released, 'selection');
        if (released.length) {
          await recordAudit(tx, request, {
            action: 'grades.released_selection',
            entityType: 'course',
            entityId: access.course.id,
            before: null,
            after: {
              requested: items.length,
              releasedCount: released.length,
              skipped: results.filter((result) => result.outcome !== 'released').map((result) => ({ activityId: result.activityId, userId: result.userId, outcome: result.outcome })),
            },
          });
        }
        return { releasedCount: released.length, releasedAt: released[0]?.releasedAt ?? null, results };
      });
    },
  );

  // ---- CSV export ----

  app.get<{ Params: { id: string } }>(
    '/courses/:id/gradebook/export.csv',
    { ...authenticated, schema: { params: courseParamsSchema } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'grades.export', 'You cannot export the gradebook of this course.');
      await db.transaction((tx) => closeExpiredAttempts(tx, request, { courseId: access.course.id }));
      const policy = await loadGradingPolicy(db, access.course.id);
      const categories = weightingCategories(policy);
      const columns = await loadGradebookColumns(db, access.course.id, categories);
      // Only this course's active students and only gradebook data: no answer keys, attempts or other courses.
      const students = await db
        .select(studentColumns)
        .from(enrollments)
        .innerJoin(users, eq(users.id, enrollments.userId))
        .where(and(eq(enrollments.courseId, access.course.id), eq(enrollments.role, 'student'), eq(enrollments.status, 'active')))
        .orderBy(asc(sql`lower(${users.email})`), asc(users.id));
      const work = await loadStudentWork(db, access.course.id, columns.map((column) => column.activityId), students.map((student) => student.id));

      const label = (column: GradebookColumn, index: number) => `A${index + 1} ${column.title} [${column.type}]`;
      const header: string[] = ['student_id', 'student_email', 'student_name'];
      columns.forEach((column, index) => header.push(`${label(column, index)} points`, `${label(column, index)} max_points`, `${label(column, index)} status`));
      for (const category of categories ?? []) header.push(`Category ${category.name} (${category.weightPercent}%) percent`);
      header.push('course_grade_method', 'course_grade_0_20', 'course_grade_percent', 'course_grade_status', 'graded_items', 'pending_items', 'released_items', 'unreleased_items', 'needs_grading_items');

      const rows: Array<Array<string | number | null>> = [header];
      for (const student of students) {
        const row = staffRow(columns, categories, (activityId) => work.get(workKey(activityId, student.id)));
        const line: Array<string | number | null> = [student.id, student.email, `${student.givenName} ${student.familyName}`];
        row.cells.forEach((cell, index) => line.push(cell.points, cell.maxPoints ?? columns[index]!.maxPoints, CSV_STATUS[cell.status] ?? cell.status));
        for (const summary of row.courseGrade.categories) line.push(summary.percent);
        line.push(
          row.courseGrade.method,
          row.courseGrade.grade20,
          row.courseGrade.percent,
          row.courseGrade.status,
          row.courseGrade.gradedItems,
          row.courseGrade.pendingItems,
          row.counts.released,
          row.counts.unreleased,
          row.counts.needsGrading,
        );
        rows.push(line);
      }
      await recordAudit(db, request, {
        action: 'gradebook.exported',
        entityType: 'course',
        entityId: access.course.id,
        before: null,
        after: { students: students.length, activities: columns.length, method: categories ? 'weighted' : 'points' },
      });
      const safeCode = access.course.code.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="gradebook-${safeCode}.csv"`)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(toCsv(rows));
    },
  );
};
