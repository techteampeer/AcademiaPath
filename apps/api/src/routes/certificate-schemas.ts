// JSON schemas mirroring the certificate operations in packages/contract/openapi.yaml (AP-024).
import { studentRefSchema } from './grading-schemas.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;

export const certificateParamsSchema = {
  type: 'object',
  required: ['certificateId'],
  additionalProperties: false,
  properties: { certificateId: uuid },
} as const;

export const courseCertificateParamsSchema = {
  type: 'object',
  required: ['id', 'certificateId'],
  additionalProperties: false,
  properties: { id: uuid, certificateId: uuid },
} as const;

/** Any string up to 200 characters: malformed tokens get the same generic answer as unknown ones. */
export const verifyParamsSchema = {
  type: 'object',
  required: ['token'],
  additionalProperties: false,
  properties: { token: { type: 'string', maxLength: 200 } },
} as const;

const policyRules = {
  enabled: { type: 'boolean' },
  requireCompletion: { type: 'boolean' },
  requireFinalGrade: { type: 'boolean' },
  minimumGradePercent: { type: ['integer', 'null'], minimum: 1, maximum: 100 },
  issuerName: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' },
} as const;

export const certificatePolicySchema = {
  type: 'object',
  required: ['configured', 'version', 'updatedAt', ...Object.keys(policyRules)],
  additionalProperties: false,
  properties: { configured: { type: 'boolean' }, version: { type: 'integer', minimum: 0 }, updatedAt: nullableDateTime, ...policyRules },
} as const;

export const certificatePolicyInputSchema = {
  type: 'object',
  required: ['expectedVersion', ...Object.keys(policyRules)],
  additionalProperties: false,
  properties: { expectedVersion: { type: 'integer', minimum: 0 }, ...policyRules },
} as const;

const requirement = {
  type: 'object',
  required: ['key', 'met', 'reason'],
  additionalProperties: false,
  properties: {
    key: { type: 'string', enum: ['policy_enabled', 'course_published', 'active_enrollment', 'activities_completed', 'final_grade_released', 'minimum_grade'] },
    met: { type: 'boolean' },
    reason: {
      type: ['string', 'null'],
      enum: ['not_configured', 'disabled', 'not_published', 'not_enrolled', 'inactive', 'no_activities', 'incomplete', 'no_graded_work', 'grades_pending', 'awaiting_final_grade', 'below_minimum', null],
    },
  },
} as const;

export const eligibilitySchema = {
  type: 'object',
  required: ['eligible', 'requirements', 'progress', 'releasedGrade'],
  additionalProperties: false,
  properties: {
    eligible: { type: 'boolean' },
    requirements: { type: 'array', items: requirement },
    progress: {
      type: 'object',
      required: ['completedCount', 'totalCount', 'percent'],
      additionalProperties: false,
      properties: { completedCount: { type: 'integer' }, totalCount: { type: 'integer' }, percent: { type: ['integer', 'null'] } },
    },
    releasedGrade: {
      type: 'object',
      required: ['status', 'percent', 'grade20', 'pendingItems'],
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['final', 'provisional'] },
        percent: { type: ['number', 'null'] },
        grade20: { type: ['number', 'null'] },
        pendingItems: { type: 'integer' },
      },
    },
  },
} as const;

const historyEvent = {
  type: 'object',
  required: ['action', 'at', 'actor', 'reason'],
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['certificate.issued', 'certificate.revoked'] },
    at: dateTime,
    actor: { type: ['object', 'null'], required: ['id', 'name'], additionalProperties: false, properties: { id: uuid, name: { type: 'string' } } },
    reason: { type: ['string', 'null'] },
  },
} as const;

export const certificateSchema = {
  type: 'object',
  required: [
    'id',
    'certificateNumber',
    'status',
    'courseId',
    'userId',
    'recipientName',
    'courseTitle',
    'courseCode',
    'programName',
    'termName',
    'academicYear',
    'issuerName',
    'issuedAt',
    'policyVersion',
    'policy',
    'verificationPath',
    'revokedAt',
    'revocationReason',
  ],
  additionalProperties: false,
  properties: {
    id: uuid,
    certificateNumber: { type: 'string' },
    status: { type: 'string', enum: ['issued', 'revoked'] },
    courseId: uuid,
    userId: uuid,
    recipientName: { type: 'string' },
    courseTitle: { type: 'string' },
    courseCode: { type: 'string' },
    programName: { type: ['string', 'null'] },
    termName: { type: 'string' },
    academicYear: { type: 'integer' },
    issuerName: { type: 'string' },
    issuedAt: dateTime,
    policyVersion: { type: 'integer' },
    policy: {
      type: 'object',
      required: ['requireCompletion', 'requireFinalGrade', 'minimumGradePercent'],
      additionalProperties: false,
      properties: { requireCompletion: { type: 'boolean' }, requireFinalGrade: { type: 'boolean' }, minimumGradePercent: { type: ['integer', 'null'] } },
    },
    verificationPath: { type: 'string' },
    revokedAt: nullableDateTime,
    revocationReason: { type: ['string', 'null'] },
    history: { type: 'array', items: historyEvent },
  },
} as const;

export const certificateListSchema = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: { items: { type: 'array', items: certificateSchema } },
} as const;

export const certificatePageSchema = {
  type: 'object',
  required: ['items', 'nextCursor'],
  additionalProperties: false,
  properties: { items: { type: 'array', items: certificateSchema }, nextCursor: { type: ['string', 'null'] } },
} as const;

export const adminCertificateQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['issued', 'revoked'] },
    courseId: uuid,
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    cursor: { type: 'string', maxLength: 500 },
  },
} as const;

export const issueInputSchema = {
  type: 'object',
  required: ['userId'],
  additionalProperties: false,
  properties: { userId: uuid },
} as const;

export const revokeInputSchema = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: { reason: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' } },
} as const;

const certificateRef = {
  type: ['object', 'null'],
  required: ['id', 'certificateNumber', 'status', 'issuedAt'],
  additionalProperties: false,
  properties: { id: uuid, certificateNumber: { type: 'string' }, status: { type: 'string', enum: ['issued', 'revoked'] }, issuedAt: dateTime },
} as const;

export const courseEligibilitySchema = {
  type: 'object',
  required: ['policy', 'items'],
  additionalProperties: false,
  properties: {
    policy: certificatePolicySchema,
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['student', 'eligibility', 'certificate'],
        additionalProperties: false,
        properties: { student: studentRefSchema, eligibility: eligibilitySchema, certificate: certificateRef },
      },
    },
  },
} as const;

/** What a student sees about a course: the rules (never a draft value), their own status, their certificates. */
export const myCourseCertificatesSchema = {
  type: 'object',
  required: ['policy', 'eligibility', 'certificates'],
  additionalProperties: false,
  properties: {
    policy: certificatePolicySchema,
    eligibility: { ...eligibilitySchema, type: ['object', 'null'] },
    certificates: { type: 'array', items: certificateSchema },
  },
} as const;

export const myCertificatesSchema = {
  type: 'object',
  required: ['certificates', 'courses'],
  additionalProperties: false,
  properties: {
    certificates: { type: 'array', items: certificateSchema },
    courses: {
      type: 'array',
      items: {
        type: 'object',
        required: ['courseId', 'title', 'code', 'certificatesEnabled', 'eligible', 'certificate'],
        additionalProperties: false,
        properties: {
          courseId: uuid,
          title: { type: 'string' },
          code: { type: 'string' },
          certificatesEnabled: { type: 'boolean' },
          eligible: { type: ['boolean', 'null'] },
          certificate: certificateRef,
        },
      },
    },
  },
} as const;

export const verificationSchema = {
  type: 'object',
  required: ['status', 'certificateNumber', 'recipientName', 'courseTitle', 'academicPeriod', 'issuerName', 'issuedAt', 'revokedAt'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['valid', 'revoked'] },
    certificateNumber: { type: 'string' },
    recipientName: { type: 'string' },
    courseTitle: { type: 'string' },
    academicPeriod: { type: 'string' },
    issuerName: { type: 'string' },
    issuedAt: dateTime,
    revokedAt: nullableDateTime,
  },
} as const;
