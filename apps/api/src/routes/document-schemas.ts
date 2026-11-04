// JSON schemas mirroring the document endpoints in packages/contract/openapi.yaml.

const uuid = { type: 'string', format: 'uuid' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;

const summarySchema = {
  type: 'object',
  required: ['id', 'revision', 'status', 'provider', 'strategy', 'points', 'sourceCharacterCount', 'createdAt'],
  additionalProperties: false,
  properties: {
    id: uuid,
    revision: { type: 'integer' },
    status: { type: 'string', enum: ['ready', 'insufficient_text'] },
    provider: {
      type: 'object',
      required: ['id', 'mode', 'label'],
      additionalProperties: false,
      properties: { id: { type: 'string' }, mode: { type: 'string', enum: ['mock'] }, label: { type: 'string' } },
    },
    strategy: { type: 'string', enum: ['key_sentences', 'section_coverage'] },
    points: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'evidence'],
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          evidence: {
            type: 'object',
            required: ['segmentIndex', 'label', 'quote'],
            additionalProperties: false,
            properties: { segmentIndex: { type: 'integer' }, label: { type: 'string' }, quote: { type: 'string' } },
          },
        },
      },
    },
    sourceCharacterCount: { type: 'integer' },
    createdAt: dateTime,
  },
} as const;

const nullableSummary = { anyOf: [summarySchema, { type: 'null' }] } as const;

export const documentDetailSchema = {
  type: 'object',
  required: ['activityId', 'courseId', 'document', 'summary', 'liveSummary'],
  additionalProperties: false,
  properties: {
    activityId: uuid,
    courseId: uuid,
    document: {
      type: 'object',
      required: ['id', 'fileName', 'format', 'byteSize', 'uploadedAt', 'extraction', 'malwareScan', 'segments'],
      additionalProperties: false,
      properties: {
        id: uuid,
        fileName: { type: 'string' },
        format: { type: 'string', enum: ['pdf', 'docx', 'pptx'] },
        byteSize: { type: 'integer' },
        uploadedAt: dateTime,
        extraction: {
          type: 'object',
          required: ['status', 'detail', 'characterCount', 'segmentCount', 'truncated'],
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['extracted', 'no_text'] },
            detail: { type: ['string', 'null'] },
            characterCount: { type: 'integer' },
            segmentCount: { type: 'integer' },
            truncated: { type: 'boolean' },
          },
        },
        malwareScan: {
          type: 'object',
          required: ['status', 'scanner'],
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['not_scanned', 'clean'] }, scanner: { type: 'string' } },
        },
        segments: {
          type: 'array',
          items: {
            type: 'object',
            required: ['index', 'kind', 'label', 'text'],
            additionalProperties: false,
            properties: {
              index: { type: 'integer' },
              kind: { type: 'string', enum: ['page', 'slide', 'paragraph'] },
              label: { type: 'string' },
              text: { type: 'string' },
            },
          },
        },
      },
    },
    summary: nullableSummary,
    liveSummary: nullableSummary,
  },
} as const;
