import { quizAttemptStatusEnum, quizQuestionTypeEnum } from '../db/schema/index.js';
import { QUIZ_LIMITS } from '../quizzes/model.js';

// JSON schemas mirroring the quiz endpoints in packages/contract/openapi.yaml. Student-facing
// schemas have no answer-key, correctness or score fields at all, so serialization can never
// include them.

const uuid = { type: 'string', format: 'uuid' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' }) as const;
const questionType = { type: 'string', enum: quizQuestionTypeEnum.enumValues } as const;
const attemptStatus = { type: 'string', enum: quizAttemptStatusEnum.enumValues } as const;
const points = { type: 'integer', minimum: 1, maximum: QUIZ_LIMITS.points } as const;

export const quizParamsSchema = {
  type: 'object',
  required: ['id', 'activityId'],
  additionalProperties: false,
  properties: { id: uuid, activityId: uuid },
} as const;

export const questionParamsSchema = {
  type: 'object',
  required: ['id', 'activityId', 'questionId'],
  additionalProperties: false,
  properties: { id: uuid, activityId: uuid, questionId: uuid },
} as const;

export const attemptParamsSchema = {
  type: 'object',
  required: ['id', 'attemptId'],
  additionalProperties: false,
  properties: { id: uuid, attemptId: uuid },
} as const;

export const resultParamsSchema = {
  type: 'object',
  required: ['id', 'activityId', 'attemptId'],
  additionalProperties: false,
  properties: { id: uuid, activityId: uuid, attemptId: uuid },
} as const;

export const questionInputSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['type', 'prompt', 'points', 'options'],
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['single_choice', 'multiple_choice'] },
        prompt: text(QUIZ_LIMITS.prompt),
        points,
        options: {
          type: 'array',
          minItems: QUIZ_LIMITS.minOptions,
          maxItems: QUIZ_LIMITS.maxOptions,
          items: {
            type: 'object',
            required: ['text', 'isCorrect'],
            additionalProperties: false,
            properties: { text: text(QUIZ_LIMITS.optionText), isCorrect: { type: 'boolean' } },
          },
        },
      },
    },
    {
      type: 'object',
      required: ['type', 'prompt', 'points', 'correctAnswer'],
      additionalProperties: false,
      properties: {
        type: { type: 'string', const: 'true_false' },
        prompt: text(QUIZ_LIMITS.prompt),
        points,
        correctAnswer: { type: 'boolean' },
      },
    },
  ],
} as const;

const answerItems = {
  type: 'array',
  maxItems: QUIZ_LIMITS.questions,
  items: {
    type: 'object',
    required: ['questionId', 'selectedOptionIds'],
    additionalProperties: false,
    properties: {
      questionId: uuid,
      selectedOptionIds: { type: 'array', maxItems: QUIZ_LIMITS.maxOptions, items: { type: 'string', minLength: 1, maxLength: 64 } },
    },
  },
} as const;

export const answersSaveSchema = {
  type: 'object',
  required: ['answers'],
  additionalProperties: false,
  properties: { answers: { ...answerItems, minItems: 1 } },
} as const;

/** Only answers may be sent on submission; scores or results in the body are rejected. */
export const attemptSubmitSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { answers: answerItems },
} as const;

const optionWithKey = {
  type: 'object',
  required: ['id', 'text', 'isCorrect'],
  additionalProperties: false,
  properties: { id: { type: 'string' }, text: { type: 'string' }, isCorrect: { type: 'boolean' } },
} as const;

const optionForStudent = {
  type: 'object',
  required: ['id', 'text'],
  additionalProperties: false,
  properties: { id: { type: 'string' }, text: { type: 'string' } },
} as const;

export const quizQuestionSchema = {
  type: 'object',
  required: ['id', 'position', 'type', 'prompt', 'points', 'options'],
  additionalProperties: false,
  properties: { id: uuid, position: { type: 'integer' }, type: questionType, prompt: { type: 'string' }, points: { type: 'integer' }, options: { type: 'array', items: optionWithKey } },
} as const;

export const quizQuestionListSchema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: { items: { type: 'array', items: quizQuestionSchema } },
} as const;

const attemptCore = {
  attemptNumber: { type: 'integer' },
  status: attemptStatus,
  startedAt: dateTime,
  deadlineAt: nullableDateTime,
  submittedAt: nullableDateTime,
  closedByTimeLimit: { type: 'boolean' },
} as const;

export const studentAttemptSchema = {
  type: 'object',
  required: ['id', 'activityId', 'attemptLimit', 'resultsReleased', 'serverTime', 'questions', ...Object.keys(attemptCore)],
  additionalProperties: false,
  properties: {
    id: uuid,
    activityId: uuid,
    attemptLimit: { type: 'integer' },
    ...attemptCore,
    resultsReleased: { type: 'boolean' },
    serverTime: dateTime,
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['questionId', 'position', 'type', 'prompt', 'points', 'options', 'selectedOptionIds'],
        additionalProperties: false,
        properties: {
          questionId: uuid,
          position: { type: 'integer' },
          type: questionType,
          prompt: { type: 'string' },
          points: { type: 'integer' },
          options: { type: 'array', items: optionForStudent },
          selectedOptionIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export const studentAttemptSummarySchema = {
  type: 'object',
  required: [
    'attemptLimit',
    'attemptsUsed',
    'attemptsRemaining',
    'timeLimitMinutes',
    'questionsPerAttempt',
    'passingScorePercent',
    'activeAttemptId',
    'gradeReleased',
    'passed',
    'items',
  ],
  additionalProperties: false,
  properties: {
    attemptLimit: { type: 'integer' },
    attemptsUsed: { type: 'integer' },
    attemptsRemaining: { type: 'integer', minimum: 0 },
    gradeReleased: { type: 'boolean' },
    timeLimitMinutes: { type: ['integer', 'null'] },
    questionsPerAttempt: { type: ['integer', 'null'] },
    passingScorePercent: { type: ['integer', 'null'] },
    passed: { type: ['boolean', 'null'] },
    activeAttemptId: { type: ['string', 'null'], format: 'uuid' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'feedbackAvailable', ...Object.keys(attemptCore)],
        additionalProperties: false,
        properties: { id: uuid, ...attemptCore, feedbackAvailable: { type: 'boolean' } },
      },
    },
  },
} as const;

const student = {
  type: 'object',
  required: ['id', 'email', 'givenName', 'familyName'],
  additionalProperties: false,
  properties: { id: uuid, email: { type: 'string' }, givenName: { type: 'string' }, familyName: { type: 'string' } },
} as const;

const resultCore = {
  attemptId: uuid,
  ...attemptCore,
  score: { type: ['integer', 'null'] },
  maxScore: { type: 'integer' },
  passingScorePercent: { type: ['integer', 'null'] },
  passed: { type: ['boolean', 'null'] },
  student,
} as const;

export const quizResultPageSchema = {
  type: 'object',
  required: ['items', 'nextCursor'],
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { type: 'object', required: Object.keys(resultCore), additionalProperties: false, properties: resultCore } },
    nextCursor: { type: ['string', 'null'] },
  },
} as const;

export const quizAttemptResultSchema = {
  type: 'object',
  required: [...Object.keys(resultCore), 'questions'],
  additionalProperties: false,
  properties: {
    ...resultCore,
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['questionId', 'position', 'type', 'prompt', 'points', 'options', 'selectedOptionIds', 'awardedPoints', 'isCorrect'],
        additionalProperties: false,
        properties: {
          questionId: uuid,
          position: { type: 'integer' },
          type: questionType,
          prompt: { type: 'string' },
          points: { type: 'integer' },
          options: { type: 'array', items: optionWithKey },
          selectedOptionIds: { type: 'array', items: { type: 'string' } },
          awardedPoints: { type: ['integer', 'null'] },
          isCorrect: { type: ['boolean', 'null'] },
        },
      },
    },
  },
} as const;

/**
 * A student's correctness review of one released attempt (AP-022): their own selections, whether each
 * question was answered correctly and the points awarded. Answer keys are never included.
 */
export const quizFeedbackSchema = {
  type: 'object',
  required: ['attemptId', 'attemptNumber', 'submittedAt', 'score', 'maxScore', 'passed', 'questions'],
  additionalProperties: false,
  properties: {
    attemptId: uuid,
    attemptNumber: { type: 'integer' },
    submittedAt: dateTime,
    score: { type: 'integer' },
    maxScore: { type: 'integer' },
    passed: { type: ['boolean', 'null'] },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['questionId', 'position', 'type', 'prompt', 'points', 'options', 'selectedOptionIds', 'isCorrect', 'awardedPoints'],
        additionalProperties: false,
        properties: {
          questionId: uuid,
          position: { type: 'integer' },
          type: questionType,
          prompt: { type: 'string' },
          points: { type: 'integer' },
          options: { type: 'array', items: optionForStudent },
          selectedOptionIds: { type: 'array', items: { type: 'string' } },
          isCorrect: { type: 'boolean' },
          awardedPoints: { type: 'integer' },
        },
      },
    },
  },
} as const;

/** Copies the approved questions of another quiz of the same course into this quiz's question bank. */
export const questionImportSchema = {
  type: 'object',
  required: ['sourceActivityId'],
  additionalProperties: false,
  properties: { sourceActivityId: uuid },
} as const;
