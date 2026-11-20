import { ARCHIVE_ISSUE_CODES } from '../portability/archive-validation.js';
import { codeSchema } from './course-schemas.js';
import { importCountsSchema, skippedActivitySchema } from './course-import-schemas.js';

// JSON schema mirroring the AP-038C2C archive preview in packages/contract/openapi.yaml. Every object is closed
// (additionalProperties: false), so only these fields can ever be serialized.

const nullableString = { type: ['string', 'null'] } as const;
const integer = { type: 'integer' } as const;

export const archivePreviewReportSchema = {
  type: 'object',
  required: ['status', 'importMode', 'imported', 'archive', 'manifest', 'preview', 'issues', 'issueCount'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['valid', 'valid_with_warnings', 'invalid'] },
    importMode: { type: 'string', enum: ['new_draft_course'] },
    imported: { type: 'boolean', enum: [false] },
    archive: {
      type: 'object',
      required: ['byteSize', 'entries', 'uncompressedBytes'],
      additionalProperties: false,
      properties: { byteSize: integer, entries: integer, uncompressedBytes: { type: ['integer', 'null'] } },
    },
    manifest: {
      type: 'object',
      required: ['format', 'formatVersion'],
      additionalProperties: false,
      properties: { format: nullableString, formatVersion: { type: ['integer', 'null'] } },
    },
    preview: {
      type: ['object', 'null'],
      required: ['title', 'description', 'sourceCourseCode', 'exportedAt', 'counts', 'documents', 'documentsByFormat', 'documentBytes', 'skipped', 'requiresDueDate', 'packageWarnings'],
      additionalProperties: false,
      properties: {
        title: nullableString,
        description: nullableString,
        sourceCourseCode: nullableString,
        exportedAt: nullableString,
        counts: importCountsSchema,
        documents: {
          type: 'array',
          items: {
            type: 'object',
            required: ['key', 'fileName', 'format', 'byteSize', 'sha256', 'activityKeys'],
            additionalProperties: false,
            properties: {
              key: { type: 'string' },
              fileName: { type: 'string' },
              format: { type: 'string', enum: ['pdf', 'docx', 'pptx'] },
              byteSize: integer,
              sha256: { type: 'string' },
              activityKeys: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        documentsByFormat: {
          type: 'object',
          required: ['pdf', 'docx', 'pptx'],
          additionalProperties: false,
          properties: { pdf: integer, docx: integer, pptx: integer },
        },
        documentBytes: integer,
        skipped: { type: 'array', items: skippedActivitySchema },
        requiresDueDate: { type: 'boolean' },
        packageWarnings: {
          type: 'array',
          items: { type: 'object', required: ['code', 'target'], additionalProperties: false, properties: { code: { type: 'string' }, target: { type: 'string' } } },
        },
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'code', 'message', 'path'],
        additionalProperties: false,
        properties: { severity: { type: 'string', enum: ['error', 'warning'] }, code: { type: 'string', enum: [...ARCHIVE_ISSUE_CODES] }, message: { type: 'string' }, path: nullableString },
      },
    },
    issueCount: integer,
  },
} as const;

const uuid = { type: 'string', format: 'uuid' } as const;

/**
 * AP-038C2E: the confirmation's form fields (multipart values are strings, in any order with the `file` part), with the
 * JSON import's constraints. Nothing else from the client is read: no preview, plan or document is ever trusted.
 */
export const archiveImportFieldsSchema = {
  type: 'object',
  required: ['programId', 'termId', 'code'],
  additionalProperties: false,
  properties: {
    programId: uuid,
    termId: uuid,
    code: codeSchema,
    title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    versionPreference: { type: 'string', enum: ['approved', 'working'] },
    acknowledgeSkipped: { type: 'string', enum: ['true', 'false'] },
    assignmentDueAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const archiveImportResultSchema = {
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
      required: ['units', 'folders', 'prerequisites', 'activities', 'questions', 'documents'],
      additionalProperties: false,
      properties: { units: integer, folders: integer, prerequisites: integer, activities: integer, questions: integer, documents: integer },
    },
    skipped: { type: 'array', items: skippedActivitySchema },
    contentHash: nullableString,
  },
} as const;

/** AP-038C2F: whether `POST /course-imports/archive` is enabled on this server (ARCHIVE_IMPORT_ENABLED). */
export const archiveImportAvailabilitySchema = {
  type: 'object',
  required: ['enabled'],
  additionalProperties: false,
  properties: { enabled: { type: 'boolean' } },
} as const;
