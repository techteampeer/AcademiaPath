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

// ---- AP-031D study brief (extractive; every text is the document's own wording with its location) ----

const briefLanguage = { type: ['string', 'null'], enum: ['en', 'es', null] } as const;
const briefReference = {
  type: 'object',
  required: ['segmentIndex', 'kind', 'label'],
  additionalProperties: false,
  properties: { segmentIndex: { type: 'integer' }, kind: { type: 'string', enum: ['page', 'slide', 'paragraph'] }, label: { type: 'string' } },
} as const;
const briefText = {
  type: 'object',
  required: ['text', 'ref', 'language', 'shortened'],
  additionalProperties: false,
  properties: { text: { type: 'string' }, ref: briefReference, language: briefLanguage, shortened: { type: 'boolean' } },
} as const;

export const studyBriefSchema = {
  type: 'object',
  required: ['activityId', 'courseId', 'title', 'version', 'generator', 'document', 'brief'],
  additionalProperties: false,
  properties: {
    activityId: uuid,
    courseId: uuid,
    title: { type: 'string' },
    version: { type: 'string', enum: ['working', 'approved'] },
    generator: {
      type: 'object',
      required: ['id', 'mode'],
      additionalProperties: false,
      properties: { id: { type: 'string' }, mode: { type: 'string', enum: ['extractive'] } },
    },
    document: {
      type: 'object',
      required: ['id', 'fileName', 'format', 'extraction'],
      additionalProperties: false,
      properties: {
        id: uuid,
        fileName: { type: 'string' },
        format: { type: 'string', enum: ['pdf', 'docx', 'pptx'] },
        extraction: {
          type: 'object',
          required: ['status', 'characterCount', 'segmentCount', 'truncated'],
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['extracted', 'no_text'] },
            characterCount: { type: 'integer' },
            segmentCount: { type: 'integer' },
            truncated: { type: 'boolean' },
          },
        },
      },
    },
    brief: {
      type: 'object',
      required: ['status', 'language', 'coverage', 'overview', 'outline', 'outlineTotal', 'keywords', 'concepts', 'excerpts', 'excerptsAvailable', 'reviewPoints', 'limitations', 'cleanup'],
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['complete', 'partial', 'excerpts_only', 'no_text'] },
        language: {
          type: 'object',
          required: ['primary', 'mixed'],
          additionalProperties: false,
          properties: { primary: briefLanguage, mixed: { type: 'boolean' } },
        },
        coverage: {
          type: 'object',
          required: ['processedSegments', 'totalSegments', 'processedCharacters', 'totalCharacters'],
          additionalProperties: false,
          properties: {
            processedSegments: { type: 'integer' },
            totalSegments: { type: 'integer' },
            processedCharacters: { type: 'integer' },
            totalCharacters: { type: 'integer' },
          },
        },
        overview: { type: 'array', items: briefText },
        outline: {
          type: 'array',
          items: { type: 'object', required: ['text', 'ref'], additionalProperties: false, properties: { text: { type: 'string' }, ref: briefReference } },
        },
        outlineTotal: { type: 'integer' },
        keywords: { type: 'array', items: { type: 'string' } },
        concepts: {
          type: 'array',
          items: {
            type: 'object',
            required: ['term', 'text', 'ref', 'language'],
            additionalProperties: false,
            properties: { term: { type: 'string' }, text: { type: 'string' }, ref: briefReference, language: briefLanguage },
          },
        },
        excerpts: { type: 'array', items: briefText },
        excerptsAvailable: { type: 'integer', minimum: 0 },
        reviewPoints: {
          type: 'array',
          items: {
            type: 'object',
            required: ['kind', 'term', 'items', 'ref', 'language'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['concept', 'list', 'section', 'excerpt'] },
              term: { type: ['string', 'null'] },
              items: { type: 'array', items: { type: 'string' } },
              ref: briefReference,
              language: briefLanguage,
            },
          },
        },
        limitations: {
          type: 'array',
          items: {
            type: 'object',
            required: ['code', 'processed', 'total'],
            additionalProperties: false,
            properties: {
              code: { type: 'string', enum: ['extraction_truncated', 'brief_limit', 'pages_without_text', 'few_sentences', 'no_text'] },
              processed: { type: ['integer', 'null'] },
              total: { type: ['integer', 'null'] },
            },
          },
        },
        cleanup: {
          type: 'object',
          required: ['repeatedLinesRemoved', 'duplicateSentencesRemoved'],
          additionalProperties: false,
          properties: { repeatedLinesRemoved: { type: 'integer' }, duplicateSentencesRemoved: { type: 'integer' } },
        },
      },
    },
  },
} as const;
