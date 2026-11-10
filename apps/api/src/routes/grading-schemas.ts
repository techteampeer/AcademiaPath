import { ASSIGNMENT_LIMITS } from '../assignments/model.js';

// JSON schemas mirroring the Assignments and Grades endpoints in packages/contract/openapi.yaml.
// Student-facing schemas carry only released grades; staff schemas never carry answer keys.

const uuid = { type: 'string', format: 'uuid' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;
const grade20 = { type: 'number', minimum: 0, maximum: 20 } as const;
const nullableGrade20 = { type: ['number', 'null'], minimum: 0, maximum: 20 } as const;
const gradeStatus = { type: 'string', enum: ['not_submitted', 'needs_grading', 'unreleased', 'released', 'changed_since_release'] } as const;
const studentGradeStatus = { type: 'string', enum: ['pending', 'released'] } as const;
const gradableType = { type: 'string', enum: ['quiz', 'assignment'] } as const;

export const submissionParamsSchema = {
  type: 'object',
  required: ['id', 'activityId', 'submissionId'],
  additionalProperties: false,
  properties: { id: uuid, activityId: uuid, submissionId: uuid },
} as const;

export const courseParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: uuid },
} as const;

export const submissionCreateSchema = {
  type: 'object',
  required: ['body'],
  additionalProperties: false,
  properties: { body: { type: 'string', minLength: 1, maxLength: ASSIGNMENT_LIMITS.body, pattern: '\\S' } },
} as const;

/** Only rubric points and feedback may be sent; totals, grades or release flags are rejected. */
export const gradeInputSchema = {
  type: 'object',
  required: ['scores'],
  additionalProperties: false,
  properties: {
    scores: {
      type: 'array',
      minItems: 1,
      maxItems: ASSIGNMENT_LIMITS.criteria,
      items: {
        type: 'object',
        required: ['criterionId', 'points'],
        additionalProperties: false,
        properties: { criterionId: uuid, points: { type: 'integer', minimum: 0, maximum: 100 } },
      },
    },
    feedback: { type: 'string', maxLength: ASSIGNMENT_LIMITS.feedback },
  },
} as const;

const rubricScore = {
  type: 'object',
  required: ['criterionId', 'title', 'points', 'maxPoints'],
  additionalProperties: false,
  properties: { criterionId: uuid, title: { type: 'string' }, points: { type: 'integer' }, maxPoints: { type: 'integer' } },
} as const;

const rubricCriterion = {
  type: 'object',
  required: ['id', 'title', 'description', 'maxPoints'],
  additionalProperties: false,
  properties: { id: uuid, title: { type: 'string' }, description: { type: ['string', 'null'] }, maxPoints: { type: 'integer' } },
} as const;

const releasedGrade = {
  type: ['object', 'null'],
  required: ['points', 'maxPoints', 'grade20', 'releasedAt', 'feedback', 'criteria'],
  additionalProperties: false,
  properties: {
    points: { type: 'integer' },
    maxPoints: { type: 'integer' },
    grade20,
    releasedAt: dateTime,
    feedback: { type: ['string', 'null'] },
    criteria: { type: 'array', items: rubricScore },
  },
} as const;

export const studentSubmissionSchema = {
  type: 'object',
  required: ['id', 'activityId', 'body', 'submittedAt', 'isLate', 'gradeStatus', 'grade'],
  additionalProperties: false,
  properties: {
    id: uuid,
    activityId: uuid,
    body: { type: 'string' },
    submittedAt: dateTime,
    isLate: { type: 'boolean' },
    gradeStatus: studentGradeStatus,
    grade: releasedGrade,
  },
} as const;

export const studentAssignmentStatusSchema = {
  type: 'object',
  required: ['dueAt', 'lateUntil', 'acceptingSubmissions', 'submission'],
  additionalProperties: false,
  properties: {
    dueAt: dateTime,
    lateUntil: nullableDateTime,
    acceptingSubmissions: { type: 'boolean' },
    submission: { ...studentSubmissionSchema, type: ['object', 'null'] },
  },
} as const;

const student = {
  type: 'object',
  required: ['id', 'email', 'givenName', 'familyName'],
  additionalProperties: false,
  properties: { id: uuid, email: { type: 'string' }, givenName: { type: 'string' }, familyName: { type: 'string' } },
} as const;

const staffGrade = {
  type: ['object', 'null'],
  required: ['points', 'maxPoints', 'grade20', 'gradedAt', 'releasedAt'],
  additionalProperties: false,
  properties: { points: { type: 'integer' }, maxPoints: { type: 'integer' }, grade20, gradedAt: dateTime, releasedAt: nullableDateTime },
} as const;

const submissionSummaryProperties = {
  id: uuid,
  student,
  submittedAt: dateTime,
  isLate: { type: 'boolean' },
  status: gradeStatus,
  grade: staffGrade,
} as const;

export const submissionPageSchema = {
  type: 'object',
  required: ['items', 'nextCursor'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: { type: 'object', required: Object.keys(submissionSummaryProperties), additionalProperties: false, properties: submissionSummaryProperties },
    },
    nextCursor: { type: ['string', 'null'] },
  },
} as const;

export const submissionDetailSchema = {
  type: 'object',
  required: [...Object.keys(submissionSummaryProperties), 'body', 'rubric', 'scores', 'feedback'],
  additionalProperties: false,
  properties: {
    ...submissionSummaryProperties,
    body: { type: 'string' },
    rubric: { type: 'array', items: rubricCriterion },
    scores: { type: 'array', items: rubricScore },
    feedback: { type: ['string', 'null'] },
  },
} as const;

export const releaseResultSchema = {
  type: 'object',
  required: ['activityId', 'releasedCount', 'releasedAt'],
  additionalProperties: false,
  properties: { activityId: uuid, releasedCount: { type: 'integer' }, releasedAt: nullableDateTime },
} as const;

/** AP-023: a course grade under the course's grading policy (see grading/policy.ts for the exact rules). */
const categorySummary = {
  type: 'object',
  required: ['categoryId', 'name', 'weightPercent', 'points', 'maxPoints', 'gradedItems', 'countedItems', 'percent', 'grade20'],
  additionalProperties: false,
  properties: {
    categoryId: uuid,
    name: { type: 'string' },
    weightPercent: { type: 'integer' },
    points: { type: 'integer' },
    maxPoints: { type: 'integer' },
    gradedItems: { type: 'integer' },
    countedItems: { type: 'integer' },
    percent: { type: ['number', 'null'], minimum: 0, maximum: 100 },
    grade20: nullableGrade20,
  },
} as const;

export const courseGradeSchema = {
  type: 'object',
  required: ['method', 'status', 'grade20', 'percent', 'countedItems', 'gradedItems', 'pendingItems', 'categories'],
  additionalProperties: false,
  properties: {
    method: { type: 'string', enum: ['points', 'weighted'] },
    status: { type: 'string', enum: ['final', 'provisional'] },
    grade20: nullableGrade20,
    percent: { type: ['number', 'null'], minimum: 0, maximum: 100 },
    countedItems: { type: 'integer' },
    gradedItems: { type: 'integer' },
    pendingItems: { type: 'integer' },
    categories: { type: 'array', items: categorySummary },
  },
} as const;

const categoryRef = {
  type: 'object',
  required: ['id', 'name', 'weightPercent'],
  additionalProperties: false,
  properties: { id: uuid, name: { type: 'string' }, weightPercent: { type: 'integer' } },
} as const;

export const policySummarySchema = {
  type: 'object',
  required: ['status', 'version', 'method', 'categories'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['none', 'draft', 'published'] },
    version: { type: 'integer' },
    method: { type: 'string', enum: ['points', 'weighted'] },
    categories: { type: 'array', items: categoryRef },
  },
} as const;

export const gradebookColumnSchema = {
  type: 'object',
  required: ['activityId', 'title', 'type', 'maxPoints', 'visible', 'categoryId'],
  additionalProperties: false,
  properties: {
    activityId: uuid,
    title: { type: 'string' },
    type: gradableType,
    maxPoints: { type: 'integer' },
    visible: { type: 'boolean' },
    categoryId: { type: ['string', 'null'], format: 'uuid' },
  },
} as const;

export const gradebookCellSchema = {
  type: 'object',
  required: ['activityId', 'status', 'points', 'maxPoints', 'grade20', 'releasedAt', 'revision'],
  additionalProperties: false,
  properties: {
    activityId: uuid,
    status: gradeStatus,
    points: { type: ['integer', 'null'] },
    maxPoints: { type: ['integer', 'null'] },
    grade20: nullableGrade20,
    releasedAt: nullableDateTime,
    revision: { type: ['integer', 'null'] },
  },
} as const;

export const gradeCountsSchema = {
  type: 'object',
  required: ['notSubmitted', 'needsGrading', 'unreleased', 'released'],
  additionalProperties: false,
  properties: {
    notSubmitted: { type: 'integer' },
    needsGrading: { type: 'integer' },
    unreleased: { type: 'integer' },
    released: { type: 'integer' },
  },
} as const;

export const studentRefSchema = {
  type: 'object',
  required: ['id', 'email', 'givenName', 'familyName'],
  additionalProperties: false,
  properties: { id: uuid, email: { type: 'string' }, givenName: { type: 'string' }, familyName: { type: 'string' } },
} as const;

const courseTotal = {
  type: 'object',
  required: ['points', 'maxPoints', 'grade20', 'gradedItems'],
  additionalProperties: false,
  properties: { points: { type: 'integer' }, maxPoints: { type: 'integer' }, grade20: nullableGrade20, gradedItems: { type: 'integer' } },
} as const;

export const gradebookSchema = {
  type: 'object',
  required: ['scaleMax', 'policy', 'columns', 'items', 'nextCursor'],
  additionalProperties: false,
  properties: {
    scaleMax: { type: 'integer', const: 20 },
    policy: policySummarySchema,
    columns: { type: 'array', items: gradebookColumnSchema },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['student', 'cells', 'total', 'courseGrade', 'counts'],
        additionalProperties: false,
        properties: {
          student,
          cells: { type: 'array', items: gradebookCellSchema },
          total: courseTotal,
          courseGrade: courseGradeSchema,
          counts: gradeCountsSchema,
        },
      },
    },
    nextCursor: { type: ['string', 'null'] },
  },
} as const;

export const studentGradesSchema = {
  type: 'object',
  required: ['scaleMax', 'policy', 'items', 'total', 'courseGrade'],
  additionalProperties: false,
  properties: {
    scaleMax: { type: 'integer', const: 20 },
    policy: {
      type: 'object',
      required: ['method', 'categories'],
      additionalProperties: false,
      properties: { method: { type: 'string', enum: ['points', 'weighted'] }, categories: { type: 'array', items: categoryRef } },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['activityId', 'title', 'type', 'categoryId', 'status', 'workStatus', 'grade', 'passed'],
        additionalProperties: false,
        properties: {
          activityId: uuid,
          title: { type: 'string' },
          type: gradableType,
          categoryId: { type: ['string', 'null'], format: 'uuid' },
          status: studentGradeStatus,
          workStatus: { type: 'string', enum: ['not_submitted', 'in_progress', 'submitted', 'released'] },
          grade: releasedGrade,
          passed: { type: ['boolean', 'null'] },
        },
      },
    },
    total: courseTotal,
    courseGrade: courseGradeSchema,
  },
} as const;
