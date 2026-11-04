import { activityReviewStatusEnum } from '../db/schema/index.js';

// JSON schemas mirroring the content endpoints in packages/contract/openapi.yaml.

export const CONTENT_TYPES = ['page', 'link', 'quiz'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

const uuid = { type: 'string', format: 'uuid' } as const;
const nullableUuid = { type: ['string', 'null'], format: 'uuid' } as const;
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
/** Bounded string that must contain at least one non-whitespace character. */
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' }) as const;

const pageFields = { title: text(200), body: text(20000) } as const;
const linkFields = {
  title: text(200),
  url: { type: 'string', minLength: 1, maxLength: 2048 },
  description: { type: 'string', maxLength: 1000 },
} as const;

const quizSettingsFields = {
  title: text(200),
  instructions: { type: 'string', maxLength: 5000 },
  attemptLimit: { type: 'integer', minimum: 1, maximum: 10 },
  timeLimitMinutes: { type: ['integer', 'null'], minimum: 1, maximum: 300 },
  shuffleQuestions: { type: 'boolean' },
  shuffleOptions: { type: 'boolean' },
} as const;

export const courseSectionParamsSchema = {
  type: 'object',
  required: ['id', 'sectionId'],
  additionalProperties: false,
  properties: { id: uuid, sectionId: uuid },
} as const;

export const courseActivityParamsSchema = {
  type: 'object',
  required: ['id', 'activityId'],
  additionalProperties: false,
  properties: { id: uuid, activityId: uuid },
} as const;

export const activityCreateSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['type', 'title', 'body'],
      additionalProperties: false,
      properties: { type: { type: 'string', const: 'page' }, ...pageFields },
    },
    {
      type: 'object',
      required: ['type', 'title', 'url'],
      additionalProperties: false,
      properties: { type: { type: 'string', const: 'link' }, ...linkFields },
    },
    {
      type: 'object',
      required: ['type', 'title', 'attemptLimit'],
      additionalProperties: false,
      properties: { type: { type: 'string', const: 'quiz' }, ...quizSettingsFields },
    },
  ],
} as const;

export const activityUpdateSchema = {
  oneOf: [
    { type: 'object', required: ['title', 'body'], additionalProperties: false, properties: pageFields },
    { type: 'object', required: ['title', 'url'], additionalProperties: false, properties: linkFields },
    { type: 'object', required: ['title', 'attemptLimit'], additionalProperties: false, properties: quizSettingsFields },
  ],
} as const;

export const activityReviewSchema = {
  type: 'object',
  required: ['decision'],
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['approve', 'return'] },
    comment: text(2000),
  },
} as const;

const contentSchema = {
  type: 'object',
  additionalProperties: false,
  // Quiz content is a summary only: questions and answer keys are never part of an activity.
  properties: {
    body: { type: 'string' },
    url: { type: 'string' },
    description: { type: ['string', 'null'] },
    instructions: { type: ['string', 'null'] },
    attemptLimit: { type: 'integer' },
    timeLimitMinutes: { type: ['integer', 'null'] },
    shuffleQuestions: { type: 'boolean' },
    shuffleOptions: { type: 'boolean' },
    questionCount: { type: 'integer' },
    totalPoints: { type: 'integer' },
  },
} as const;

export const activitySchema = {
  type: 'object',
  required: ['id', 'courseId', 'sectionId', 'type', 'position', 'isVisible', 'title', 'content', 'review', 'liveVersion', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: uuid,
    courseId: uuid,
    sectionId: uuid,
    type: { type: 'string', enum: CONTENT_TYPES },
    position: { type: 'integer' },
    isVisible: { type: 'boolean' },
    title: { type: 'string' },
    content: contentSchema,
    review: {
      type: ['object', 'null'],
      required: ['status', 'comment', 'submittedAt', 'submittedByUserId', 'reviewedAt', 'reviewedByUserId'],
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: activityReviewStatusEnum.enumValues },
        comment: { type: ['string', 'null'] },
        submittedAt: nullableDateTime,
        submittedByUserId: nullableUuid,
        reviewedAt: nullableDateTime,
        reviewedByUserId: nullableUuid,
      },
    },
    liveVersion: {
      type: ['object', 'null'],
      required: ['title', 'content', 'approvedAt'],
      additionalProperties: false,
      properties: { title: { type: 'string' }, content: contentSchema, approvedAt: dateTime },
    },
    createdAt: dateTime,
    updatedAt: dateTime,
  },
} as const;
