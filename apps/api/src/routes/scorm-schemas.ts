import { ISSUE_CODES } from '../scorm/report.js';

const nullableString = { type: ['string', 'null'] } as const;
const nullableInteger = { type: ['integer', 'null'] } as const;
const count = { type: 'integer', minimum: 0 } as const;

/** AP-033B: the SCORM inspection report (see src/scorm/report.ts and ScormInspectionReport in the contract). */
export const scormInspectionReportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reportVersion', 'status', 'imported', 'package', 'standard', 'title', 'manifestIdentifier', 'counts', 'organizations', 'launchable', 'resources', 'features', 'runtime', 'issues', 'issuesTruncated', 'listsTruncated'],
  properties: {
    reportVersion: { type: 'integer', enum: [1] },
    status: { type: 'string', enum: ['valid', 'valid_with_warnings', 'invalid'] },
    imported: { type: 'boolean', enum: [false] },
    package: {
      type: 'object',
      additionalProperties: false,
      required: ['fileName', 'sha256', 'compressedBytes', 'uncompressedBytes', 'fileCount', 'folderCount'],
      properties: { fileName: nullableString, sha256: { type: 'string' }, compressedBytes: count, uncompressedBytes: nullableInteger, fileCount: count, folderCount: count },
    },
    standard: {
      type: 'object',
      additionalProperties: false,
      required: ['format', 'version', 'edition', 'schemaVersion'],
      properties: {
        format: { type: 'string', enum: ['scorm', 'common_cartridge', 'unknown'] },
        version: { type: ['string', 'null'], enum: ['scorm_1_2', 'scorm_2004', null] },
        edition: { type: ['string', 'null'], enum: ['2nd', '3rd', '4th', null] },
        schemaVersion: nullableString,
      },
    },
    title: nullableString,
    manifestIdentifier: nullableString,
    counts: {
      type: 'object',
      additionalProperties: false,
      required: ['organizations', 'items', 'resources', 'scos', 'assets', 'launchable', 'declaredFiles', 'missingFiles', 'undeclaredFiles'],
      properties: { organizations: count, items: count, resources: count, scos: count, assets: count, launchable: count, declaredFiles: count, missingFiles: count, undeclaredFiles: count },
    },
    organizations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['identifier', 'title', 'isDefault', 'itemCount'],
        properties: { identifier: { type: 'string' }, title: nullableString, isDefault: { type: 'boolean' }, itemCount: count },
      },
    },
    launchable: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['organization', 'item', 'title', 'resource', 'scormType', 'launchPath', 'parameters', 'visible'],
        properties: {
          organization: { type: 'string' },
          item: { type: 'string' },
          title: nullableString,
          resource: { type: 'string' },
          scormType: { type: 'string', enum: ['sco', 'asset'] },
          launchPath: { type: 'string' },
          parameters: nullableString,
          visible: { type: 'boolean' },
        },
      },
    },
    resources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['identifier', 'scormType', 'launchPath', 'fileCount', 'missingFileCount', 'dependencyCount'],
        properties: { identifier: { type: 'string' }, scormType: { type: 'string', enum: ['sco', 'asset'] }, launchPath: nullableString, fileCount: count, missingFileCount: count, dependencyCount: count },
      },
    },
    features: {
      type: 'object',
      additionalProperties: false,
      required: ['sequencing', 'subManifests'],
      properties: { sequencing: { type: 'boolean' }, subManifests: { type: 'boolean' } },
    },
    runtime: {
      type: 'object',
      additionalProperties: false,
      required: ['playbackAvailable', 'plannedSupport'],
      properties: {
        playbackAvailable: { type: 'boolean', enum: [false] },
        plannedSupport: { type: 'string', enum: ['planned', 'planned_without_sequencing', 'not_supported'] },
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'severity', 'message', 'path', 'line', 'limit', 'value'],
        properties: {
          code: { type: 'string', enum: ISSUE_CODES },
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
