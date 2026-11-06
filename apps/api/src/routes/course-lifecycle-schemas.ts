// JSON schemas mirroring the course lifecycle endpoints in packages/contract/openapi.yaml.
import { courseRoleEnum } from '../db/schema/index.js';
import { codeSchema, courseSchema, courseSectionSchema } from './course-schemas.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const version = { type: 'integer', minimum: 1 } as const;
const title = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } as const;
const summary = { type: ['string', 'null'], maxLength: 2000 } as const;

export const sectionParamsSchema = {
  type: 'object',
  required: ['id', 'sectionId'],
  additionalProperties: false,
  properties: { id: uuid, sectionId: uuid },
} as const;

export const courseUpdateSchema = {
  type: 'object',
  required: ['version'],
  minProperties: 2,
  additionalProperties: false,
  properties: { version, title, code: codeSchema, description: summary },
} as const;

export const courseTransitionSchema = {
  type: 'object',
  required: ['version'],
  additionalProperties: false,
  properties: { version },
} as const;

export const sectionCreateSchema = {
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: { title, summary, isVisible: { type: 'boolean', default: true } },
} as const;

export const sectionUpdateSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: { title, summary, isVisible: { type: 'boolean' } },
} as const;

export const sectionOrderSchema = {
  type: 'object',
  required: ['sectionIds'],
  additionalProperties: false,
  properties: { sectionIds: { type: 'array', minItems: 1, maxItems: 500, items: uuid } },
} as const;

export const sectionListSchema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: { items: { type: 'array', items: courseSectionSchema } },
} as const;

const count = { type: 'integer', minimum: 0 } as const;

export const courseLifecycleSchema = {
  type: 'object',
  required: ['course', 'term', 'template', 'sections', 'enrollmentCounts', 'studentVisibleActivityCount', 'unapprovedActivityCount', 'awaitingReviewCount', 'allowedTransitions'],
  additionalProperties: false,
  properties: {
    course: courseSchema,
    term: {
      type: 'object',
      required: ['id', 'code', 'name', 'startsOn', 'endsOn'],
      additionalProperties: false,
      properties: { id: uuid, code: { type: 'string' }, name: { type: 'string' }, startsOn: { type: 'string', format: 'date' }, endsOn: { type: 'string', format: 'date' } },
    },
    template: {
      type: ['object', 'null'],
      required: ['id', 'code', 'title', 'version'],
      additionalProperties: false,
      properties: { id: uuid, code: { type: 'string' }, title: { type: 'string' }, version: { type: 'integer' } },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'summary', 'position', 'isVisible', 'activityCount', 'studentVisibleActivityCount'],
        additionalProperties: false,
        properties: {
          id: uuid,
          title: { type: 'string' },
          summary: { type: ['string', 'null'] },
          position: { type: 'integer' },
          isVisible: { type: 'boolean' },
          activityCount: count,
          studentVisibleActivityCount: count,
        },
      },
    },
    enrollmentCounts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role', 'active', 'inactive'],
        additionalProperties: false,
        properties: { role: { type: 'string', enum: courseRoleEnum.enumValues }, active: count, inactive: count },
      },
    },
    studentVisibleActivityCount: count,
    unapprovedActivityCount: count,
    awaitingReviewCount: count,
    allowedTransitions: { type: 'array', items: { type: 'string', enum: ['publish', 'unpublish'] } },
  },
} as const;
