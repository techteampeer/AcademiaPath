import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './columns.js';
import { activities } from './content.js';
import { courses, enrollments } from './courses.js';
import { quizAttemptStatusEnum, quizQuestionTypeEnum } from './enums.js';
import { users } from './users.js';

/** An answer option as shown to students. Correctness lives only in the answer key. */
export type QuizOption = { id: string; text: string };
/** Answer key or student response for choice-based questions; future question types can add other shapes. */
export type QuizAnswer = { optionIds: string[] };

/**
 * Working question bank of a quiz activity. Staff edit these rows; students only ever see the
 * questions published (snapshotted) into the activity's approved version.
 */
export const quizQuestions = pgTable(
  'quiz_questions',
  {
    id: primaryId(),
    activityId: uuid('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    type: quizQuestionTypeEnum('type').notNull(),
    prompt: text('prompt').notNull(),
    options: jsonb('options').$type<QuizOption[]>().notNull(),
    /** Answer key. Never sent to students. */
    correctAnswer: jsonb('correct_answer').$type<QuizAnswer>().notNull(),
    points: integer('points').notNull(),
    ...timestamps(),
  },
  (t) => [
    index('quiz_questions_activity_id_position_idx').on(t.activityId, t.position),
    check('quiz_questions_position_check', sql`${t.position} >= 0`),
    check('quiz_questions_points_check', sql`${t.points} BETWEEN 1 AND 100`),
    check('quiz_questions_options_check', sql`jsonb_typeof(${t.options}) = 'array'`),
    check('quiz_questions_correct_answer_check', sql`jsonb_typeof(${t.correctAnswer}) = 'object'`),
  ],
);

/**
 * One student attempt at the approved version of a quiz. The attempt limit and the one-active-
 * attempt rule are enforced by constraints; submitted attempts are immutable (database triggers).
 */
export const quizAttempts = pgTable(
  'quiz_attempts',
  {
    id: primaryId(),
    activityId: uuid('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'restrict' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    enrollmentId: uuid('enrollment_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    attemptNumber: integer('attempt_number').notNull(),
    /** Attempt limit of the approved quiz version the attempt was started from. */
    attemptLimit: integer('attempt_limit').notNull(),
    /** Approval time of the quiz version used; identifies that version. */
    quizVersionApprovedAt: timestamp('quiz_version_approved_at', { withTimezone: true }).notNull(),
    status: quizAttemptStatusEnum('status').notNull().default('in_progress'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** Server-computed deadline; null when the quiz has no time limit. */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    closedByTimeLimit: boolean('closed_by_time_limit').notNull().default(false),
    /** Server-computed result; not released to students yet. */
    score: integer('score'),
    maxScore: integer('max_score').notNull(),
    gradedAt: timestamp('graded_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('quiz_attempts_activity_user_number_unique').on(t.activityId, t.userId, t.attemptNumber),
    uniqueIndex('quiz_attempts_one_in_progress_idx')
      .on(t.activityId, t.userId)
      .where(sql`${t.status} = 'in_progress'`),
    index('quiz_attempts_user_id_idx').on(t.userId),
    index('quiz_attempts_course_id_idx').on(t.courseId),
    // The attempt belongs to the student's own enrollment in this course.
    foreignKey({
      name: 'quiz_attempts_enrollment_fk',
      columns: [t.enrollmentId, t.courseId, t.userId],
      foreignColumns: [enrollments.id, enrollments.courseId, enrollments.userId],
    }).onDelete('restrict'),
    check('quiz_attempts_attempt_number_check', sql`${t.attemptNumber} >= 1 AND ${t.attemptNumber} <= ${t.attemptLimit}`),
    check(
      'quiz_attempts_status_check',
      sql`(${t.status} = 'in_progress' AND ${t.submittedAt} IS NULL AND ${t.score} IS NULL AND ${t.gradedAt} IS NULL) OR (${t.status} = 'submitted' AND ${t.submittedAt} IS NOT NULL AND ${t.score} IS NOT NULL AND ${t.gradedAt} IS NOT NULL)`,
    ),
    check('quiz_attempts_score_check', sql`${t.maxScore} >= 0 AND (${t.score} IS NULL OR ${t.score} BETWEEN 0 AND ${t.maxScore})`),
    check('quiz_attempts_deadline_check', sql`${t.deadlineAt} IS NULL OR ${t.deadlineAt} > ${t.startedAt}`),
  ],
);

/**
 * A question exactly as presented in one attempt (immutable snapshot, including the order of
 * options), with the student's response and the server-computed grading.
 */
export const quizAttemptAnswers = pgTable(
  'quiz_attempt_answers',
  {
    id: primaryId(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => quizAttempts.id, { onDelete: 'cascade' }),
    /** Stable identity of the source question (no foreign key: questions may later change). */
    questionId: uuid('question_id').notNull(),
    position: integer('position').notNull(),
    type: quizQuestionTypeEnum('type').notNull(),
    prompt: text('prompt').notNull(),
    options: jsonb('options').$type<QuizOption[]>().notNull(),
    correctAnswer: jsonb('correct_answer').$type<QuizAnswer>().notNull(),
    points: integer('points').notNull(),
    response: jsonb('response').$type<QuizAnswer>(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    awardedPoints: integer('awarded_points'),
    isCorrect: boolean('is_correct'),
    ...timestamps(),
  },
  (t) => [
    unique('quiz_attempt_answers_attempt_question_unique').on(t.attemptId, t.questionId),
    unique('quiz_attempt_answers_attempt_position_unique').on(t.attemptId, t.position),
    check(
      'quiz_attempt_answers_points_check',
      sql`${t.points} BETWEEN 1 AND 100 AND (${t.awardedPoints} IS NULL OR ${t.awardedPoints} BETWEEN 0 AND ${t.points})`,
    ),
  ],
);
