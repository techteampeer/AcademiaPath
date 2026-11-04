import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import type { Database } from '../db/client.js';
import { grades, quizAttempts } from '../db/schema/index.js';
import { toScale20 } from './scale.js';

type Executor = Pick<Database, 'select' | 'insert' | 'update'>;
export type GradeRecord = typeof grades.$inferSelect;
export type GradeStatus = 'not_submitted' | 'needs_grading' | 'unreleased' | 'released' | 'changed_since_release';

/**
 * Only the columns a student may ever see. Student-facing queries select exactly these, so current
 * (unreleased) points, feedback or rubric scores are never loaded for a student response.
 */
export const releasedGradeColumns = {
  activityId: grades.activityId,
  releasedRevision: grades.releasedRevision,
  releasedPoints: grades.releasedPoints,
  releasedMaxPoints: grades.releasedMaxPoints,
  releasedDetail: grades.releasedDetail,
  releasedAt: grades.releasedAt,
};
export type ReleasedGradeRow = { [K in keyof typeof releasedGradeColumns]: GradeRecord[K] };

/** The grade exactly as released to the student, or null while nothing has been released. */
export function releasedGradeView(row: ReleasedGradeRow | null | undefined) {
  if (!row || row.releasedRevision === null || row.releasedPoints === null || row.releasedMaxPoints === null || !row.releasedAt) return null;
  return {
    points: row.releasedPoints,
    maxPoints: row.releasedMaxPoints,
    grade20: toScale20(row.releasedPoints, row.releasedMaxPoints),
    releasedAt: row.releasedAt,
    feedback: row.releasedDetail?.feedback ?? null,
    criteria: row.releasedDetail?.criteria ?? [],
  };
}

/** Staff status of one gradebook entry. */
export function gradeStatus(grade: GradeRecord | null | undefined, submitted: boolean): GradeStatus {
  if (!grade) return submitted ? 'needs_grading' : 'not_submitted';
  if (grade.releasedRevision === null) return 'unreleased';
  return grade.releasedRevision === grade.revision ? 'released' : 'changed_since_release';
}

/** Current grade for staff. */
export function staffGradeView(grade: GradeRecord | null | undefined) {
  if (!grade) return null;
  return {
    points: grade.points,
    maxPoints: grade.maxPoints,
    grade20: toScale20(grade.points, grade.maxPoints),
    gradedAt: grade.gradedAt,
    releasedAt: grade.releasedAt,
  };
}

/**
 * Quiz gradebook policy: the student's best submitted attempt counts, once. "Best" is the highest
 * score / max_score (then the highest score, then the earliest submission), so attempts against
 * different approved versions compare fairly. Runs inside the transaction that graded an attempt;
 * the grade's revision increases whenever the counted attempt or its score changes.
 */
export async function syncQuizGrade(
  tx: Executor,
  request: FastifyRequest,
  attempt: { activityId: string; userId: string; courseId: string; enrollmentId: string },
) {
  const [best] = await tx
    .select({ id: quizAttempts.id, score: quizAttempts.score, maxScore: quizAttempts.maxScore })
    .from(quizAttempts)
    .where(and(eq(quizAttempts.activityId, attempt.activityId), eq(quizAttempts.userId, attempt.userId), eq(quizAttempts.status, 'submitted')))
    .orderBy(
      desc(sql`${quizAttempts.score}::numeric / ${quizAttempts.maxScore}`),
      desc(quizAttempts.score),
      asc(quizAttempts.submittedAt),
      asc(quizAttempts.id),
    )
    .limit(1);
  if (!best || best.score === null) return;

  const [current] = await tx
    .select()
    .from(grades)
    .where(and(eq(grades.activityId, attempt.activityId), eq(grades.userId, attempt.userId)))
    .for('update');
  if (current && current.quizAttemptId === best.id && current.points === best.score && current.maxPoints === best.maxScore) return;

  const [row] = await tx
    .insert(grades)
    .values({
      courseId: attempt.courseId,
      activityId: attempt.activityId,
      userId: attempt.userId,
      enrollmentId: attempt.enrollmentId,
      source: 'quiz',
      quizAttemptId: best.id,
      points: best.score,
      maxPoints: best.maxScore,
      gradedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: [grades.activityId, grades.userId],
      set: { quizAttemptId: best.id, points: best.score, maxPoints: best.maxScore, gradedAt: sql`now()`, revision: sql`${grades.revision} + 1` },
    })
    .returning();
  if (!row) throw new Error('Quiz grade was not recorded');
  await recordAudit(tx, request, {
    action: 'grade.recorded',
    entityType: 'grade',
    entityId: row.id,
    before: current ? { points: current.points, maxPoints: current.maxPoints, quizAttemptId: current.quizAttemptId, revision: current.revision } : null,
    after: {
      source: 'quiz',
      activityId: row.activityId,
      userId: row.userId,
      points: row.points,
      maxPoints: row.maxPoints,
      quizAttemptId: row.quizAttemptId,
      revision: row.revision,
      gradedBy: 'server',
    },
  });
}

/** Whether this student's grade for an activity has been released (used by the quiz endpoints). */
export async function isGradeReleased(executor: Pick<Database, 'select'>, activityId: string, userId: string): Promise<boolean> {
  const [row] = await executor
    .select({ releasedRevision: grades.releasedRevision })
    .from(grades)
    .where(and(eq(grades.activityId, activityId), eq(grades.userId, userId)));
  return row?.releasedRevision != null;
}
