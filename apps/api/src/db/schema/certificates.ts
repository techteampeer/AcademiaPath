import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './columns.js';
import { courses, enrollments } from './courses.js';
import { certificateStatusEnum } from './enums.js';
import { users } from './users.js';

/**
 * A person whose printed name and official title appear on certificates (AP-043). Printed only: no
 * handwritten, scanned, electronic or cryptographic signature is produced or implied.
 */
export type CertificateSignatory = { name: string; title: string };

/** At most this many signatories per policy (and so per certificate). */
export const MAX_CERTIFICATE_SIGNATORIES = 3;

/**
 * The eligibility rules saved with every certificate (the policy version it was issued under), and, from
 * AP-043, its signatories in print order. Certificates issued before AP-043 have no `signatories`: none.
 */
export type CertificatePolicySnapshot = {
  version: number;
  requireCompletion: boolean;
  requireFinalGrade: boolean;
  minimumGradePercent: number | null;
  issuerName: string;
  signatories?: CertificateSignatory[];
};

/**
 * A course's certificate policy (AP-024). Without a row, or while `enabled` is false, no certificate can be
 * issued. At least one academic requirement is always set (checked); a minimum grade needs a final grade.
 * `version` increases on every save (optimistic concurrency) and is copied into each certificate.
 */
export const courseCertificatePolicies = pgTable(
  'course_certificate_policies',
  {
    courseId: uuid('course_id')
      .primaryKey()
      .references(() => courses.id, { onDelete: 'restrict' }),
    enabled: boolean('enabled').notNull(),
    requireCompletion: boolean('require_completion').notNull(),
    requireFinalGrade: boolean('require_final_grade').notNull(),
    minimumGradePercent: integer('minimum_grade_percent'),
    issuerName: text('issuer_name').notNull(),
    /** AP-043: up to three signatories in print order (validated by the API; the count is also checked here). */
    signatories: jsonb('signatories').$type<CertificateSignatory[]>().notNull().default([]),
    version: integer('version').notNull().default(1),
    updatedByUserId: uuid('updated_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (t) => [
    check('course_certificate_policies_requirement_check', sql`${t.requireCompletion} OR ${t.requireFinalGrade}`),
    check(
      'course_certificate_policies_minimum_check',
      sql`${t.minimumGradePercent} IS NULL OR (${t.minimumGradePercent} BETWEEN 1 AND 100 AND ${t.requireFinalGrade})`,
    ),
    check('course_certificate_policies_issuer_check', sql`char_length(${t.issuerName}) BETWEEN 1 AND 120`),
    check('course_certificate_policies_version_check', sql`${t.version} >= 1`),
    check(
      'course_certificate_policies_signatories_check',
      sql`CASE WHEN jsonb_typeof(${t.signatories}) = 'array' THEN jsonb_array_length(${t.signatories}) <= 3 ELSE false END`,
    ),
  ],
);

/**
 * An issued course completion certificate. Everything shown on the certificate is a snapshot taken at issue
 * time, so later changes to the course, the student's name or the policy never alter it. Rows are never
 * deleted and their snapshot never changes (trigger, migration 0025); the only change allowed is a single
 * revocation with a reason. At most one issued (not revoked) certificate exists per student and course.
 */
export const courseCertificates = pgTable(
  'course_certificates',
  {
    id: primaryId(),
    /** Public, opaque, random verification token (256 bits, base64url); never a sequential id. */
    verificationToken: text('verification_token').notNull(),
    /** Human-readable certificate number printed on the certificate (random, non-sequential). */
    certificateNumber: text('certificate_number').notNull(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    enrollmentId: uuid('enrollment_id').notNull(),
    recipientName: text('recipient_name').notNull(),
    courseTitle: text('course_title').notNull(),
    courseCode: text('course_code').notNull(),
    programName: text('program_name'),
    termName: text('term_name').notNull(),
    academicYear: integer('academic_year').notNull(),
    issuerName: text('issuer_name').notNull(),
    policyVersion: integer('policy_version').notNull(),
    policySnapshot: jsonb('policy_snapshot').$type<CertificatePolicySnapshot>().notNull(),
    status: certificateStatusEnum('status').notNull().default('issued'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    issuedByUserId: uuid('issued_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    revocationReason: text('revocation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('course_certificates_verification_token_unique').on(t.verificationToken),
    unique('course_certificates_number_unique').on(t.certificateNumber),
    // One valid certificate per course completion; a revoked one does not block a new issue.
    uniqueIndex('course_certificates_one_issued_unique').on(t.courseId, t.userId).where(sql`${t.status} = 'issued'`),
    index('course_certificates_user_idx').on(t.userId),
    index('course_certificates_course_idx').on(t.courseId),
    foreignKey({
      name: 'course_certificates_enrollment_fk',
      columns: [t.enrollmentId, t.courseId, t.userId],
      foreignColumns: [enrollments.id, enrollments.courseId, enrollments.userId],
    }).onDelete('restrict'),
    check('course_certificates_token_check', sql`${t.verificationToken} ~ '^[A-Za-z0-9_-]{43}$'`),
    check('course_certificates_number_check', sql`${t.certificateNumber} ~ '^AP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$'`),
    check(
      'course_certificates_revocation_check',
      sql`(${t.status} = 'issued' AND ${t.revokedAt} IS NULL AND ${t.revokedByUserId} IS NULL AND ${t.revocationReason} IS NULL)
        OR (${t.status} = 'revoked' AND ${t.revokedAt} IS NOT NULL AND ${t.revokedByUserId} IS NOT NULL AND char_length(${t.revocationReason}) BETWEEN 1 AND 500)`,
    ),
  ],
);

export type CertificateRecord = typeof courseCertificates.$inferSelect;
