import { CONTENT_TYPES } from './activity-schemas.js';
import { activityReviewStatusEnum } from '../db/schema/index.js';
import { QUALITY_CODES } from '../quality/rules.js';

// JSON schemas mirroring the AP-029 content-quality endpoints in packages/contract/openapi.yaml.

const uuid = { type: 'string', format: 'uuid' } as const;
const nullableUuid = { type: ['string', 'null'], format: 'uuid' } as const;

export const qualityCourseParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: uuid },
} as const;

const findingSchema = {
  type: 'object',
  required: ['code', 'severity', 'target', 'sectionId', 'activityId', 'field', 'itemId', 'itemNumber', 'value'],
  additionalProperties: false,
  properties: {
    code: { type: 'string', enum: QUALITY_CODES },
    severity: { type: 'string', enum: ['blocking', 'warning'] },
    target: { type: 'string', enum: ['course', 'section', 'activity'] },
    sectionId: nullableUuid,
    activityId: nullableUuid,
    field: { type: ['string', 'null'] },
    itemId: { type: ['string', 'null'] },
    itemNumber: { type: ['integer', 'null'], minimum: 1 },
    value: { type: ['string', 'null'] },
  },
} as const;

export const qualityReportSchema = {
  type: 'object',
  required: ['courseId', 'scope', 'activityId', 'checkedAt', 'summary', 'sections', 'activities', 'findings'],
  additionalProperties: false,
  properties: {
    courseId: uuid,
    scope: { type: 'string', enum: ['course', 'activity'] },
    activityId: nullableUuid,
    checkedAt: { type: 'string', format: 'date-time' },
    summary: {
      type: 'object',
      required: ['blocking', 'warnings', 'sections', 'activities', 'questions'],
      additionalProperties: false,
      properties: {
        blocking: { type: 'integer', minimum: 0 },
        warnings: { type: 'integer', minimum: 0 },
        sections: { type: 'integer', minimum: 0 },
        activities: { type: 'integer', minimum: 0 },
        questions: { type: 'integer', minimum: 0 },
      },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'position', 'isVisible'],
        additionalProperties: false,
        properties: { id: uuid, title: { type: 'string' }, position: { type: 'integer' }, isVisible: { type: 'boolean' } },
      },
    },
    activities: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'sectionId', 'type', 'title', 'reviewStatus'],
        additionalProperties: false,
        properties: {
          id: uuid,
          sectionId: uuid,
          type: { type: 'string', enum: CONTENT_TYPES },
          title: { type: 'string' },
          reviewStatus: { type: 'string', enum: activityReviewStatusEnum.enumValues },
        },
      },
    },
    findings: { type: 'array', items: findingSchema },
  },
} as const;
