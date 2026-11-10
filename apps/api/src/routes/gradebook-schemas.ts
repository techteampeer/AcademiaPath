import { GRADING_LIMITS } from '../grading/policy.js';
import { courseGradeSchema, gradebookColumnSchema, gradeCountsSchema, policySummarySchema, studentRefSchema } from './grading-schemas.js';

// JSON schemas mirroring the advanced gradebook operations in packages/contract/openapi.yaml (AP-023).

const uuid = { type: 'string', format: 'uuid' } as const;
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;
const grade20 = { type: ['number', 'null'], minimum: 0, maximum: 20 } as const;

export const studentParamsSchema = {
  type: 'object',
  required: ['id', 'userId'],
  additionalProperties: false,
  properties: { id: uuid, userId: uuid },
} as const;

const policyCategory = {
  type: 'object',
  required: ['id', 'name', 'weightPercent', 'activityIds'],
  additionalProperties: false,
  properties: { id: uuid, name: { type: 'string' }, weightPercent: { type: 'integer' }, activityIds: { type: 'array', items: uuid } },
} as const;

export const gradingPolicySchema = {
  type: 'object',
  required: ['status', 'version', 'publishedAt', 'updatedAt', 'totalWeightPercent', 'categories'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['none', 'draft', 'published'] },
    version: { type: 'integer', minimum: 0 },
    publishedAt: nullableDateTime,
    updatedAt: nullableDateTime,
    totalWeightPercent: { type: 'integer' },
    categories: { type: 'array', items: policyCategory },
  },
} as const;

/** The whole policy is saved at once; weights and memberships are validated on the server. */
export const gradingPolicyInputSchema = {
  type: 'object',
  required: ['expectedVersion', 'status', 'categories'],
  additionalProperties: false,
  properties: {
    expectedVersion: { type: 'integer', minimum: 0 },
    status: { type: 'string', enum: ['draft', 'published'] },
    categories: {
      type: 'array',
      maxItems: GRADING_LIMITS.categories,
      items: {
        type: 'object',
        required: ['name', 'weightPercent', 'activityIds'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: GRADING_LIMITS.categoryName, pattern: '\\S' },
          weightPercent: { type: 'integer', minimum: 1, maximum: 100 },
          activityIds: { type: 'array', maxItems: GRADING_LIMITS.activitiesPerCategory, uniqueItems: true, items: uuid },
        },
      },
    },
  },
} as const;

const gradeValue = {
  type: ['object', 'null'],
  required: ['points', 'maxPoints', 'grade20', 'revision', 'gradedAt'],
  additionalProperties: false,
  properties: { points: { type: 'integer' }, maxPoints: { type: 'integer' }, grade20, revision: { type: 'integer' }, gradedAt: { type: 'string', format: 'date-time' } },
} as const;

const releasedValue = {
  type: ['object', 'null'],
  required: ['points', 'maxPoints', 'grade20', 'revision', 'releasedAt'],
  additionalProperties: false,
  properties: { points: { type: 'integer' }, maxPoints: { type: 'integer' }, grade20, revision: { type: 'integer' }, releasedAt: { type: 'string', format: 'date-time' } },
} as const;

export const studentGradebookSchema = {
  type: 'object',
  required: ['scaleMax', 'student', 'policy', 'courseGrade', 'releasedCourseGrade', 'counts', 'activities'],
  additionalProperties: false,
  properties: {
    scaleMax: { type: 'integer', const: 20 },
    student: studentRefSchema,
    policy: policySummarySchema,
    courseGrade: courseGradeSchema,
    releasedCourseGrade: courseGradeSchema,
    counts: gradeCountsSchema,
    activities: {
      type: 'array',
      items: {
        type: 'object',
        required: ['activity', 'status', 'grade', 'released', 'submittedAt', 'isLate', 'inProgress', 'attemptsUsed', 'passingScorePercent', 'passed'],
        additionalProperties: false,
        properties: {
          activity: gradebookColumnSchema,
          status: { type: 'string', enum: ['not_submitted', 'needs_grading', 'unreleased', 'released', 'changed_since_release'] },
          grade: gradeValue,
          released: releasedValue,
          submittedAt: nullableDateTime,
          isLate: { type: 'boolean' },
          inProgress: { type: 'boolean' },
          attemptsUsed: { type: ['integer', 'null'] },
          passingScorePercent: { type: ['integer', 'null'] },
          passed: { type: ['boolean', 'null'] },
        },
      },
    },
  },
} as const;

export const gradeReleaseInputSchema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      uniqueItems: true,
      items: {
        type: 'object',
        required: ['activityId', 'userId', 'revision'],
        additionalProperties: false,
        properties: { activityId: uuid, userId: uuid, revision: { type: 'integer', minimum: 1 } },
      },
    },
  },
} as const;

export const gradeReleaseResultSchema = {
  type: 'object',
  required: ['releasedCount', 'releasedAt', 'results'],
  additionalProperties: false,
  properties: {
    releasedCount: { type: 'integer' },
    releasedAt: nullableDateTime,
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['activityId', 'userId', 'revision', 'outcome'],
        additionalProperties: false,
        properties: {
          activityId: uuid,
          userId: uuid,
          revision: { type: 'integer' },
          outcome: { type: 'string', enum: ['released', 'already_released', 'stale', 'not_graded', 'not_found'] },
        },
      },
    },
  },
} as const;
