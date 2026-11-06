// JSON schemas mirroring the user-management endpoints in packages/contract/openapi.yaml.
import { courseRoleEnum, courseStatusEnum, localeEnum, systemRoleEnum } from '../db/schema/index.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;
const personName = { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' } as const;
/** Trimmed and validated by the handler (surrounding spaces are allowed and removed). */
const email = { type: 'string', minLength: 3, maxLength: 254 } as const;
const systemRole = { type: 'string', enum: systemRoleEnum.enumValues } as const;
const locale = { type: 'string', enum: localeEnum.enumValues } as const;
const courseRole = { type: 'string', enum: courseRoleEnum.enumValues } as const;
const activationState = { type: 'string', enum: ['activated', 'pending'] } as const;
const enrollmentStatus = { type: 'string', enum: ['active', 'inactive'] } as const;
/** Upper bound only; the handler checks the exact shape so every malformed token gets the same answer. */
const token = { type: 'string', minLength: 1, maxLength: 128 } as const;

export const userIdParamsSchema = {
  type: 'object',
  required: ['userId'],
  additionalProperties: false,
  properties: { userId: uuid },
} as const;

export const userListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', minLength: 1, maxLength: 100 },
    status: enrollmentStatus,
    activation: activationState,
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
  },
} as const;

const summaryProperties = {
  id: uuid,
  email: { type: 'string' },
  givenName: { type: 'string' },
  familyName: { type: 'string' },
  systemRole,
  isActive: { type: 'boolean' },
  activationState,
  activeEnrollmentCount: { type: 'integer', minimum: 0 },
  courseRoles: { type: 'array', items: courseRole },
  createdAt: dateTime,
} as const;

export const userSummarySchema = {
  type: 'object',
  required: Object.keys(summaryProperties),
  additionalProperties: false,
  properties: summaryProperties,
} as const;

export const userPageSchema = {
  type: 'object',
  required: ['items', 'nextCursor'],
  additionalProperties: false,
  properties: { items: { type: 'array', items: userSummarySchema }, nextCursor: { type: ['string', 'null'] } },
} as const;

const userEnrollmentSchema = {
  type: 'object',
  required: ['id', 'courseId', 'courseCode', 'courseTitle', 'courseStatus', 'termCode', 'role', 'status', 'createdAt'],
  additionalProperties: false,
  properties: {
    id: uuid,
    courseId: uuid,
    courseCode: { type: 'string' },
    courseTitle: { type: 'string' },
    courseStatus: { type: 'string', enum: courseStatusEnum.enumValues },
    termCode: { type: 'string' },
    role: courseRole,
    status: enrollmentStatus,
    createdAt: dateTime,
  },
} as const;

const detailProperties = {
  ...summaryProperties,
  institutionalId: { type: ['string', 'null'] },
  preferredLocale: locale,
  updatedAt: dateTime,
  activation: {
    type: 'object',
    required: ['state', 'activatedAt', 'pendingInvitation'],
    additionalProperties: false,
    properties: {
      state: activationState,
      activatedAt: nullableDateTime,
      pendingInvitation: {
        type: ['object', 'null'],
        required: ['id', 'createdAt', 'expiresAt', 'expired'],
        additionalProperties: false,
        properties: { id: uuid, createdAt: dateTime, expiresAt: dateTime, expired: { type: 'boolean' } },
      },
    },
  },
  enrollments: { type: 'array', items: userEnrollmentSchema },
} as const;

export const userDetailSchema = {
  type: 'object',
  required: Object.keys(detailProperties),
  additionalProperties: false,
  properties: detailProperties,
} as const;

export const userCreateSchema = {
  type: 'object',
  required: ['email', 'givenName', 'familyName'],
  additionalProperties: false,
  properties: {
    email,
    givenName: personName,
    familyName: personName,
    systemRole: { ...systemRole, default: 'user' },
    preferredLocale: { ...locale, default: 'es' },
    enrollments: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['courseId', 'role'],
        additionalProperties: false,
        properties: { courseId: uuid, role: courseRole },
      },
    },
  },
} as const;

export const userUpdateSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: { email, givenName: personName, familyName: personName, systemRole, preferredLocale: locale },
} as const;

export const accountInvitationSchema = {
  type: 'object',
  required: ['id', 'expiresAt', 'delivery', 'activationPath'],
  additionalProperties: false,
  properties: { id: uuid, expiresAt: dateTime, delivery: { type: 'string', enum: ['local_link'] }, activationPath: { type: 'string' } },
} as const;

export const userCreateResultSchema = {
  type: 'object',
  required: ['user', 'invitation', 'invitationStatus'],
  additionalProperties: false,
  properties: {
    user: userDetailSchema,
    invitation: { ...accountInvitationSchema, type: ['object', 'null'] },
    invitationStatus: { type: 'string', enum: ['issued', 'disabled', 'synthetic_only'] },
  },
} as const;

export const activationPreviewBodySchema = {
  type: 'object',
  required: ['token'],
  additionalProperties: false,
  properties: { token },
} as const;

export const activationPreviewSchema = {
  type: 'object',
  required: ['email', 'givenName', 'familyName', 'expiresAt'],
  additionalProperties: false,
  properties: { email: { type: 'string' }, givenName: { type: 'string' }, familyName: { type: 'string' }, expiresAt: dateTime },
} as const;

export const activationBodySchema = {
  type: 'object',
  required: ['token', 'password'],
  additionalProperties: false,
  properties: { token, password: { type: 'string', minLength: 12, maxLength: 256 } },
} as const;

export const enrollmentParamsSchema = {
  type: 'object',
  required: ['id', 'enrollmentId'],
  additionalProperties: false,
  properties: { id: uuid, enrollmentId: uuid },
} as const;

export const enrollmentUpdateSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: { role: courseRole, status: enrollmentStatus },
} as const;

export const enrollmentImportBodySchema = {
  type: 'object',
  required: ['csv'],
  additionalProperties: false,
  properties: { csv: { type: 'string', minLength: 1, maxLength: 100_000 }, apply: { type: 'boolean', default: false } },
} as const;

export const IMPORT_ERROR_CODES = [
  'INVALID_ROW',
  'INVALID_EMAIL',
  'INVALID_ROLE',
  'ROLE_NOT_ALLOWED',
  'DUPLICATE_ROW',
  'USER_NOT_FOUND',
  'USER_INACTIVE',
  'ROLE_CONFLICT',
  'ENROLLMENT_INACTIVE',
] as const;
export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

export const enrollmentImportResultSchema = {
  type: 'object',
  required: ['applied', 'rows', 'summary'],
  additionalProperties: false,
  properties: {
    applied: { type: 'boolean' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        required: ['line', 'email', 'role', 'outcome', 'errorCode'],
        additionalProperties: false,
        properties: {
          line: { type: 'integer' },
          email: { type: 'string' },
          role: { type: ['string', 'null'] },
          outcome: { type: 'string', enum: ['create', 'unchanged', 'error'] },
          errorCode: { type: ['string', 'null'], enum: [...IMPORT_ERROR_CODES, null] },
        },
      },
    },
    summary: {
      type: 'object',
      required: ['total', 'create', 'unchanged', 'errors'],
      additionalProperties: false,
      properties: { total: { type: 'integer' }, create: { type: 'integer' }, unchanged: { type: 'integer' }, errors: { type: 'integer' } },
    },
  },
} as const;
