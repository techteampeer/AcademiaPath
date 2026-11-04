import type { QuizAnswer, QuizOption, QuizQuestionType } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';

/**
 * Validates a student's selection against the options of the question as presented. Returns a
 * normalized response (deduplicated option ids). Correctness is never decided here.
 */
export function normalizeResponse(question: { type: QuizQuestionType; options: QuizOption[] }, selectedOptionIds: string[]): QuizAnswer {
  const unique = [...new Set(selectedOptionIds)];
  const valid = new Set(question.options.map((option) => option.id));
  if (unique.some((id) => !valid.has(id))) {
    throw new ApiProblem(422, 'INVALID_ANSWER', 'An answer refers to an option that does not belong to the question.');
  }
  if (question.type !== 'multiple_choice' && unique.length > 1) {
    throw new ApiProblem(422, 'INVALID_ANSWER', 'This question accepts a single answer.');
  }
  return { optionIds: unique };
}

/**
 * Deterministic server-side scoring: full points only for an exact match of the complete correct
 * selection (single choice, multiple choice and true/false alike); otherwise zero.
 */
export function gradeResponse(question: { correctAnswer: QuizAnswer; points: number }, response: QuizAnswer | null): { isCorrect: boolean; awardedPoints: number } {
  const selected = new Set(response?.optionIds ?? []);
  const correct = new Set(question.correctAnswer.optionIds);
  const isCorrect = selected.size > 0 && selected.size === correct.size && [...correct].every((id) => selected.has(id));
  return { isCorrect, awardedPoints: isCorrect ? question.points : 0 };
}
