import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { readAssignment, rubricTotal } from '../assignments/model.js';
import { recordAudit } from '../audit.js';
import type { Database } from '../db/client.js';
import {
  activities,
  assignmentCriterionScores,
  assignmentSubmissions,
  courses,
  grades,
  quizAttempts,
  sections,
  type ReleasedGradeDetail,
} from '../db/schema/index.js';
import { readSettings, readSnapshotQuestions } from '../quizzes/model.js';
import { notifyUsers } from '../messaging/notify.js';
import type { GradeRecord } from './grades.js';
import { computeCourseGrade, computeCourseGradeExact, type CountedColumn, type CourseGrade, type PolicyCategory } from './policy.js';

type Executor = Pick<Database, 'select' | 'insert' | 'update'>;
type Reader = Pick<Database, 'select'>;
export type GradableType = 'quiz' | 'assignment';
export const GRADABLE: GradableType[] = ['quiz', 'assignment'];

/** Points available in the approved version of a quiz or assignment. */
export function approvedMaxPoints(activity: Pick<typeof activities.$inferSelect, 'type' | 'approvedConfig'>): number {
  if (activity.type === 'assignment') return rubricTotal(readAssignment(activity.approvedConfig).rubric);
  const questions = readSnapshotQuestions(activity.approvedConfig);
  const drawn = readSettings(activity.approvedConfig).questionsPerAttempt;
  // Pooled quizzes draw N questions of equal points (enforced on approval), so every attempt is worth N × points.
  if (drawn !== null && drawn < questions.length) return drawn * (questions[0]?.points ?? 0);
  return questions.reduce((total, question) => total + question.points, 0);
}

export type GradebookColumn = {
  activityId: string;
  title: string;
  type: GradableType;
  maxPoints: number;
  /** Visible to students (the activity and its section). */
  visible: boolean;
  /** Category of the published weighting policy, or null. */
  categoryId: string | null;
  sectionId: string;
};

/** The gradebook columns: approved quizzes and assignments of the course, in course order. */
export async function loadGradebookColumns(executor: Reader, courseId: string, categories: PolicyCategory[] | null): Promise<GradebookColumn[]> {
  const rows = await executor
    .select({
      id: activities.id,
      sectionId: activities.sectionId,
      type: activities.type,
      title: activities.approvedTitle,
      approvedConfig: activities.approvedConfig,
      isVisible: activities.isVisible,
      sectionVisible: sections.isVisible,
    })
    .from(activities)
    .innerJoin(sections, eq(sections.id, activities.sectionId))
    .where(and(eq(sections.courseId, courseId), inArray(activities.type, GRADABLE), isNotNull(activities.approvedConfig)))
    .orderBy(asc(sections.position), asc(activities.position), asc(activities.id));
  const categoryOf = new Map<string, string>();
  for (const category of categories ?? []) for (const activityId of category.activityIds) categoryOf.set(activityId, category.id);
  return rows.map((row) => ({
    activityId: row.id,
    title: row.title ?? '',
    type: row.type as GradableType,
    maxPoints: approvedMaxPoints(row),
    visible: row.isVisible && row.sectionVisible,
    categoryId: categoryOf.get(row.id) ?? null,
    sectionId: row.sectionId,
  }));
}

/** One student's work on one activity. */
export type StudentWork = { grade: GradeRecord | null; submitted: boolean; inProgress: boolean; submittedAt: Date | null; isLate: boolean };
export const workKey = (activityId: string, userId: string) => `${activityId}|${userId}`;

/**
 * Grades, assignment submissions and quiz attempts of some students for the given activities. With
 * `grades: false` (student-facing routes) grade rows are not loaded at all.
 */
export async function loadStudentWork(
  executor: Reader,
  courseId: string,
  activityIds: string[],
  userIds: string[],
  options: { grades?: boolean } = {},
): Promise<Map<string, StudentWork>> {
  const work = new Map<string, StudentWork>();
  if (!activityIds.length || !userIds.length) return work;
  const [gradeRows, submissionRows, attemptRows] = await Promise.all([
    options.grades === false
      ? Promise.resolve([] as GradeRecord[])
      : executor
          .select()
          .from(grades)
          .where(and(eq(grades.courseId, courseId), inArray(grades.userId, userIds), inArray(grades.activityId, activityIds))),
    executor
      .select({ activityId: assignmentSubmissions.activityId, userId: assignmentSubmissions.userId, submittedAt: assignmentSubmissions.submittedAt, isLate: assignmentSubmissions.isLate })
      .from(assignmentSubmissions)
      .where(and(eq(assignmentSubmissions.courseId, courseId), inArray(assignmentSubmissions.userId, userIds), inArray(assignmentSubmissions.activityId, activityIds))),
    executor
      .select({
        activityId: quizAttempts.activityId,
        userId: quizAttempts.userId,
        inProgress: sql<boolean>`bool_or(${quizAttempts.status} = 'in_progress')`,
        submitted: sql<boolean>`bool_or(${quizAttempts.status} = 'submitted')`,
        lastSubmittedAt: sql<string | null>`max(${quizAttempts.submittedAt})`,
      })
      .from(quizAttempts)
      .where(and(eq(quizAttempts.courseId, courseId), inArray(quizAttempts.userId, userIds), inArray(quizAttempts.activityId, activityIds)))
      .groupBy(quizAttempts.activityId, quizAttempts.userId),
  ]);
  const entry = (key: string) => {
    let value = work.get(key);
    if (!value) {
      value = { grade: null, submitted: false, inProgress: false, submittedAt: null, isLate: false };
      work.set(key, value);
    }
    return value;
  };
  for (const grade of gradeRows) entry(workKey(grade.activityId, grade.userId)).grade = grade;
  for (const row of submissionRows) Object.assign(entry(workKey(row.activityId, row.userId)), { submitted: true, submittedAt: row.submittedAt, isLate: row.isLate });
  for (const row of attemptRows) {
    const value = entry(workKey(row.activityId, row.userId));
    value.inProgress = row.inProgress;
    value.submitted = value.submitted || row.submitted;
    if (row.lastSubmittedAt) value.submittedAt = new Date(row.lastSubmittedAt);
  }
  return work;
}

const isCurrentRelease = (grade: GradeRecord) => grade.releasedRevision !== null && grade.releasedRevision === grade.revision;

/** Staff calculation: current grades (released or not). */
export function staffCourseGrade(columns: GradebookColumn[], categories: PolicyCategory[] | null, workFor: (activityId: string) => StudentWork | undefined): CourseGrade {
  const counted: CountedColumn[] = columns;
  return computeCourseGrade(counted, categories, (activityId) => {
    const grade = workFor(activityId)?.grade ?? null;
    return { counted: grade ? { points: grade.points, maxPoints: grade.maxPoints, final: isCurrentRelease(grade) } : null, exists: grade !== null };
  });
}

/** The release state of a grade: enough for the student calculation, without current (unreleased) points. */
export type ReleasedState = { revision: number; releasedRevision: number | null; releasedPoints: number | null; releasedMaxPoints: number | null };

/** Student calculation: released grades only (unreleased points never enter it). */
export function releasedCourseGrade(columns: GradebookColumn[], categories: PolicyCategory[] | null, stateFor: (activityId: string) => ReleasedState | undefined): CourseGrade {
  return releasedCourseGradeExact(columns, categories, stateFor).grade;
}

/** The released calculation with its exact (unrounded) fraction, for threshold checks such as certificates. */
export function releasedCourseGradeExact(columns: GradebookColumn[], categories: PolicyCategory[] | null, stateFor: (activityId: string) => ReleasedState | undefined) {
  return computeCourseGradeExact(columns, categories, (activityId) => {
    const state = stateFor(activityId);
    if (!state) return { counted: null, exists: false };
    if (state.releasedRevision === null || state.releasedPoints === null || state.releasedMaxPoints === null) return { counted: null, exists: true };
    return { counted: { points: state.releasedPoints, maxPoints: state.releasedMaxPoints, final: state.releasedRevision === state.revision }, exists: true };
  });
}

/** What students see after release: feedback and rubric scores of assignments (nothing else for quizzes). */
async function releaseDetails(tx: Executor, pending: GradeRecord[]): Promise<Map<string, ReleasedGradeDetail>> {
  const submissionIds = pending.flatMap((grade) => (grade.submissionId ? [grade.submissionId] : []));
  const scores = submissionIds.length
    ? await tx.select().from(assignmentCriterionScores).where(inArray(assignmentCriterionScores.submissionId, submissionIds))
    : [];
  const rubrics = submissionIds.length
    ? await tx.select({ id: assignmentSubmissions.id, rubric: assignmentSubmissions.rubric }).from(assignmentSubmissions).where(inArray(assignmentSubmissions.id, submissionIds))
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

/**
 * Copies the current grade of each (locked, still-unreleased-at-this-revision) row into its released
 * columns. Quizzes also record which attempt was released, so its saved passing threshold decides the
 * released pass/fail status. Callers lock the rows and re-check eligibility under the lock first.
 */
/**
 * Releases the given grades (each once per revision) and notifies each student whose grade became visible
 * (AP-026: one notification per student and activity, refreshed on a later release; never the grade itself).
 */
export async function releaseGradeRows(tx: Executor, releasedBy: string, pending: GradeRecord[], at: Date = new Date()): Promise<GradeRecord[]> {
  if (!pending.length) return [];
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
        releasedQuizAttemptId: grade.source === 'quiz' ? grade.quizAttemptId : null,
        releasedAt: sql`now()`,
        releasedByUserId: releasedBy,
      })
      .where(and(eq(grades.id, grade.id), sql`${grades.releasedRevision} IS DISTINCT FROM ${grade.revision}`, eq(grades.revision, grade.revision)))
      .returning();
    if (row) released.push(row);
  }
  if (released.length) {
    const activityIds = [...new Set(released.map((grade) => grade.activityId))];
    const titles = await tx
      .select({ id: activities.id, title: activities.title, courseCode: courses.code })
      .from(activities)
      .innerJoin(sections, eq(sections.id, activities.sectionId))
      .innerJoin(courses, eq(courses.id, sections.courseId))
      .where(inArray(activities.id, activityIds));
    const byId = new Map(titles.map((row) => [row.id, row]));
    for (const grade of released) {
      const activity = byId.get(grade.activityId);
      await notifyUsers(tx, [grade.userId], {
        type: 'grade_released',
        courseId: grade.courseId,
        entityId: grade.activityId,
        dedupeKey: `grade:${grade.activityId}`,
        data: { activityTitle: activity?.title ?? '', courseCode: activity?.courseCode ?? '' },
        at,
      });
    }
  }
  return released;
}

/** One audit entry per released grade (in addition to any summary entry of the caller). */
export async function auditReleasedGrades(tx: Executor, request: FastifyRequest, released: GradeRecord[], via: 'activity' | 'selection') {
  for (const grade of released) {
    await recordAudit(tx, request, {
      action: 'grade.released',
      entityType: 'grade',
      entityId: grade.id,
      before: null,
      after: { activityId: grade.activityId, userId: grade.userId, points: grade.releasedPoints, maxPoints: grade.releasedMaxPoints, revision: grade.releasedRevision, via },
    });
  }
}
