import { courseRoleEnum, courseStatusEnum, enrollmentStatusEnum } from '../db/schema/index.js';
import { paginationQuerySchema } from '../http/pagination.js';

// JSON schemas mirroring packages/contract/openapi.yaml. Response schemas list every allowed
// property with additionalProperties: false, so serialization drops anything not declared here.

const uuid = { type: 'string', format: 'uuid' } as const;
const nullableUuid = { type: ['string', 'null'], format: 'uuid' } as const;
const nullableString = { type: ['string', 'null'] } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const name = { type: 'string', minLength: 1, maxLength: 200 } as const;
const longText = { type: 'string', maxLength: 2000 } as const;

export const codeSchema = { type: 'string', minLength: 1, maxLength: 32, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' } as const;

export const pageSchema = <T extends object>(item: T) =>
  ({
    type: 'object',
    required: ['items', 'nextCursor'],
    additionalProperties: false,
    properties: { items: { type: 'array', items: item }, nextCursor: nullableString },
  }) as const;

export const courseIdParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: uuid },
} as const;

export const programSchema = {
  type: 'object',
  required: ['id', 'code', 'name', 'description', 'isActive', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: uuid,
    code: { type: 'string' },
    name: { type: 'string' },
    description: nullableString,
    isActive: { type: 'boolean' },
    createdAt: dateTime,
    updatedAt: dateTime,
  },
} as const;

export const programCreateSchema = {
  type: 'object',
  required: ['code', 'name'],
  additionalProperties: false,
  properties: { code: codeSchema, name, description: longText },
} as const;

export const termSchema = {
  type: 'object',
  required: ['id', 'code', 'name', 'academicYear', 'startsOn', 'endsOn', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: uuid,
    code: { type: 'string' },
    name: { type: 'string' },
    academicYear: { type: 'integer' },
    startsOn: { type: 'string' },
    endsOn: { type: 'string' },
    createdAt: dateTime,
    updatedAt: dateTime,
  },
} as const;

export const termCreateSchema = {
  type: 'object',
  required: ['code', 'name', 'startsOn', 'endsOn'],
  additionalProperties: false,
  properties: {
    code: codeSchema,
    name,
    academicYear: { type: 'integer', minimum: 2000, maximum: 2100 },
    startsOn: { type: 'string', format: 'date' },
    endsOn: { type: 'string', format: 'date' },
  },
} as const;

const requiredText = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } as const;

export const termUpdateSchema = {
  type: 'object',
  required: ['name', 'startsOn', 'endsOn'],
  additionalProperties: false,
  properties: { name: requiredText, startsOn: { type: 'string', format: 'date' }, endsOn: { type: 'string', format: 'date' } },
} as const;

export const programUpdateSchema = {
  type: 'object',
  required: ['name', 'isActive'],
  additionalProperties: false,
  properties: { name: requiredText, description: { type: ['string', 'null'], maxLength: 2000 }, isActive: { type: 'boolean' } },
} as const;

export const programParamsSchema = { type: 'object', required: ['programId'], additionalProperties: false, properties: { programId: uuid } } as const;
export const termParamsSchema = { type: 'object', required: ['termId'], additionalProperties: false, properties: { termId: uuid } } as const;
export const templateParamsSchema = { type: 'object', required: ['templateId'], additionalProperties: false, properties: { templateId: uuid } } as const;

export const courseTemplateCreateSchema = {
  type: 'object',
  required: ['code', 'title', 'sections'],
  additionalProperties: false,
  properties: {
    code: codeSchema,
    programId: nullableUuid,
    title: name,
    description: longText,
    baseVersion: { type: 'integer', minimum: 0 },
    sections: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        required: ['title'],
        additionalProperties: false,
        properties: { title: name, summary: longText, isVisible: { type: 'boolean', default: true } },
      },
    },
  },
} as const;

const sectionSchema = {
  type: 'object',
  required: ['id', 'title', 'summary', 'position', 'isVisible'],
  additionalProperties: false,
  properties: {
    id: uuid,
    title: { type: 'string' },
    summary: nullableString,
    position: { type: 'integer' },
    isVisible: { type: 'boolean' },
  },
} as const;

export const courseTemplateVersionSchema = {
  type: 'object',
  required: ['id', 'templateId', 'programId', 'code', 'version', 'title', 'description', 'sections', 'createdAt'],
  additionalProperties: false,
  properties: {
    id: uuid,
    templateId: uuid,
    programId: nullableUuid,
    code: { type: 'string' },
    version: { type: 'integer' },
    title: { type: 'string' },
    description: nullableString,
    sections: { type: 'array', items: sectionSchema },
    createdAt: dateTime,
  },
} as const;

export const courseTemplateSchema = {
  type: 'object',
  required: ['id', 'programId', 'code', 'title', 'description', 'latestVersion', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: uuid,
    programId: nullableUuid,
    code: { type: 'string' },
    title: { type: 'string' },
    description: nullableString,
    latestVersion: {
      type: ['object', 'null'],
      required: ['id', 'version', 'createdAt'],
      additionalProperties: false,
      properties: { id: uuid, version: { type: 'integer' }, createdAt: dateTime },
    },
    createdAt: dateTime,
    updatedAt: dateTime,
  },
} as const;

export const courseSchema = {
  type: 'object',
  required: [
    'id',
    'programId',
    'termId',
    'templateId',
    'templateVersionId',
    'code',
    'title',
    'description',
    'status',
    'viewerRole',
    'version',
    'createdAt',
    'updatedAt',
  ],
  additionalProperties: false,
  properties: {
    id: uuid,
    programId: nullableUuid,
    termId: uuid,
    templateId: nullableUuid,
    templateVersionId: nullableUuid,
    code: { type: 'string' },
    title: { type: 'string' },
    description: nullableString,
    status: { type: 'string', enum: courseStatusEnum.enumValues },
    viewerRole: { type: ['string', 'null'], enum: [...courseRoleEnum.enumValues, null] },
    version: { type: 'integer', minimum: 1 },
    createdAt: dateTime,
    updatedAt: dateTime,
  },
} as const;

export const courseCreateSchema = {
  type: 'object',
  required: ['programId', 'termId', 'templateId', 'code'],
  additionalProperties: false,
  properties: {
    programId: uuid,
    termId: uuid,
    templateId: uuid,
    templateVersion: { type: 'integer', minimum: 1 },
    code: codeSchema,
    title: name,
    description: longText,
    status: { type: 'string', enum: ['draft', 'published'], default: 'draft' },
  },
} as const;

export const courseSectionSchema = sectionSchema;

export const enrollmentCreateSchema = {
  type: 'object',
  required: ['role'],
  additionalProperties: false,
  oneOf: [{ required: ['userId'] }, { required: ['email'] }],
  properties: {
    userId: uuid,
    email: { type: 'string', minLength: 1, maxLength: 254 },
    role: { type: 'string', enum: courseRoleEnum.enumValues },
  },
} as const;

export const enrollmentSchema = {
  type: 'object',
  required: ['id', 'courseId', 'role', 'status', 'user', 'createdAt'],
  additionalProperties: false,
  properties: {
    id: uuid,
    courseId: uuid,
    role: { type: 'string', enum: courseRoleEnum.enumValues },
    status: { type: 'string', enum: enrollmentStatusEnum.enumValues },
    user: {
      type: 'object',
      required: ['id', 'email', 'givenName', 'familyName'],
      additionalProperties: false,
      properties: { id: uuid, email: { type: 'string' }, givenName: { type: 'string' }, familyName: { type: 'string' } },
    },
    createdAt: dateTime,
  },
} as const;

export const courseTemplateDetailSchema = {
  type: 'object',
  required: ['id', 'programId', 'code', 'title', 'description', 'versionCount', 'latestVersion', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: uuid,
    programId: nullableUuid,
    code: { type: 'string' },
    title: { type: 'string' },
    description: nullableString,
    versionCount: { type: 'integer' },
    latestVersion: { ...courseTemplateVersionSchema, type: ['object', 'null'] },
    createdAt: dateTime,
    updatedAt: dateTime,
  },
} as const;

/** GET /courses: pagination plus optional hierarchy filters. */
export const courseListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { ...paginationQuerySchema.properties, termId: uuid, programId: uuid, templateId: uuid },
} as const;

/** GET /course-templates: pagination plus an optional program filter. */
export const courseTemplateListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { ...paginationQuerySchema.properties, programId: uuid },
} as const;

export const courseTemplateVersionListSchema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'version', 'title', 'description', 'sectionCount', 'createdAt'],
        additionalProperties: false,
        properties: {
          id: uuid,
          version: { type: 'integer' },
          title: { type: 'string' },
          description: nullableString,
          sectionCount: { type: 'integer' },
          createdAt: dateTime,
        },
      },
    },
  },
} as const;
