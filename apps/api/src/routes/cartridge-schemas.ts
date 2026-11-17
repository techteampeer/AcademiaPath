import { CARTRIDGE_ISSUE_CODES, CLASSIFICATIONS, RESOURCE_KINDS } from '../cartridge/report.js';

const nullableString = { type: ['string', 'null'] } as const;
const nullableInteger = { type: ['integer', 'null'] } as const;
const count = { type: 'integer', minimum: 0 } as const;
const kind = { type: 'string', enum: [...RESOURCE_KINDS] } as const;
const classification = { type: 'string', enum: [...CLASSIFICATIONS] } as const;
const target = { type: ['string', 'null'], enum: ['section', 'lesson', 'document', 'quiz', 'assignment', 'forum', 'link', null] } as const;
const byKey = (keys: readonly string[]) => ({ type: 'object', additionalProperties: false, required: [...keys], properties: Object.fromEntries(keys.map((key) => [key, count])) }) as const;

/** AP-038D: the Common Cartridge inspection report (see src/cartridge/report.ts and CartridgeInspectionReport in the contract). */
export const cartridgeInspectionReportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'imported', 'format', 'version', 'declared', 'canvas', 'title', 'description', 'language', 'package', 'counts', 'modules', 'resources', 'compatibility', 'issues', 'issuesTruncated', 'listsTruncated'],
  properties: {
    status: { type: 'string', enum: ['valid', 'valid_with_warnings', 'invalid'] },
    imported: { type: 'boolean', enum: [false] },
    format: { type: 'string', enum: ['common_cartridge', 'thin_common_cartridge', 'scorm', 'ims_content_package', 'unknown'] },
    version: { type: ['string', 'null'], enum: ['1.0', '1.1', '1.2', '1.3', null] },
    declared: {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'schemaVersion', 'namespace'],
      properties: { schema: nullableString, schemaVersion: nullableString, namespace: nullableString },
    },
    canvas: {
      type: 'object',
      additionalProperties: false,
      required: ['detected', 'signals'],
      properties: { detected: { type: 'boolean' }, signals: { type: 'array', items: { type: 'string' } } },
    },
    title: nullableString,
    description: nullableString,
    language: nullableString,
    package: {
      type: 'object',
      additionalProperties: false,
      required: ['fileName', 'compressedBytes', 'uncompressedBytes', 'fileCount', 'folderCount'],
      properties: { fileName: nullableString, compressedBytes: count, uncompressedBytes: nullableInteger, fileCount: count, folderCount: count },
    },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: ['modules', 'outlineItems', 'resources', 'questions', 'externalLinks', 'brokenReferences', 'byKind', 'byClassification'],
      properties: {
        modules: count,
        outlineItems: count,
        resources: count,
        questions: count,
        externalLinks: count,
        brokenReferences: count,
        byKind: byKey(RESOURCE_KINDS),
        byClassification: byKey(CLASSIFICATIONS),
      },
    },
    modules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'itemCount', 'items'],
        properties: {
          title: nullableString,
          itemCount: count,
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'identifierref', 'kind', 'classification', 'depth'],
              properties: { title: nullableString, identifierref: nullableString, kind: { ...kind, type: ['string', 'null'], enum: [...RESOURCE_KINDS, null] }, classification: { ...classification, type: ['string', 'null'], enum: [...CLASSIFICATIONS, null] }, depth: count },
            },
          },
        },
      },
    },
    resources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['identifier', 'type', 'kind', 'classification', 'target', 'title', 'href', 'canvas', 'inOutline', 'fileCount', 'missingFileCount', 'dependencyCount', 'questionCount', 'questionTypes', 'url', 'submissionTypes', 'externalLinks', 'brokenLinks', 'canvasLinks'],
        properties: {
          identifier: nullableString,
          type: nullableString,
          kind,
          classification,
          target,
          title: nullableString,
          href: nullableString,
          canvas: { type: 'boolean' },
          inOutline: { type: 'boolean' },
          fileCount: count,
          missingFileCount: count,
          dependencyCount: count,
          questionCount: nullableInteger,
          questionTypes: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['type', 'count', 'supported'], properties: { type: { type: 'string' }, count, supported: { type: 'boolean' } } },
          },
          url: nullableString,
          submissionTypes: { type: 'array', items: { type: 'string' } },
          externalLinks: count,
          brokenLinks: count,
          canvasLinks: count,
        },
      },
    },
    compatibility: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'count', 'target', 'support'],
        properties: { kind: { type: 'string', enum: ['module', ...RESOURCE_KINDS] }, count, target, support: { type: 'string', enum: ['direct', 'transform', 'new_functionality', 'unsupported'] } },
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'severity', 'message', 'path', 'line', 'limit', 'value'],
        properties: {
          code: { type: 'string', enum: CARTRIDGE_ISSUE_CODES },
          severity: { type: 'string', enum: ['error', 'warning'] },
          message: { type: 'string' },
          path: nullableString,
          line: nullableInteger,
          limit: nullableInteger,
          value: nullableString,
        },
      },
    },
    issuesTruncated: { type: 'boolean' },
    listsTruncated: { type: 'boolean' },
  },
} as const;
