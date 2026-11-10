import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import type { Database } from '../db/client.js';
import { quizAttemptAnswers, quizAttempts } from '../db/schema/index.js';
import { syncQuizGrade } from '../grading/grades.js';
import { ApiProblem } from '../http/errors.js';
import { gradeResponse } from './grading.js';

type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;
export type AttemptRecord = typeof quizAttempts.$inferSelect;

export const notInProgress = () => new ApiProblem(409, 'ATTEMPT_NOT_IN_PROGRESS', 'This attempt has already been submitted and can no longer change.');

/**
 * Whether the answer window of an attempt has closed at the server instant `at` (see the timer semantics in
 * quizzes/model.ts): strictly after the deadline. The deadline instant itself still accepts answers.
 */
export function isPastDeadline(attempt: Pick<AttemptRecord, 'deadlineAt'>, at: Date): boolean {
  return attempt.deadlineAt !== null && at.getTime() > attempt.deadlineAt.getTime();
}

/** The same rule in SQL, for finding expired attempts in bulk (the instant comes from the API server clock). */
const pastDeadlineSql = (at: Date) => sql<boolean>`(${quizAttempts.deadlineAt} IS NOT NULL AND ${quizAttempts.deadlineAt} < ${at.toISOString()}::timestamptz)`;

/**
 * Grades every saved answer on the server and closes the attempt. Browser-supplied scores never exist.
 * The update only succeeds while the attempt is still in progress, so finalization happens exactly once.
 * An attempt closed by its time limit is recorded as submitted at its deadline (when its window ended).
 */
export async function finalizeAttempt(tx: Executor, request: FastifyRequest, attempt: AttemptRecord, closedByTimeLimit: boolean, at = request.server.now()) {
  const answers = await tx.select().from(quizAttemptAnswers).where(eq(quizAttemptAnswers.attemptId, attempt.id));
  let score = 0;
  for (const answer of answers) {
    const { isCorrect, awardedPoints } = gradeResponse(answer, answer.response);
    score += awardedPoints;
    await tx.update(quizAttemptAnswers).set({ isCorrect, awardedPoints }).where(eq(quizAttemptAnswers.id, answer.id));
  }
  const submittedAt = closedByTimeLimit && attempt.deadlineAt ? attempt.deadlineAt : at;
  const [row] = await tx
    .update(quizAttempts)
    .set({ status: 'submitted', submittedAt, gradedAt: at, score, closedByTimeLimit })
    .where(and(eq(quizAttempts.id, attempt.id), eq(quizAttempts.status, 'in_progress')))
    .returning();
  if (!row) throw notInProgress();
  const answered = answers.filter((answer) => (answer.response?.optionIds.length ?? 0) > 0).length;
  await recordAudit(tx, request, {
    action: 'quiz.attempt_submitted',
    entityType: 'quiz_attempt',
    entityId: row.id,
    before: { status: 'in_progress' },
    after: { status: row.status, closedByTimeLimit, answeredQuestions: answered, totalQuestions: answers.length },
  });
  await recordAudit(tx, request, {
    action: 'quiz.attempt_graded',
    entityType: 'quiz_attempt',
    entityId: row.id,
    before: null,
    after: { activityId: row.activityId, userId: row.userId, score: row.score, maxScore: row.maxScore, gradedBy: 'server' },
  });
  // The gradebook keeps one quiz grade per student: the best submitted attempt (never double-counted).
  await syncQuizGrade(tx, request, row);
  return row;
}

/**
 * Request-driven finalization (AP-022): closes expired in-progress attempts in a scope (a quiz, a course,
 * a student, or a combination), grading only the answers saved before the deadline. No background job is
 * needed: every route that reports attempts, grades or progress calls this first. Rows are locked in id
 * order and re-checked under the lock, so concurrent callers finalize each attempt exactly once.
 */
export async function closeExpiredAttempts(tx: Executor, request: FastifyRequest, scope: { activityId?: string; courseId?: string; userId?: string }) {
  const expired = await tx
    .select()
    .from(quizAttempts)
    .where(
      and(
        eq(quizAttempts.status, 'in_progress'),
        scope.activityId ? eq(quizAttempts.activityId, scope.activityId) : undefined,
        scope.courseId ? eq(quizAttempts.courseId, scope.courseId) : undefined,
        scope.userId ? eq(quizAttempts.userId, scope.userId) : undefined,
        pastDeadlineSql(request.server.now()),
      ),
    )
    .orderBy(asc(quizAttempts.id))
    .for('update');
  for (const attempt of expired) await finalizeAttempt(tx, request, attempt, true);
  return expired.length;
}
