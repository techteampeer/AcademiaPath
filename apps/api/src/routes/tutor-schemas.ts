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

// ---- AP-030D guided demo tutor (read-only; nothing is stored) ----

const GUIDE_ACTION_VALUES = ['start', 'explain', 'again', 'summarize', 'simpler', 'example', 'detail', 'review', 'next', 'practice', 'material', 'quiz_prep', 'ask'] as const;
const SUGGESTED_ACTION_VALUES = GUIDE_ACTION_VALUES.filter((action) => action !== 'start' && action !== 'ask');
const sourceLanguage = { type: ['string', 'null'], enum: ['en', 'es', 'unknown', null] } as const;

export const tutorGuideSchema = {
  type: 'object',
  required: ['action', 'language'],
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: GUIDE_ACTION_VALUES },
    language,
    /** The lesson or document being studied (must be approved and readable by the caller). */
    activityId: uuid,
    /** Free text for `ask` only. */
    question: text(TUTOR_LIMITS.question),
    /** Which passage or practice question to use (follow-ups send the next one). */
    variant: { type: 'integer', minimum: 0, maximum: 1000 },
  },
} as const;

const block = {
  type: 'object',
  required: ['kind', 'text', 'items', 'ref', 'sourceLanguage'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['text', 'quote', 'list', 'tip'] },
    text: { type: ['string', 'null'] },
    items: { type: 'array', items: { type: 'string' } },
    ref: { type: ['integer', 'null'] },
    sourceLanguage,
  },
} as const;

const reference = {
  type: 'object',
  required: ['ref', 'activityId', 'sectionId', 'sectionTitle', 'title', 'type', 'sourceLanguage', 'matchesRequestedLanguage'],
  additionalProperties: false,
  properties: {
    ref: { type: 'integer' },
    activityId: uuid,
    sectionId: uuid,
    sectionTitle: { type: 'string' },
    title: { type: 'string' },
    type: { type: 'string', enum: ['page', 'file', 'link', 'quiz', 'assignment'] },
    sourceLanguage,
    matchesRequestedLanguage: { type: 'boolean' },
  },
} as const;

const followUps = { type: 'array', items: { type: 'string', enum: SUGGESTED_ACTION_VALUES } } as const;
const focus = {
  type: ['object', 'null'],
  required: ['activityId', 'title'],
  additionalProperties: false,
  properties: { activityId: uuid, title: { type: 'string' } },
} as const;
const guidedProvider = {
  type: 'object',
  required: ['mode', 'label'],
  additionalProperties: false,
  properties: { mode: { type: 'string', enum: ['guided_demo'] }, label: { type: 'string' } },
} as const;

export const tutorGuideResponseSchema = {
  type: 'object',
  required: ['provider', 'language', 'action', 'intent', 'grounding', 'variant', 'context', 'focus', 'blocks', 'references', 'practice', 'followUps', 'materials'],
  additionalProperties: false,
  properties: {
    provider: guidedProvider,
    language,
    action: { type: 'string', enum: GUIDE_ACTION_VALUES },
    /** For `ask`: the recognised request, or null. */
    intent: { type: ['string', 'null'], enum: [...SUGGESTED_ACTION_VALUES, null] },
    grounding: { type: 'string', enum: ['grounded', 'guidance', 'insufficient_material'] },
    variant: { type: 'integer' },
    context: {
      type: 'object',
      required: ['courseId', 'courseTitle', 'lesson'],
      additionalProperties: false,
      properties: {
        courseId: uuid,
        courseTitle: { type: 'string' },
        lesson: {
          type: ['object', 'null'],
          required: ['activityId', 'sectionId', 'sectionTitle', 'title', 'type', 'sourceLanguage'],
          additionalProperties: false,
          properties: {
            activityId: uuid,
            sectionId: uuid,
            sectionTitle: { type: 'string' },
            title: { type: 'string' },
            type: { type: 'string', enum: ['page', 'file'] },
            sourceLanguage,
          },
        },
      },
    },
    focus,
    blocks: { type: 'array', items: block },
    references: { type: 'array', items: reference },
    practice: {
      type: ['object', 'null'],
      required: ['questionId', 'kind', 'prompt', 'statement', 'options', 'ref'],
      additionalProperties: false,
      properties: {
        questionId: { type: 'string' },
        kind: { type: 'string', enum: ['term', 'source'] },
        prompt: { type: 'string' },
        statement: { type: 'string' },
        options: {
          type: 'array',
          items: { type: 'object', required: ['id', 'text'], additionalProperties: false, properties: { id: { type: 'string' }, text: { type: 'string' } } },
        },
        ref: { type: 'integer' },
      },
    },
    followUps,
    /** Only for `start`: the approved materials the caller may study, for choosing a lesson. */
    materials: {
      type: 'array',
      items: {
        type: 'object',
        required: ['activityId', 'sectionId', 'sectionTitle', 'title', 'type'],
        additionalProperties: false,
        properties: { activityId: uuid, sectionId: uuid, sectionTitle: { type: 'string' }, title: { type: 'string' }, type: { type: 'string', enum: ['page', 'file'] } },
      },
    },
  },
} as const;

export const tutorPracticeCheckSchema = {
  type: 'object',
  required: ['questionId', 'optionId', 'language'],
  additionalProperties: false,
  properties: {
    questionId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}~[0-9]{1,3}~[0-9a-f]{8}$' },
    optionId: { type: 'string', enum: ['a', 'b', 'c', 'd'] },
    language,
  },
} as const;

export const tutorPracticeCheckResponseSchema = {
  type: 'object',
  required: ['provider', 'language', 'status', 'correctOptionId', 'focus', 'blocks', 'references', 'followUps'],
  additionalProperties: false,
  properties: {
    provider: guidedProvider,
    language,
    status: { type: 'string', enum: ['correct', 'incorrect', 'unavailable'] },
    correctOptionId: { type: ['string', 'null'] },
    focus,
    blocks: { type: 'array', items: block },
    references: { type: 'array', items: reference },
    followUps,
  },
} as const;
