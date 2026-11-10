import { RESOURCE_KINDS } from '../content/urls.js';
import { activityReviewStatusEnum } from '../db/schema/index.js';

// JSON schemas mirroring the content endpoints in packages/contract/openapi.yaml.

/** `file` activities are documents: created only by the upload endpoint (routes/documents.ts). */
export const CONTENT_TYPES = ['page', 'link', 'quiz', 'assignment', 'file'] as const;
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
  /** AP-021: what the link points to. Every kind is only a link; nothing is embedded. */
  kind: { type: 'string', enum: RESOURCE_KINDS },
} as const;

const quizSettingsFields = {
  title: text(200),
  instructions: { type: 'string', maxLength: 5000 },
  attemptLimit: { type: 'integer', minimum: 1, maximum: 10 },
  timeLimitMinutes: { type: ['integer', 'null'], minimum: 1, maximum: 300 },
  shuffleQuestions: { type: 'boolean' },
  shuffleOptions: { type: 'boolean' },
} as const;

const assignmentFields = {
  title: text(200),
  instructions: text(20000),
  dueAt: dateTime,
  lateUntil: nullableDateTime,
  rubric: {
    type: 'array',
    minItems: 1,
    maxItems: 20,
    items: {
      type: 'object',
      required: ['title', 'maxPoints'],
      additionalProperties: false,
      properties: { title: text(200), description: { type: 'string', maxLength: 1000 }, maxPoints: { type: 'integer', minimum: 1, maximum: 100 } },
    },
  },
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
      properties: { type: { type: 'string', const: 'page' }, ...pageFields, folderId: uuid },
    },
    {
      type: 'object',
      required: ['type', 'title', 'url'],
      additionalProperties: false,
      properties: { type: { type: 'string', const: 'link' }, ...linkFields, folderId: uuid },
    },
    {
      type: 'object',
      required: ['type', 'title', 'attemptLimit'],
      additionalProperties: false,
      properties: { type: { type: 'string', const: 'quiz' }, ...quizSettingsFields },
    },
    {
      type: 'object',
      required: ['type', 'title', 'instructions', 'dueAt', 'rubric'],
      additionalProperties: false,
      properties: { type: { type: 'string', const: 'assignment' }, ...assignmentFields },
    },
  ],
} as const;

export const activityUpdateSchema = {
  oneOf: [
    { type: 'object', required: ['title', 'body'], additionalProperties: false, properties: pageFields },
    { type: 'object', required: ['title', 'url'], additionalProperties: false, properties: linkFields },
    { type: 'object', required: ['title', 'attemptLimit'], additionalProperties: false, properties: quizSettingsFields },
    { type: 'object', required: ['title', 'instructions', 'dueAt', 'rubric'], additionalProperties: false, properties: assignmentFields },
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
  // Document content is file metadata only; text and summaries come from the document endpoint.
  properties: {
    documentId: uuid,
    fileName: { type: 'string' },
    format: { type: 'string', enum: ['pdf', 'docx', 'pptx'] },
    summaryRevision: { type: 'integer' },
    body: { type: 'string' },
    url: { type: 'string' },
    description: { type: ['string', 'null'] },
    kind: { type: 'string', enum: RESOURCE_KINDS },
    instructions: { type: ['string', 'null'] },
    attemptLimit: { type: 'integer' },
    timeLimitMinutes: { type: ['integer', 'null'] },
    shuffleQuestions: { type: 'boolean' },
    shuffleOptions: { type: 'boolean' },
    questionCount: { type: 'integer' },
    totalPoints: { type: 'integer' },
    dueAt: dateTime,
    lateUntil: nullableDateTime,
    rubric: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'description', 'maxPoints'],
        additionalProperties: false,
        properties: { id: uuid, title: { type: 'string' }, description: { type: ['string', 'null'] }, maxPoints: { type: 'integer' } },
      },
    },
  },
} as const;

export const activitySchema = {
  type: 'object',
  required: ['id', 'courseId', 'sectionId', 'folderId', 'type', 'position', 'isVisible', 'title', 'content', 'review', 'liveVersion', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: uuid,
    courseId: uuid,
    sectionId: uuid,
    folderId: nullableUuid,
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
