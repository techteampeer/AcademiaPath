import { codeSchema } from './course-schemas.js';

// JSON schemas mirroring the AP-038B course import endpoints in packages/contract/openapi.yaml.

const uuid = { type: 'string', format: 'uuid' } as const;
const nullableString = { type: ['string', 'null'] } as const;
const issue = {
  type: 'object',
  required: ['path', 'code', 'message'],
  additionalProperties: false,
  properties: { path: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' } },
} as const;
const skipped = {
  type: 'object',
  required: ['key', 'unitKey', 'type', 'title', 'reason'],
  additionalProperties: false,
  properties: {
    key: { type: 'string' },
    unitKey: { type: 'string' },
    type: { type: 'string' },
    title: { type: 'string' },
    reason: { type: 'string', enum: ['DOCUMENT_NOT_BUNDLED', 'UNSUPPORTED_ACTIVITY_TYPE'] },
  },
} as const;

export const importPreviewSchema = {
  type: 'object',
  required: [
    'valid',
    'format',
    'formatVersion',
    'supportedFormatVersion',
    'contentHash',
    'hashVerified',
    'source',
    'counts',
    'documents',
    'skipped',
    'unsupportedFields',
    'unsupportedFieldCount',
    'errors',
    'errorCount',
    'packageWarnings',
    'requiresAcknowledgement',
    'requiresDueDate',
  ],
  additionalProperties: false,
  properties: {
    valid: { type: 'boolean' },
    format: nullableString,
    formatVersion: { type: ['integer', 'null'] },
    supportedFormatVersion: { type: 'integer' },
    contentHash: nullableString,
    hashVerified: { type: 'boolean' },
    source: {
      type: 'object',
      required: ['title', 'description', 'courseCode', 'courseStatus', 'exportedAt'],
      additionalProperties: false,
      properties: { title: nullableString, description: nullableString, courseCode: nullableString, courseStatus: nullableString, exportedAt: nullableString },
    },
    counts: {
      type: 'object',
      required: ['units', 'folders', 'activities', 'activitiesByType', 'questions', 'importableActivities', 'skippedActivities', 'assignments'],
      additionalProperties: false,
      properties: {
        units: { type: 'integer' },
        folders: { type: 'integer' },
        activities: { type: 'integer' },
        activitiesByType: { type: 'object', additionalProperties: { type: 'integer' } },
        questions: { type: 'integer' },
        importableActivities: { type: 'integer' },
        skippedActivities: { type: 'integer' },
        assignments: { type: 'integer' },
      },
    },
    documents: {
      type: 'array',
      items: {
        type: 'object',
        required: ['assetKey', 'fileName', 'format', 'byteSize', 'sha256', 'availability', 'activityKeys'],
        additionalProperties: false,
        properties: {
          assetKey: { type: 'string' },
          fileName: { type: 'string' },
          format: { type: 'string' },
          byteSize: { type: 'integer' },
          sha256: { type: 'string' },
          availability: { type: 'string', enum: ['not_bundled', 'missing_at_source'] },
          activityKeys: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    skipped: { type: 'array', items: skipped },
    unsupportedFields: { type: 'array', items: { type: 'string' } },
    unsupportedFieldCount: { type: 'integer' },
    errors: { type: 'array', items: issue },
    errorCount: { type: 'integer' },
    packageWarnings: {
      type: 'array',
      items: { type: 'object', required: ['code', 'target'], additionalProperties: false, properties: { code: { type: 'string' }, target: { type: 'string' } } },
    },
    requiresAcknowledgement: { type: 'boolean' },
    requiresDueDate: { type: 'boolean' },
  },
} as const;

export const importCreateSchema = {
  type: 'object',
  required: ['package', 'programId', 'termId', 'code'],
  additionalProperties: false,
  properties: {
    package: { type: 'object' },
    programId: uuid,
    termId: uuid,
    code: codeSchema,
    title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    versionPreference: { type: 'string', enum: ['approved', 'working'], default: 'approved' },
    acknowledgeSkipped: { type: 'boolean', default: false },
    assignmentDueAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const importResultSchema = {
  type: 'object',
  required: ['course', 'created', 'skipped', 'contentHash'],
  additionalProperties: false,
  properties: {
    course: {
      type: 'object',
      required: ['id', 'code', 'title', 'status', 'programId', 'termId'],
      additionalProperties: false,
      properties: { id: uuid, code: { type: 'string' }, title: { type: 'string' }, status: { type: 'string', enum: ['draft'] }, programId: uuid, termId: uuid },
    },
    created: {
      type: 'object',
      required: ['units', 'folders', 'prerequisites', 'activities', 'questions'],
      additionalProperties: false,
      properties: { units: { type: 'integer' }, folders: { type: 'integer' }, prerequisites: { type: 'integer' }, activities: { type: 'integer' }, questions: { type: 'integer' } },
    },
    skipped: { type: 'array', items: skipped },
    contentHash: { type: 'string' },
  },
} as const;
