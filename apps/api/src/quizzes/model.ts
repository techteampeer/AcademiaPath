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

/** Grace period for in-flight requests after a server-side deadline. */
export const DEADLINE_GRACE_SECONDS = 10;

export type QuizSettings = {
  instructions: string | null;
  attemptLimit: number;
  timeLimitMinutes: number | null;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
};

export type QuizSettingsInput = {
  title: string;
  instructions?: string;
  attemptLimit: number;
  timeLimitMinutes?: number | null;
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
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
  };
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
