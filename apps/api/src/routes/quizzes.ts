import { and, asc, count, eq, max, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import { canInCourse, getCourseAccess, hasCoursePermission, type CourseAccess, type CoursePermission } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import type { Database } from '../db/client.js';
import { getPgError } from '../db/errors.js';
import { activities, enrollments, quizAttemptAnswers, quizAttempts, quizQuestions, sections, users } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';
import { decodeCursor, paginationQuerySchema, toPage, type PaginationQuery } from '../http/pagination.js';
import { isGradeReleased, syncQuizGrade } from '../grading/grades.js';
import { assertSectionOpen } from '../progress/model.js';
import { gradeResponse, normalizeResponse } from '../quizzes/grading.js';
import { buildQuestion, DEADLINE_GRACE_SECONDS, QUIZ_LIMITS, readSettings, readSnapshotQuestions, shuffle, type QuestionInput } from '../quizzes/model.js';
import {
  answersSaveSchema,
  attemptParamsSchema,
  attemptSubmitSchema,
  questionInputSchema,
  questionParamsSchema,
  quizAttemptResultSchema,
  quizParamsSchema,
  quizQuestionListSchema,
  quizQuestionSchema,
  quizResultPageSchema,
  resultParamsSchema,
  studentAttemptSchema,
  studentAttemptSummarySchema,
} from './quiz-schemas.js';

type QuizParams = { id: string; activityId: string };
type QuestionParams = QuizParams & { questionId: string };
type AttemptParams = { id: string; attemptId: string };
type ResultParams = QuizParams & { attemptId: string };
type AnswerInput = { questionId: string; selectedOptionIds: string[] };

type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;
type ActivityRecord = typeof activities.$inferSelect;
type QuestionRecord = typeof quizQuestions.$inferSelect;
type AttemptRecord = typeof quizAttempts.$inferSelect;

const notFound = (what: string) => new ApiProblem(404, 'NOT_FOUND', `${what} not found.`);
const forbidden = (detail = 'You do not have permission to perform this action.') => new ApiProblem(403, 'FORBIDDEN', detail);
const notInProgress = () => new ApiProblem(409, 'ATTEMPT_NOT_IN_PROGRESS', 'This attempt has already been submitted and can no longer change.');

/** Server-clock deadline check (with a short grace period); browser time is never used. */
const expiredSql = sql<boolean>`(${quizAttempts.deadlineAt} IS NOT NULL AND now() > ${quizAttempts.deadlineAt} + make_interval(secs => ${DEADLINE_GRACE_SECONDS}))`;

/** Staff view of a question, including its answer key. */
/**
 * Audit view of a question: only what students see while answering. Answer keys are never written to
 * the append-only audit log (attempts snapshot their own keys); updates record whether the key changed.
 */
function toAuditQuestion(question: QuestionRecord) {
  return {
    questionId: question.id,
    type: question.type,
    prompt: question.prompt,
    points: question.points,
    options: question.options.map(({ id, text }) => ({ id, text })),
  };
}

function sameAnswerKey(a: QuestionRecord['correctAnswer'], b: QuestionRecord['correctAnswer']) {
  const left = new Set(a.optionIds);
  return left.size === new Set(b.optionIds).size && b.optionIds.every((id) => left.has(id));
}

function toStaffQuestion(question: QuestionRecord) {
  const correct = new Set(question.correctAnswer.optionIds);
  return {
    id: question.id,
    position: question.position,
    type: question.type,
    prompt: question.prompt,
    points: question.points,
    options: question.options.map((option) => ({ id: option.id, text: option.text, isCorrect: correct.has(option.id) })),
  };
}

export const quizRoutes: FastifyPluginAsync = async (app) => {
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

  function requirePermission(access: CourseAccess, permission: CoursePermission, detail?: string) {
    if (!canInCourse(access, permission)) throw forbidden(detail);
  }

  /**
   * Taking a quiz depends on the caller's own course enrollment, never on the administrator
   * override: staff and administrators cannot create or answer attempts.
   */
  function requireStudent(access: CourseAccess, detail: string) {
    if (!hasCoursePermission(access.viewerRole, 'quiz.attempt')) throw forbidden(detail);
  }

  /** Loads a quiz of this course. Students only reach approved, visible quizzes in visible sections. */
  async function loadQuiz(executor: Executor, access: CourseAccess, activityId: string, lock = false): Promise<ActivityRecord> {
    const query = executor
      .select({ activity: activities, sectionVisible: sections.isVisible })
      .from(activities)
      .innerJoin(sections, eq(sections.id, activities.sectionId))
      .where(and(eq(activities.id, activityId), eq(sections.courseId, access.course.id), eq(activities.type, 'quiz')))
      .limit(1);
    const [row] = lock ? await query.for('update', { of: activities }) : await query;
    if (!row) throw notFound('Quiz');
    if (!canInCourse(access, 'content.viewUnapproved')) {
      const available = row.sectionVisible && row.activity.isVisible && row.activity.approvedConfig !== null;
      if (!available) throw notFound('Quiz');
      await assertSectionOpen(executor, access, row.activity.sectionId);
    }
    return row.activity;
  }

  /** Question edits are blocked during review; editing an approved quiz starts a hidden draft revision. */
  async function beginQuestionChange(tx: Executor, access: CourseAccess, activityId: string) {
    const quiz = await loadQuiz(tx, access, activityId, true);
    if (quiz.reviewStatus === 'submitted') {
      throw new ApiProblem(409, 'ACTIVITY_UNDER_REVIEW', 'Questions cannot change while the quiz is waiting for review.');
    }
    if (quiz.reviewStatus === 'approved') {
      await tx.update(activities).set({ reviewStatus: 'draft' }).where(eq(activities.id, quiz.id));
    }
    return quiz;
  }

  // ---- Question bank (staff) ----

  app.get<{ Params: QuizParams }>(
    '/courses/:id/activities/:activityId/questions',
    { ...authenticated, schema: { params: quizParamsSchema, response: { 200: quizQuestionListSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'content.viewUnapproved', 'Only course staff can see quiz questions and answer keys.');
      const quiz = await loadQuiz(db, access, request.params.activityId);
      const rows = await db.select().from(quizQuestions).where(eq(quizQuestions.activityId, quiz.id)).orderBy(asc(quizQuestions.position), asc(quizQuestions.id));
      return { items: rows.map(toStaffQuestion) };
    },
  );

  app.post<{ Params: QuizParams; Body: QuestionInput }>(
    '/courses/:id/activities/:activityId/questions',
    { ...authenticatedWrite, schema: { params: quizParamsSchema, body: questionInputSchema, response: { 201: quizQuestionSchema } } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'content.edit');
      const question = buildQuestion(request.body);
      const created = await db.transaction(async (tx) => {
        const quiz = await beginQuestionChange(tx, access, request.params.activityId);
        const [{ total, last } = { total: 0, last: null }] = await tx
          .select({ total: count(), last: max(quizQuestions.position) })
          .from(quizQuestions)
          .where(eq(quizQuestions.activityId, quiz.id));
        if (total >= QUIZ_LIMITS.questions) {
          throw new ApiProblem(409, 'QUIZ_QUESTION_LIMIT', `A quiz can have at most ${QUIZ_LIMITS.questions} questions.`);
        }
        const [row] = await tx.insert(quizQuestions).values({ activityId: quiz.id, position: (last ?? -1) + 1, ...question }).returning();
        if (!row) throw new Error('Question was not created');
        await recordAudit(tx, request, {
          action: 'quiz.question_added',
          entityType: 'activity',
          entityId: quiz.id,
          before: null,
          after: toAuditQuestion(row),
        });
        return row;
      });
      return reply.code(201).send(toStaffQuestion(created));
    },
  );

  app.put<{ Params: QuestionParams; Body: QuestionInput }>(
    '/courses/:id/activities/:activityId/questions/:questionId',
    { ...authenticatedWrite, schema: { params: questionParamsSchema, body: questionInputSchema, response: { 200: quizQuestionSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'content.edit');
      const question = buildQuestion(request.body);
      const updated = await db.transaction(async (tx) => {
        const quiz = await beginQuestionChange(tx, access, request.params.activityId);
        const [current] = await tx
          .select()
          .from(quizQuestions)
          .where(and(eq(quizQuestions.id, request.params.questionId), eq(quizQuestions.activityId, quiz.id)));
        if (!current) throw notFound('Question');
        const [row] = await tx.update(quizQuestions).set(question).where(eq(quizQuestions.id, current.id)).returning();
        if (!row) throw new Error('Question was not updated');
        await recordAudit(tx, request, {
          action: 'quiz.question_updated',
          entityType: 'activity',
          entityId: quiz.id,
          before: toAuditQuestion(current),
          after: { ...toAuditQuestion(row), answerKeyChanged: !sameAnswerKey(current.correctAnswer, row.correctAnswer) },
        });
        return row;
      });
      return toStaffQuestion(updated);
    },
  );

  app.delete<{ Params: QuestionParams }>(
    '/courses/:id/activities/:activityId/questions/:questionId',
    { ...authenticatedWrite, schema: { params: questionParamsSchema } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'content.edit');
      await db.transaction(async (tx) => {
        const quiz = await beginQuestionChange(tx, access, request.params.activityId);
        const [removed] = await tx
          .delete(quizQuestions)
          .where(and(eq(quizQuestions.id, request.params.questionId), eq(quizQuestions.activityId, quiz.id)))
          .returning();
        if (!removed) throw notFound('Question');
        await recordAudit(tx, request, {
          action: 'quiz.question_removed',
          entityType: 'activity',
          entityId: quiz.id,
          before: toAuditQuestion(removed),
          after: null,
        });
      });
      return reply.code(204).send();
    },
  );

  // ---- Attempts (students) ----

  /** Grades every answer on the server and closes the attempt. Browser-supplied scores never exist. */
  async function finalizeAttempt(tx: Executor, request: FastifyRequest, attempt: AttemptRecord, closedByTimeLimit: boolean) {
    const answers = await tx.select().from(quizAttemptAnswers).where(eq(quizAttemptAnswers.attemptId, attempt.id));
    let score = 0;
    for (const answer of answers) {
      const { isCorrect, awardedPoints } = gradeResponse(answer, answer.response);
      score += awardedPoints;
      await tx.update(quizAttemptAnswers).set({ isCorrect, awardedPoints }).where(eq(quizAttemptAnswers.id, answer.id));
    }
    const [row] = await tx
      .update(quizAttempts)
      .set({ status: 'submitted', submittedAt: sql`now()`, gradedAt: sql`now()`, score, closedByTimeLimit })
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

  /** Closes the caller's expired in-progress attempts of a quiz (grading only answers saved in time). */
  async function closeExpiredAttempts(tx: Executor, request: FastifyRequest, activityId: string, userId?: string) {
    const expired = await tx
      .select()
      .from(quizAttempts)
      .where(and(eq(quizAttempts.activityId, activityId), eq(quizAttempts.status, 'in_progress'), userId ? eq(quizAttempts.userId, userId) : undefined, expiredSql))
      .for('update');
    for (const attempt of expired) await finalizeAttempt(tx, request, attempt, true);
  }

  /** The student's view of an attempt: questions as presented and their own selections; never keys or scores. */
  async function studentAttemptView(executor: Executor, attempt: AttemptRecord) {
    const answers = await executor
      .select()
      .from(quizAttemptAnswers)
      .where(eq(quizAttemptAnswers.attemptId, attempt.id))
      .orderBy(asc(quizAttemptAnswers.position));
    return {
      id: attempt.id,
      activityId: attempt.activityId,
      attemptNumber: attempt.attemptNumber,
      attemptLimit: attempt.attemptLimit,
      status: attempt.status,
      startedAt: attempt.startedAt,
      deadlineAt: attempt.deadlineAt,
      submittedAt: attempt.submittedAt,
      closedByTimeLimit: attempt.closedByTimeLimit,
      // Release only reveals the released grade (via /grades/mine); per-attempt scores and keys stay hidden.
      resultsReleased: await isGradeReleased(executor, attempt.activityId, attempt.userId),
      questions: answers.map((answer) => ({
        questionId: answer.questionId,
        position: answer.position,
        type: answer.type,
        prompt: answer.prompt,
        points: answer.points,
        options: answer.options.map(({ id, text }) => ({ id, text })),
        selectedOptionIds: answer.response?.optionIds ?? [],
      })),
    };
  }

  async function lockOwnAttempt(tx: Executor, access: CourseAccess, userId: string, attemptId: string) {
    const [row] = await tx
      .select({ attempt: quizAttempts, expired: expiredSql })
      .from(quizAttempts)
      .where(and(eq(quizAttempts.id, attemptId), eq(quizAttempts.courseId, access.course.id), eq(quizAttempts.userId, userId)))
      .for('update');
    if (!row) throw notFound('Attempt');
    return row;
  }

  async function applyAnswers(tx: Executor, attemptId: string, answers: AnswerInput[]) {
    if (!answers.length) return;
    const rows = await tx.select().from(quizAttemptAnswers).where(eq(quizAttemptAnswers.attemptId, attemptId));
    const byQuestion = new Map(rows.map((row) => [row.questionId, row]));
    for (const answer of answers) {
      const row = byQuestion.get(answer.questionId);
      if (!row) throw new ApiProblem(422, 'INVALID_ANSWER', 'An answer refers to a question that is not part of this attempt.');
      const response = normalizeResponse(row, answer.selectedOptionIds);
      await tx.update(quizAttemptAnswers).set({ response, answeredAt: sql`now()` }).where(eq(quizAttemptAnswers.id, row.id));
    }
  }

  app.post<{ Params: QuizParams }>(
    '/courses/:id/activities/:activityId/attempts',
    { ...authenticatedWrite, schema: { params: quizParamsSchema, response: { 200: studentAttemptSchema, 201: studentAttemptSchema } } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      requireStudent(access, 'Only enrolled students can take quizzes.');
      const { user } = getAuth(request);

      const result = await db
        .transaction(async (tx) => {
          const quiz = await loadQuiz(tx, access, request.params.activityId);
          // Serializes attempt creation per student and course, so concurrent requests cannot bypass limits.
          const [enrollment] = await tx
            .select({ id: enrollments.id })
            .from(enrollments)
            .where(and(eq(enrollments.courseId, access.course.id), eq(enrollments.userId, user.id), eq(enrollments.status, 'active')))
            .for('update');
          if (!enrollment) throw notFound('Quiz');

          await closeExpiredAttempts(tx, request, quiz.id, user.id);
          const [active] = await tx
            .select()
            .from(quizAttempts)
            .where(and(eq(quizAttempts.activityId, quiz.id), eq(quizAttempts.userId, user.id), eq(quizAttempts.status, 'in_progress')));
          if (active) return { attempt: active, created: false };

          const settings = readSettings(quiz.approvedConfig);
          const questions = readSnapshotQuestions(quiz.approvedConfig);
          if (!questions.length || !quiz.approvedAt) throw notFound('Quiz');
          const [{ used } = { used: 0 }] = await tx
            .select({ used: count() })
            .from(quizAttempts)
            .where(and(eq(quizAttempts.activityId, quiz.id), eq(quizAttempts.userId, user.id)));
          if (used >= settings.attemptLimit) {
            throw new ApiProblem(409, 'ATTEMPT_LIMIT_REACHED', `You have used all ${settings.attemptLimit} attempt(s) for this quiz.`);
          }

          const ordered = settings.shuffleQuestions ? shuffle(questions) : questions;
          const [attempt] = await tx
            .insert(quizAttempts)
            .values({
              activityId: quiz.id,
              courseId: access.course.id,
              enrollmentId: enrollment.id,
              userId: user.id,
              attemptNumber: used + 1,
              attemptLimit: settings.attemptLimit,
              quizVersionApprovedAt: quiz.approvedAt,
              deadlineAt: settings.timeLimitMinutes ? sql`now() + make_interval(mins => ${settings.timeLimitMinutes})` : null,
              maxScore: questions.reduce((total, question) => total + question.points, 0),
            })
            .returning();
          if (!attempt) throw new Error('Attempt was not created');
          // The presented order of questions and options is stored, so it stays stable across reloads.
          await tx.insert(quizAttemptAnswers).values(
            ordered.map((question, position) => ({
              attemptId: attempt.id,
              questionId: question.id,
              position,
              type: question.type,
              prompt: question.prompt,
              options: settings.shuffleOptions && question.type !== 'true_false' ? shuffle(question.options) : question.options,
              correctAnswer: question.correctAnswer,
              points: question.points,
            })),
          );
          await recordAudit(tx, request, {
            action: 'quiz.attempt_started',
            entityType: 'quiz_attempt',
            entityId: attempt.id,
            before: null,
            after: { activityId: quiz.id, attemptNumber: attempt.attemptNumber, attemptLimit: attempt.attemptLimit, deadlineAt: attempt.deadlineAt },
          });
          return { attempt, created: true };
        })
        .catch((error: unknown) => {
          // Database backstops for races: one active attempt and the attempt limit.
          const pg = getPgError(error);
          if (pg?.code === '23505') throw new ApiProblem(409, 'ATTEMPT_CONFLICT', 'Another attempt was started at the same time. Reload and try again.');
          if (pg?.code === '23514' && pg.constraint === 'quiz_attempts_attempt_number_check') {
            throw new ApiProblem(409, 'ATTEMPT_LIMIT_REACHED', 'You have used all attempts for this quiz.');
          }
          throw error;
        });

      return reply.code(result.created ? 201 : 200).send(await studentAttemptView(db, result.attempt));
    },
  );

  app.get<{ Params: QuizParams }>(
    '/courses/:id/activities/:activityId/attempts/mine',
    { ...authenticated, schema: { params: quizParamsSchema, response: { 200: studentAttemptSummarySchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireStudent(access, 'Only enrolled students take quizzes.');
      const { user } = getAuth(request);
      return db.transaction(async (tx) => {
        const quiz = await loadQuiz(tx, access, request.params.activityId);
        await closeExpiredAttempts(tx, request, quiz.id, user.id);
        const attempts = await tx
          .select()
          .from(quizAttempts)
          .where(and(eq(quizAttempts.activityId, quiz.id), eq(quizAttempts.userId, user.id)))
          .orderBy(asc(quizAttempts.attemptNumber));
        const settings = readSettings(quiz.approvedConfig);
        return {
          attemptLimit: settings.attemptLimit,
          attemptsUsed: attempts.length,
          timeLimitMinutes: settings.timeLimitMinutes,
          activeAttemptId: attempts.find((attempt) => attempt.status === 'in_progress')?.id ?? null,
          gradeReleased: await isGradeReleased(tx, quiz.id, user.id),
          items: attempts.map((attempt) => ({
            id: attempt.id,
            attemptNumber: attempt.attemptNumber,
            status: attempt.status,
            startedAt: attempt.startedAt,
            deadlineAt: attempt.deadlineAt,
            submittedAt: attempt.submittedAt,
            closedByTimeLimit: attempt.closedByTimeLimit,
          })),
        };
      });
    },
  );

  app.get<{ Params: AttemptParams }>(
    '/courses/:id/attempts/:attemptId',
    { ...authenticated, schema: { params: attemptParamsSchema, response: { 200: studentAttemptSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireStudent(access, 'Only students can open their own attempts.');
      const { user } = getAuth(request);
      return db.transaction(async (tx) => {
        let { attempt, expired } = await lockOwnAttempt(tx, access, user.id, request.params.attemptId);
        if (attempt.status === 'in_progress' && expired) attempt = await finalizeAttempt(tx, request, attempt, true);
        return studentAttemptView(tx, attempt);
      });
    },
  );

  app.put<{ Params: AttemptParams; Body: { answers: AnswerInput[] } }>(
    '/courses/:id/attempts/:attemptId/answers',
    { ...authenticatedWrite, schema: { params: attemptParamsSchema, body: answersSaveSchema, response: { 200: studentAttemptSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireStudent(access, 'Only students can answer quizzes.');
      const { user } = getAuth(request);
      const outcome = await db.transaction(async (tx) => {
        const { attempt, expired } = await lockOwnAttempt(tx, access, user.id, request.params.attemptId);
        if (attempt.status !== 'in_progress') throw notInProgress();
        if (expired) {
          // Time is up: close the attempt with the answers saved in time; the new answers are not accepted.
          await finalizeAttempt(tx, request, attempt, true);
          return { expired: true as const };
        }
        await applyAnswers(tx, attempt.id, request.body.answers);
        return { expired: false as const, view: await studentAttemptView(tx, attempt) };
      });
      if (outcome.expired) {
        throw new ApiProblem(409, 'ATTEMPT_EXPIRED', 'The time limit has passed. Your attempt was submitted with the answers saved in time.');
      }
      return outcome.view;
    },
  );

  app.post<{ Params: AttemptParams; Body: { answers?: AnswerInput[] } }>(
    '/courses/:id/attempts/:attemptId/submit',
    { ...authenticatedWrite, schema: { params: attemptParamsSchema, body: attemptSubmitSchema, response: { 200: studentAttemptSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requireStudent(access, 'Only students can submit quiz attempts.');
      const { user } = getAuth(request);
      return db.transaction(async (tx) => {
        const { attempt, expired } = await lockOwnAttempt(tx, access, user.id, request.params.attemptId);
        if (attempt.status !== 'in_progress') throw notInProgress();
        if (!expired) await applyAnswers(tx, attempt.id, request.body.answers ?? []);
        const submitted = await finalizeAttempt(tx, request, attempt, expired);
        return studentAttemptView(tx, submitted);
      });
    },
  );

  // ---- Results (staff) ----

  const studentColumns = { id: users.id, email: users.email, givenName: users.givenName, familyName: users.familyName };
  const toResultCore = (attempt: AttemptRecord, student: { id: string; email: string; givenName: string; familyName: string }) => ({
    attemptId: attempt.id,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: attempt.startedAt,
    deadlineAt: attempt.deadlineAt,
    submittedAt: attempt.submittedAt,
    closedByTimeLimit: attempt.closedByTimeLimit,
    score: attempt.score,
    maxScore: attempt.maxScore,
    student,
  });

  app.get<{ Params: QuizParams; Querystring: PaginationQuery }>(
    '/courses/:id/activities/:activityId/results',
    { ...authenticated, schema: { params: quizParamsSchema, querystring: paginationQuerySchema, response: { 200: quizResultPageSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'quiz.viewResults', 'You cannot view quiz results in this course.');
      const { limit } = request.query;
      const after = decodeCursor(request.query.cursor, 'string');
      const sortKey = sql<string>`lower(${users.email}) || '|' || lpad(${quizAttempts.attemptNumber}::text, 4, '0')`;
      return db.transaction(async (tx) => {
        const quiz = await loadQuiz(tx, access, request.params.activityId);
        await closeExpiredAttempts(tx, request, quiz.id);
        const rows = await tx
          .select({ attempt: quizAttempts, student: studentColumns, sortKey })
          .from(quizAttempts)
          .innerJoin(users, eq(users.id, quizAttempts.userId))
          .where(
            and(
              eq(quizAttempts.activityId, quiz.id),
              after ? sql`(${sortKey}, ${quizAttempts.id}) > (${after.key}, ${after.id}::uuid)` : undefined,
            ),
          )
          .orderBy(asc(sortKey), asc(quizAttempts.id))
          .limit(limit + 1);
        const page = toPage(rows, limit, (row) => [row.sortKey, row.attempt.id]);
        return { items: page.items.map((row) => toResultCore(row.attempt, row.student)), nextCursor: page.nextCursor };
      });
    },
  );

  app.get<{ Params: ResultParams }>(
    '/courses/:id/activities/:activityId/results/:attemptId',
    { ...authenticated, schema: { params: resultParamsSchema, response: { 200: quizAttemptResultSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'quiz.viewResults', 'You cannot view quiz results in this course.');
      return db.transaction(async (tx) => {
      const quiz = await loadQuiz(tx, access, request.params.activityId);
      await closeExpiredAttempts(tx, request, quiz.id);
      const [row] = await tx
        .select({ attempt: quizAttempts, student: studentColumns })
        .from(quizAttempts)
        .innerJoin(users, eq(users.id, quizAttempts.userId))
        .where(and(eq(quizAttempts.id, request.params.attemptId), eq(quizAttempts.activityId, quiz.id), eq(quizAttempts.courseId, access.course.id)));
      if (!row) throw notFound('Attempt');
      const answers = await tx
        .select()
        .from(quizAttemptAnswers)
        .where(eq(quizAttemptAnswers.attemptId, row.attempt.id))
        .orderBy(asc(quizAttemptAnswers.position));
      return {
        ...toResultCore(row.attempt, row.student),
        questions: answers.map((answer) => {
          const correct = new Set(answer.correctAnswer.optionIds);
          return {
            questionId: answer.questionId,
            position: answer.position,
            type: answer.type,
            prompt: answer.prompt,
            points: answer.points,
            options: answer.options.map((option) => ({ id: option.id, text: option.text, isCorrect: correct.has(option.id) })),
            selectedOptionIds: answer.response?.optionIds ?? [],
            awardedPoints: answer.awardedPoints,
            isCorrect: answer.isCorrect,
          };
        }),
      };
      });
    },
  );
};
