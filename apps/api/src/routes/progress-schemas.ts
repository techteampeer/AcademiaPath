// JSON schemas mirroring the progress operations in packages/contract/openapi.yaml (AP-020).
// Responses carry counts and completion times only: never scores, grades or answers.

const uuid = { type: 'string', format: 'uuid' } as const;
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;
const trackedType = { type: 'string', enum: ['page', 'link', 'file', 'quiz', 'assignment'] } as const;

const summaryProperties = {
  completedCount: { type: 'integer', minimum: 0 },
  totalCount: { type: 'integer', minimum: 0 },
  percent: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
  state: { type: 'string', enum: ['no_activities', 'not_started', 'in_progress', 'completed'] },
} as const;
const summaryRequired = ['completedCount', 'totalCount', 'percent', 'state'] as const;

const continueAtSchema = {
  type: ['object', 'null'],
  required: ['sectionId', 'activityId', 'type', 'title'],
  additionalProperties: false,
  properties: { sectionId: uuid, activityId: uuid, type: trackedType, title: { type: 'string' } },
} as const;

const requiredSectionsSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['sectionId', 'title', 'completed'],
    additionalProperties: false,
    properties: { sectionId: uuid, title: { type: 'string' }, completed: { type: 'boolean' } },
  },
} as const;

const sectionSummarySchema = {
  type: 'object',
  required: ['sectionId', 'title', 'position', 'locked', 'requiredSections', ...summaryRequired],
  additionalProperties: false,
  properties: {
    sectionId: uuid,
    title: { type: 'string' },
    position: { type: 'integer' },
    locked: { type: 'boolean' },
    requiredSections: requiredSectionsSchema,
    ...summaryProperties,
  },
} as const;

export const courseProgressSchema = {
  type: 'object',
  required: ['courseId', 'continueAt', 'sections', ...summaryRequired],
  additionalProperties: false,
  properties: { courseId: uuid, continueAt: continueAtSchema, sections: { type: 'array', items: sectionSummarySchema }, ...summaryProperties },
} as const;

export const myProgressListSchema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['courseId', 'continueAt', ...summaryRequired],
        additionalProperties: false,
        properties: { courseId: uuid, continueAt: continueAtSchema, ...summaryProperties },
      },
    },
  },
} as const;

export const activityProgressSchema = {
  type: 'object',
  required: ['activityId', 'type', 'title', 'completion', 'completed', 'completedAt'],
  additionalProperties: false,
  properties: {
    activityId: uuid,
    type: trackedType,
    title: { type: 'string' },
    /** `manual`: the student marks it; `automatic`: completed by a submitted attempt or submission. */
    completion: { type: 'string', enum: ['manual', 'automatic'] },
    completed: { type: 'boolean' },
    completedAt: nullableDateTime,
  },
} as const;

export const sectionProgressSchema = {
  type: 'object',
  required: [...sectionSummarySchema.required, 'activities'],
  additionalProperties: false,
  properties: { ...sectionSummarySchema.properties, activities: { type: 'array', items: activityProgressSchema } },
} as const;

export const completionSchema = {
  type: 'object',
  required: ['activityId', 'sectionId', 'completed', 'completedAt'],
  additionalProperties: false,
  properties: { activityId: uuid, sectionId: uuid, completed: { type: 'boolean' }, completedAt: nullableDateTime },
} as const;

export const studentProgressPageSchema = {
  type: 'object',
  required: ['totalCount', 'items', 'nextCursor'],
  additionalProperties: false,
  properties: {
    totalCount: { type: 'integer', minimum: 0 },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['student', ...summaryRequired],
        additionalProperties: false,
        properties: {
          student: {
            type: 'object',
            required: ['id', 'email', 'givenName', 'familyName'],
            additionalProperties: false,
            properties: { id: uuid, email: { type: 'string' }, givenName: { type: 'string' }, familyName: { type: 'string' } },
          },
          ...summaryProperties,
        },
      },
    },
    nextCursor: { type: ['string', 'null'] },
  },
} as const;

export const prerequisiteListSchema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['sectionId', 'requiredSectionIds'],
        additionalProperties: false,
        properties: { sectionId: uuid, requiredSectionIds: { type: 'array', items: uuid } },
      },
    },
  },
} as const;

export const prerequisiteUpdateSchema = {
  type: 'object',
  required: ['requiredSectionIds'],
  additionalProperties: false,
  properties: { requiredSectionIds: { type: 'array', maxItems: 20, uniqueItems: true, items: uuid } },
} as const;

export const sectionPrerequisitesSchema = prerequisiteListSchema.properties.items.items;
