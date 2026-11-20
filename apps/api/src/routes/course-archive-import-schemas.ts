import { ARCHIVE_ISSUE_CODES } from '../portability/archive-validation.js';
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
