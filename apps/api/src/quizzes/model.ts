import { randomInt, randomUUID } from 'node:crypto';
import type { ActivityConfig, QuizAnswer, QuizOption, QuizQuestionType } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';

export const QUIZ_LIMITS = {
  instructions: 5000,
  attemptLimit: 10,
  timeLimitMinutes: 300,
  questions: 100,
  prompt: 2000,
  optionText: 500,
  minOptions: 2,
  maxOptions: 10,
  points: 100,
} as const;

/*
 * Quiz timer semantics (AP-023; replaces the AP-022 10-second grace period):
 * - The answer window of a timed attempt is [startedAt, deadlineAt], both set by the API server clock
 *   (`app.now()`); the browser clock is never used. The deadline instant itself is inside the window.
 * - An answer is accepted only if the server clock, read after the attempt row is locked, is at or before
 *   deadlineAt; the answer is stored with that instant (answered_at). One millisecond later it is refused.
 * - There is no grace period: nothing extends the answer window. Network latency is the browser's concern
 *   (it saves answers as they change); a late save or submit returns ATTEMPT_EXPIRED / closes the attempt.
 * - An attempt past its deadline is finalized by the first request that touches it (idempotently), graded
 *   only with answers saved in time, marked closedByTimeLimit, and recorded as submitted at its deadline.
 */

export type QuizSettings = {
  instructions: string | null;
  attemptLimit: number;
  timeLimitMinutes: number | null;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  /** AP-022: minimum percentage (1–100) to pass; null = no passing threshold (default). */
  passingScorePercent: number | null;
  /** AP-022: students may review per-question correctness once their grade is released (never the key). */
  showFeedback: boolean;
  /** AP-022: questions drawn at random from the approved question pool for each attempt; null = all (default). */
  questionsPerAttempt: number | null;
};

export type QuizSettingsInput = {
  title: string;
  instructions?: string;
  attemptLimit: number;
  timeLimitMinutes?: number | null;
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
  passingScorePercent?: number | null;
  showFeedback?: boolean;
  questionsPerAttempt?: number | null;
};

/** A question published into an approved quiz version (includes the private answer key). */
export type QuizSnapshotQuestion = {
  id: string;
  type: QuizQuestionType;
  prompt: string;
  options: QuizOption[];
  correctAnswer: QuizAnswer;
  points: number;
};

export type QuizSnapshot = QuizSettings & { questions: QuizSnapshotQuestion[] };

export type QuestionInput =
  | { type: 'single_choice' | 'multiple_choice'; prompt: string; points: number; options: Array<{ text: string; isCorrect: boolean }> }
  | { type: 'true_false'; prompt: string; points: number; correctAnswer: boolean };

export const TRUE_FALSE_OPTIONS: QuizOption[] = [
  { id: 'true', text: 'True' },
  { id: 'false', text: 'False' },
];

export function settingsFromInput(input: QuizSettingsInput): QuizSettings {
  return {
    instructions: input.instructions?.trim() || null,
    attemptLimit: input.attemptLimit,
    timeLimitMinutes: input.timeLimitMinutes ?? null,
    shuffleQuestions: input.shuffleQuestions ?? false,
    shuffleOptions: input.shuffleOptions ?? false,
    passingScorePercent: input.passingScorePercent ?? null,
    showFeedback: input.showFeedback ?? false,
    questionsPerAttempt: input.questionsPerAttempt ?? null,
  };
}

/** Reads quiz settings from stored activity config (working copy or approved version). */
export function readSettings(config: ActivityConfig | null | undefined): QuizSettings {
  const value = (config ?? {}) as Partial<QuizSettings>;
  return {
    instructions: typeof value.instructions === 'string' ? value.instructions : null,
    attemptLimit: typeof value.attemptLimit === 'number' ? value.attemptLimit : 1,
    timeLimitMinutes: typeof value.timeLimitMinutes === 'number' ? value.timeLimitMinutes : null,
    shuffleQuestions: value.shuffleQuestions === true,
    shuffleOptions: value.shuffleOptions === true,
    // Quizzes saved before AP-022 have none of these: no threshold, no feedback, every question.
    passingScorePercent: typeof value.passingScorePercent === 'number' ? value.passingScorePercent : null,
    showFeedback: value.showFeedback === true,
    questionsPerAttempt: typeof value.questionsPerAttempt === 'number' ? value.questionsPerAttempt : null,
  };
}

/**
 * Question-pool rules (checked when a quiz is submitted for review and again when it is approved): a
 * quiz drawing N questions per attempt needs at least N questions, all worth the same points, so every
 * attempt has the same maximum score and grades stay comparable.
 */
export function validatePool(settings: Pick<QuizSettings, 'questionsPerAttempt'>, questions: ReadonlyArray<{ points: number }>) {
  const drawn = settings.questionsPerAttempt;
  if (drawn === null) return;
  if (questions.length < drawn) {
    throw new ApiProblem(422, 'QUIZ_POOL_TOO_SMALL', `The quiz draws ${drawn} question(s) per attempt but has only ${questions.length}.`);
  }
  if (new Set(questions.map((question) => question.points)).size > 1) {
    throw new ApiProblem(422, 'QUIZ_POOL_POINTS_MIXED', 'When questions are drawn from a pool, every question must be worth the same points.');
  }
}

/**
 * The questions of a new attempt, chosen on the server from the approved snapshot: a uniformly random
 * subset when a pool size is set (kept in course order unless questions are shuffled), otherwise all.
 */
export function selectQuestions<T>(settings: Pick<QuizSettings, 'questionsPerAttempt' | 'shuffleQuestions'>, questions: readonly T[]): T[] {
  const drawn = settings.questionsPerAttempt;
  const chosen = drawn !== null && drawn < questions.length ? new Set(shuffle(questions).slice(0, drawn)) : null;
  const selected = chosen ? questions.filter((question) => chosen.has(question)) : [...questions];
  return settings.shuffleQuestions ? shuffle(selected) : selected;
}

/** Passing status of a score; null when the quiz has no passing threshold. */
export function passed(score: number, maxScore: number, passingScorePercent: number | null): boolean | null {
  if (passingScorePercent === null || maxScore <= 0) return null;
  return score * 100 >= passingScorePercent * maxScore;
}

/** Questions of an approved quiz version, or an empty list when there are none. */
export function readSnapshotQuestions(config: ActivityConfig | null | undefined): QuizSnapshotQuestion[] {
  const questions = (config as { questions?: unknown } | null | undefined)?.questions;
  return Array.isArray(questions) ? (questions as QuizSnapshotQuestion[]) : [];
}

/** Validates an instructor's question input and builds stored options plus the private answer key. */
export function buildQuestion(input: QuestionInput): { type: QuizQuestionType; prompt: string; options: QuizOption[]; correctAnswer: QuizAnswer; points: number } {
  const prompt = input.prompt.trim();
  if (input.type === 'true_false') {
    return { type: input.type, prompt, points: input.points, options: TRUE_FALSE_OPTIONS, correctAnswer: { optionIds: [input.correctAnswer ? 'true' : 'false'] } };
  }
  const options = input.options.map((option) => ({ id: randomUUID(), text: option.text.trim(), isCorrect: option.isCorrect }));
  const correct = options.filter((option) => option.isCorrect);
  if (input.type === 'single_choice' && correct.length !== 1) {
    throw new ApiProblem(422, 'INVALID_ANSWER_KEY', 'A single-answer question needs exactly one correct option.');
  }
  if (input.type === 'multiple_choice' && correct.length < 1) {
    throw new ApiProblem(422, 'INVALID_ANSWER_KEY', 'A multiple-answer question needs at least one correct option.');
  }
  return {
    type: input.type,
    prompt,
    points: input.points,
    options: options.map(({ id, text }) => ({ id, text })),
    correctAnswer: { optionIds: correct.map((option) => option.id) },
  };
}

/** Unbiased Fisher–Yates shuffle using a cryptographic random source. */
export function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
