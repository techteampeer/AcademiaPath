import { TUTOR_LIMITS } from '../tutor/text.js';

// JSON schemas mirroring the Tutor endpoints in packages/contract/openapi.yaml.

const uuid = { type: 'string', format: 'uuid' } as const;
const language = { type: 'string', enum: ['en', 'es'] } as const;
const grounding = { type: 'string', enum: ['grounded', 'insufficient_material'] } as const;
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' }) as const;

export const tutorParamsSchema = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: uuid } } as const;

export const tutorMessageSchema = {
  type: 'object',
  required: ['question', 'language'],
  additionalProperties: false,
  properties: { question: text(TUTOR_LIMITS.question), language },
} as const;

export const tutorPracticeSchema = {
  type: 'object',
  required: ['language'],
  additionalProperties: false,
  properties: { language, topic: text(TUTOR_LIMITS.topic) },
} as const;

const provider = {
  type: 'object',
  required: ['mode', 'label'],
  additionalProperties: false,
  properties: { mode: { type: 'string', enum: ['mock'] }, label: { type: 'string' } },
} as const;

const citation = {
  type: 'object',
  required: ['ref', 'activityId', 'sectionId', 'title', 'excerpt', 'sourceLanguage', 'matchesRequestedLanguage'],
  additionalProperties: false,
  properties: {
    ref: { type: 'integer' },
    activityId: uuid,
    sectionId: uuid,
    title: { type: 'string' },
    excerpt: { type: 'string' },
    sourceLanguage: { type: 'string', enum: ['en', 'es', 'unknown'] },
    matchesRequestedLanguage: { type: 'boolean' },
  },
} as const;

const usage = {
  type: 'object',
  required: ['limit', 'windowMinutes', 'usedInWindow'],
  additionalProperties: false,
  properties: { limit: { type: 'integer' }, windowMinutes: { type: 'integer' }, usedInWindow: { type: 'integer' } },
} as const;

export const tutorMessageResponseSchema = {
  type: 'object',
  required: ['provider', 'language', 'grounding', 'text', 'citations', 'usage'],
  additionalProperties: false,
  properties: { provider, language, grounding, text: { type: 'string' }, citations: { type: 'array', items: citation }, usage },
} as const;

export const tutorPracticeResponseSchema = {
  type: 'object',
  required: ['provider', 'language', 'grounding', 'prompts', 'usage'],
  additionalProperties: false,
  properties: {
    provider,
    language,
    grounding,
    prompts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ref', 'kind', 'text', 'citation'],
        additionalProperties: false,
        properties: { ref: { type: 'integer' }, kind: { type: 'string', enum: ['explain', 'key_terms'] }, text: { type: 'string' }, citation },
      },
    },
    usage,
  },
} as const;

export const tutorUsageResponseSchema = {
  type: 'object',
  required: ['limit', 'windowMinutes', 'usedInWindow', 'totalRequests', 'items'],
  additionalProperties: false,
  properties: {
    limit: { type: 'integer' },
    windowMinutes: { type: 'integer' },
    usedInWindow: { type: 'integer' },
    totalRequests: { type: 'integer' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'language', 'outcome', 'providerMode', 'sourceActivityIds', 'createdAt'],
        additionalProperties: false,
        properties: {
          id: uuid,
          kind: { type: 'string', enum: ['message', 'practice'] },
          language,
          outcome: grounding,
          providerMode: { type: 'string', enum: ['mock'] },
          sourceActivityIds: { type: 'array', items: uuid },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
} as const;
