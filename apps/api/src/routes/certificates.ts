import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import { notifyUsers } from '../messaging/notify.js';
import { canAsCourseRole, canInCourse, getCourseAccess, type CourseAccess, type CoursePermission } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import { eligibilityContext, evaluateEligibility, loadCertificatePolicy, policySnapshot, type CertificatePolicyRecord } from '../certificates/eligibility.js';
import { certificatePdf, verificationPath } from '../certificates/pdf.js';
import { newCertificateNumber, newVerificationToken, VERIFICATION_TOKEN_PATTERN } from '../certificates/tokens.js';
import type { Database } from '../db/client.js';
import { getPgError } from '../db/errors.js';
import {
  auditLog,
  courseCertificatePolicies,
  courseCertificates,
  courses,
  enrollments,
  programs,
  terms,
  users,
  type CertificateRecord,
} from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';
import { decodeCursor, toPage } from '../http/pagination.js';
import {
  adminCertificateQuerySchema,
  certificateListSchema,
  certificatePageSchema,
  certificateParamsSchema,
  certificatePolicyInputSchema,
  certificatePolicySchema,
  certificateSchema,
  courseCertificateParamsSchema,
  courseEligibilitySchema,
  issueInputSchema,
  myCertificatesSchema,
  myCourseCertificatesSchema,
  revokeInputSchema,
  verificationSchema,
  verifyParamsSchema,
} from './certificate-schemas.js';
import { courseParamsSchema } from './grading-schemas.js';

type PolicyBody = { expectedVersion: number; enabled: boolean; requireCompletion: boolean; requireFinalGrade: boolean; minimumGradePercent: number | null; issuerName: string };
type HistoryEvent = { action: 'certificate.issued' | 'certificate.revoked'; at: Date; actor: { id: string; name: string } | null; reason: string | null };

const notFound = (what: string) => new ApiProblem(404, 'NOT_FOUND', `${what} not found.`);
const forbidden = (detail: string) => new ApiProblem(403, 'FORBIDDEN', detail);
/** One answer for every unknown, malformed or foreign reference: nothing about other records is revealed. */
const certificateNotFound = () => new ApiProblem(404, 'CERTIFICATE_NOT_FOUND', 'No certificate matches this reference.');
const policyConflict = () => new ApiProblem(409, 'CERTIFICATE_POLICY_CONFLICT', 'The certificate policy was changed by someone else. Reload it and try again.');
const DEFAULT_ISSUER = 'AcademiaPath';
const studentColumns = { id: users.id, email: users.email, givenName: users.givenName, familyName: users.familyName };

/** The policy as returned by the API (defaults while the course has none: no certificates can be issued). */
function policyView(policy: CertificatePolicyRecord | null) {
  if (!policy) {
    return { configured: false, enabled: false, requireCompletion: true, requireFinalGrade: true, minimumGradePercent: null, issuerName: DEFAULT_ISSUER, version: 0, updatedAt: null };
  }
  return {
    configured: true,
    enabled: policy.enabled,
    requireCompletion: policy.requireCompletion,
    requireFinalGrade: policy.requireFinalGrade,
    minimumGradePercent: policy.minimumGradePercent,
    issuerName: policy.issuerName,
    version: policy.version,
    updatedAt: policy.updatedAt,
  };
}

/** A certificate exactly as stored (its snapshot); `history` only for staff and administrators. */
function certificateView(certificate: CertificateRecord, history?: HistoryEvent[]) {
  return {
    id: certificate.id,
    certificateNumber: certificate.certificateNumber,
    status: certificate.status,
    courseId: certificate.courseId,
    userId: certificate.userId,
    recipientName: certificate.recipientName,
    courseTitle: certificate.courseTitle,
    courseCode: certificate.courseCode,
    programName: certificate.programName,
    termName: certificate.termName,
    academicYear: certificate.academicYear,
    issuerName: certificate.issuerName,
    issuedAt: certificate.issuedAt,
    policyVersion: certificate.policyVersion,
    policy: {
      requireCompletion: certificate.policySnapshot.requireCompletion,
      requireFinalGrade: certificate.policySnapshot.requireFinalGrade,
      minimumGradePercent: certificate.policySnapshot.minimumGradePercent,
    },
    verificationPath: verificationPath(certificate.verificationToken),
    revokedAt: certificate.revokedAt,
    revocationReason: certificate.revocationReason,
    ...(history ? { history } : {}),
  };
}

const certificateRef = (certificate: CertificateRecord | undefined) =>
  certificate ? { id: certificate.id, certificateNumber: certificate.certificateNumber, status: certificate.status, issuedAt: certificate.issuedAt } : null;

export const certificateRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const authenticated = { preValidation: [app.requireAuth] };
  const authenticatedWrite = { preValidation: [app.requireAuth, app.requireCsrf] };

  async function courseAccess(request: FastifyRequest, courseId: string): Promise<CourseAccess> {
    const access = await getCourseAccess(db, getAuth(request).user, courseId);
    if (!access) throw notFound('Course');
    return access;
  }
  /** Staff permissions: a course role or the administrator override. Program-management grants never count. */
  function requirePermission(access: CourseAccess, permission: CoursePermission, detail: string) {
    if (!canInCourse(access, permission)) throw forbidden(detail);
  }

  async function history(executor: Pick<Database, 'select'>, certificateId: string): Promise<HistoryEvent[]> {
    const rows = await executor
      .select({
        action: auditLog.action,
        at: auditLog.createdAt,
        actorId: auditLog.actorUserId,
        givenName: users.givenName,
        familyName: users.familyName,
        reason: sql<string | null>`${auditLog.metadata} -> 'after' ->> 'reason'`,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(and(eq(auditLog.entityType, 'certificate'), eq(auditLog.entityId, certificateId), inArray(auditLog.action, ['certificate.issued', 'certificate.revoked'])))
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
    return rows.map((row) => ({
      action: row.action as HistoryEvent['action'],
      at: row.at,
      actor: row.actorId ? { id: row.actorId, name: `${row.givenName ?? ''} ${row.familyName ?? ''}`.trim() } : null,
      reason: row.reason,
    }));
  }

  /**
   * A certificate the caller may read: their own, or one of a course where they hold `certificates.view`
   * (or are an administrator). Anything else is "not found", so certificate ids cannot be probed.
   */
  async function readableCertificate(request: FastifyRequest, certificateId: string) {
    const { user } = getAuth(request);
    const [certificate] = await db.select().from(courseCertificates).where(eq(courseCertificates.id, certificateId));
    if (!certificate) throw certificateNotFound();
    if (certificate.userId === user.id) return { certificate, staff: false };
    const access = await getCourseAccess(db, user, certificate.courseId);
    if (!access || !canInCourse(access, 'certificates.view')) throw certificateNotFound();
    return { certificate, staff: true };
  }

  // ---- Certificate policy ----

  app.get<{ Params: { id: string } }>(
    '/courses/:id/certificate-policy',
    { ...authenticated, schema: { params: courseParamsSchema, response: { 200: certificatePolicySchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'certificates.view', 'You cannot view the certificate policy of this course.');
      return policyView(await loadCertificatePolicy(db, access.course.id));
    },
  );

  app.put<{ Params: { id: string }; Body: PolicyBody }>(
    '/courses/:id/certificate-policy',
    { ...authenticatedWrite, schema: { params: courseParamsSchema, body: certificatePolicyInputSchema, response: { 200: certificatePolicySchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'certificates.manage', 'Only instructors of this course and administrators can change the certificate policy.');
      const body = request.body;
      if (!body.requireCompletion && !body.requireFinalGrade) {
        throw new ApiProblem(422, 'CERTIFICATE_POLICY_INVALID', 'A certificate policy must require course completion, a final released grade, or both.');
      }
      if (body.minimumGradePercent !== null && !body.requireFinalGrade) {
        throw new ApiProblem(422, 'CERTIFICATE_POLICY_INVALID', 'A minimum course grade can only be checked against a final released grade: also require a final grade.');
      }
      const { user } = getAuth(request);
      const values = {
        enabled: body.enabled,
        requireCompletion: body.requireCompletion,
        requireFinalGrade: body.requireFinalGrade,
        minimumGradePercent: body.minimumGradePercent,
        issuerName: body.issuerName.trim(),
        updatedByUserId: user.id,
      };
      const saved = await db
        .transaction(async (tx) => {
          // The row lock serializes saves (and issuance reads it with a share lock); the version rejects stale edits.
          const before = await loadCertificatePolicy(tx, access.course.id, 'update');
          if ((before?.version ?? 0) !== body.expectedVersion) throw policyConflict();
          const [row] = before
            ? await tx
                .update(courseCertificatePolicies)
                .set({ ...values, version: sql`${courseCertificatePolicies.version} + 1` })
                .where(eq(courseCertificatePolicies.courseId, access.course.id))
                .returning()
            : await tx.insert(courseCertificatePolicies).values({ courseId: access.course.id, ...values }).onConflictDoNothing().returning();
          if (!row) throw policyConflict();
          await recordAudit(tx, request, {
            action: 'certificate_policy.updated',
            entityType: 'course',
            entityId: access.course.id,
            before: before ? policySnapshot(before) : null,
            after: { ...policySnapshot(row), enabled: row.enabled },
          });
          return row;
        })
        .catch((error: unknown) => {
          if (getPgError(error)?.code === '23505') throw policyConflict();
          throw error;
        });
      return policyView(saved);
    },
  );

  // ---- Eligibility (staff list, student own) ----

  app.get<{ Params: { id: string } }>(
    '/courses/:id/certificates/eligibility',
    { ...authenticated, schema: { params: courseParamsSchema, response: { 200: courseEligibilitySchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'certificates.view', 'You cannot view certificate eligibility in this course.');
      return db.transaction(
        async (tx) => {
          const context = await eligibilityContext(tx, access.course);
          const students = await tx
            .select(studentColumns)
            .from(enrollments)
            .innerJoin(users, eq(users.id, enrollments.userId))
            .where(and(eq(enrollments.courseId, access.course.id), eq(enrollments.role, 'student'), eq(enrollments.status, 'active')))
            .orderBy(asc(sql`lower(${users.email})`), asc(users.id));
          const issued = await tx
            .select()
            .from(courseCertificates)
            .where(and(eq(courseCertificates.courseId, access.course.id), eq(courseCertificates.status, 'issued')));
          const items = [];
          for (const student of students) {
            items.push({
              student,
              eligibility: await evaluateEligibility(tx, context, student.id),
              certificate: certificateRef(issued.find((certificate) => certificate.userId === student.id)),
            });
          }
          return { policy: policyView(context.policy), items };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    '/courses/:id/certificates/mine',
    { ...authenticated, schema: { params: courseParamsSchema, response: { 200: myCourseCertificatesSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      if (!canAsCourseRole(access, 'certificates.own')) throw forbidden('Only students of this course have certificates in it.');
      const { user } = getAuth(request);
      return db.transaction(
        async (tx) => {
          const context = await eligibilityContext(tx, access.course);
          const own = await tx
            .select()
            .from(courseCertificates)
            .where(and(eq(courseCertificates.courseId, access.course.id), eq(courseCertificates.userId, user.id)))
            .orderBy(desc(courseCertificates.issuedAt));
          return {
            policy: policyView(context.policy),
            // Released grades only: unreleased results never appear in an eligibility answer.
            eligibility: context.policy ? await evaluateEligibility(tx, context, user.id) : null,
            certificates: own.map((certificate) => certificateView(certificate)),
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },
  );

  app.get('/me/certificates', { ...authenticated, schema: { response: { 200: myCertificatesSchema } } }, async (request) => {
    const { user } = getAuth(request);
    const own = await db.select().from(courseCertificates).where(eq(courseCertificates.userId, user.id)).orderBy(desc(courseCertificates.issuedAt));
    // The courses the user studies (published, active student enrollment), with their certificate status.
    const studying = await db
      .select({ course: courses, enabled: courseCertificatePolicies.enabled })
      .from(enrollments)
      .innerJoin(courses, eq(courses.id, enrollments.courseId))
      .leftJoin(courseCertificatePolicies, eq(courseCertificatePolicies.courseId, courses.id))
      .where(and(eq(enrollments.userId, user.id), eq(enrollments.role, 'student'), eq(enrollments.status, 'active'), eq(courses.status, 'published')))
      .orderBy(asc(courses.title), asc(courses.id));
    const items = [];
    for (const row of studying) {
      const enabled = row.enabled === true;
      const eligible = enabled ? (await evaluateEligibility(db, await eligibilityContext(db, row.course), user.id)).eligible : null;
      items.push({
        courseId: row.course.id,
        title: row.course.title,
        code: row.course.code,
        certificatesEnabled: enabled,
        eligible,
        certificate: certificateRef(own.find((certificate) => certificate.courseId === row.course.id && certificate.status === 'issued')),
      });
    }
    return { certificates: own.map((certificate) => certificateView(certificate)), courses: items };
  });

  // ---- Issuance and revocation (staff) ----

  app.get<{ Params: { id: string } }>(
    '/courses/:id/certificates',
    { ...authenticated, schema: { params: courseParamsSchema, response: { 200: certificateListSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'certificates.view', 'You cannot view the certificates of this course.');
      const rows = await db.select().from(courseCertificates).where(eq(courseCertificates.courseId, access.course.id)).orderBy(desc(courseCertificates.issuedAt), asc(courseCertificates.id));
      return { items: rows.map((certificate) => certificateView(certificate)) };
    },
  );

  app.post<{ Params: { id: string }; Body: { userId: string } }>(
    '/courses/:id/certificates',
    { ...authenticatedWrite, schema: { params: courseParamsSchema, body: issueInputSchema, response: { 200: certificateSchema, 201: certificateSchema } } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'certificates.manage', 'Only instructors of this course and administrators can issue certificates.');
      const { user } = getAuth(request);
      const studentId = request.body.userId;
      const result = await db
        .transaction(async (tx) => {
          // Locks: the course (its status), the policy (its rules) and the student's enrollment, which serializes
          // every issuance for this student and course. Eligibility is then rechecked inside this transaction.
          const [course] = await tx.select().from(courses).where(eq(courses.id, access.course.id)).for('share');
          if (!course) throw notFound('Course');
          const [enrollment] = await tx
            .select()
            .from(enrollments)
            .where(and(eq(enrollments.courseId, course.id), eq(enrollments.userId, studentId), eq(enrollments.role, 'student')))
            .for('update');
          if (!enrollment) throw notFound('Student');
          // Idempotent: a valid certificate for this completion is returned as it is.
          const [existing] = await tx
            .select()
            .from(courseCertificates)
            .where(and(eq(courseCertificates.courseId, course.id), eq(courseCertificates.userId, studentId), eq(courseCertificates.status, 'issued')));
          if (existing) return { certificate: existing, created: false };
          const policy = await loadCertificatePolicy(tx, course.id, 'share');
          const eligibility = await evaluateEligibility(tx, await eligibilityContext(tx, course, policy), studentId);
          if (!eligibility.eligible || !policy) {
            const unmet = eligibility.requirements.filter((requirement) => !requirement.met).map((requirement) => requirement.key);
            throw new ApiProblem(422, 'CERTIFICATE_NOT_ELIGIBLE', `The student does not meet the certificate requirements: ${unmet.join(', ')}.`);
          }
          const [student] = await tx.select({ givenName: users.givenName, familyName: users.familyName }).from(users).where(eq(users.id, studentId));
          const [term] = await tx.select({ name: terms.name, academicYear: terms.academicYear }).from(terms).where(eq(terms.id, course.termId));
          const [program] = course.programId ? await tx.select({ name: programs.name }).from(programs).where(eq(programs.id, course.programId)) : [];
          if (!student || !term) throw new Error('Certificate snapshot data is missing');
          const [certificate] = await tx
            .insert(courseCertificates)
            .values({
              verificationToken: newVerificationToken(),
              certificateNumber: newCertificateNumber(),
              courseId: course.id,
              userId: studentId,
              enrollmentId: enrollment.id,
              recipientName: `${student.givenName} ${student.familyName}`.trim(),
              courseTitle: course.title,
              courseCode: course.code,
              programName: program?.name ?? null,
              termName: term.name,
              academicYear: term.academicYear,
              issuerName: policy.issuerName,
              policyVersion: policy.version,
              policySnapshot: policySnapshot(policy),
              issuedByUserId: user.id,
            })
            .returning();
          if (!certificate) throw new Error('Certificate was not recorded');
          await recordAudit(tx, request, {
            action: 'certificate.issued',
            entityType: 'certificate',
            entityId: certificate.id,
            before: null,
            after: {
              courseId: course.id,
              userId: studentId,
              certificateNumber: certificate.certificateNumber,
              policyVersion: certificate.policyVersion,
              requirements: eligibility.requirements.map((requirement) => requirement.key),
            },
          });
          await notifyUsers(tx, [studentId], {
            type: 'certificate_issued',
            courseId: course.id,
            entityId: certificate.id,
            dedupeKey: `certificate:${certificate.id}`,
            data: { courseTitle: course.title, courseCode: course.code },
            at: app.now(),
          });
          return { certificate, created: true };
        })
        .catch(async (error: unknown) => {
          // Backstop for a race: the partial unique index allows one valid certificate per completion.
          const pg = getPgError(error);
          if (pg?.code === '23505' && pg.constraint === 'course_certificates_one_issued_unique') {
            const [existing] = await db
              .select()
              .from(courseCertificates)
              .where(and(eq(courseCertificates.courseId, access.course.id), eq(courseCertificates.userId, studentId), eq(courseCertificates.status, 'issued')));
            if (existing) return { certificate: existing, created: false };
          }
          throw error;
        });
      return reply.code(result.created ? 201 : 200).send(certificateView(result.certificate, await history(db, result.certificate.id)));
    },
  );

  app.post<{ Params: { id: string; certificateId: string }; Body: { reason: string } }>(
    '/courses/:id/certificates/:certificateId/revoke',
    { ...authenticatedWrite, schema: { params: courseCertificateParamsSchema, body: revokeInputSchema, response: { 200: certificateSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      requirePermission(access, 'certificates.manage', 'Only instructors of this course and administrators can revoke certificates.');
      const { user } = getAuth(request);
      const reason = request.body.reason.trim();
      const revoked = await db.transaction(async (tx) => {
        const [certificate] = await tx
          .select()
          .from(courseCertificates)
          .where(and(eq(courseCertificates.id, request.params.certificateId), eq(courseCertificates.courseId, access.course.id)))
          .for('update');
        if (!certificate) throw certificateNotFound();
        if (certificate.status === 'revoked') throw new ApiProblem(409, 'CERTIFICATE_ALREADY_REVOKED', 'This certificate has already been revoked.');
        const [row] = await tx
          .update(courseCertificates)
          .set({ status: 'revoked', revokedAt: sql`now()`, revokedByUserId: user.id, revocationReason: reason })
          .where(and(eq(courseCertificates.id, certificate.id), eq(courseCertificates.status, 'issued')))
          .returning();
        if (!row) throw new ApiProblem(409, 'CERTIFICATE_ALREADY_REVOKED', 'This certificate has already been revoked.');
        await recordAudit(tx, request, {
          action: 'certificate.revoked',
          entityType: 'certificate',
          entityId: row.id,
          before: { status: 'issued' },
          after: { status: 'revoked', reason, courseId: row.courseId, userId: row.userId, certificateNumber: row.certificateNumber },
        });
        return row;
      });
      return certificateView(revoked, await history(db, revoked.id));
    },
  );

  // ---- One certificate: details and PDF (owner, course staff, administrators) ----

  app.get<{ Params: { certificateId: string } }>(
    '/certificates/:certificateId',
    { ...authenticated, schema: { params: certificateParamsSchema, response: { 200: certificateSchema } } },
    async (request) => {
      const { certificate, staff } = await readableCertificate(request, request.params.certificateId);
      return certificateView(certificate, staff ? await history(db, certificate.id) : undefined);
    },
  );

  app.get<{ Params: { certificateId: string } }>(
    '/certificates/:certificateId/pdf',
    { ...authenticated, schema: { params: certificateParamsSchema } },
    async (request, reply) => {
      const { certificate } = await readableCertificate(request, request.params.certificateId);
      // A revoked certificate is never handed out as a document that could look valid.
      if (certificate.status !== 'issued') throw new ApiProblem(409, 'CERTIFICATE_REVOKED', 'This certificate has been revoked and can no longer be downloaded.');
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="certificate-${certificate.certificateNumber}.pdf"`)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(certificatePdf(certificate));
    },
  );

  // ---- Administrators: every certificate ----

  app.get<{ Querystring: { status?: 'issued' | 'revoked'; courseId?: string; limit: number; cursor?: string } }>(
    '/certificates',
    { preValidation: [app.requireAuth, app.requireAdministrator], schema: { querystring: adminCertificateQuerySchema, response: { 200: certificatePageSchema } } },
    async (request) => {
      const { status, courseId, limit } = request.query;
      const after = decodeCursor(request.query.cursor, 'string');
      const rows = await db
        .select()
        .from(courseCertificates)
        .where(
          and(
            status ? eq(courseCertificates.status, status) : undefined,
            courseId ? eq(courseCertificates.courseId, courseId) : undefined,
            after ? sql`(${courseCertificates.issuedAt}, ${courseCertificates.id}) < (${after.key}::timestamptz, ${after.id}::uuid)` : undefined,
          ),
        )
        .orderBy(desc(courseCertificates.issuedAt), desc(courseCertificates.id))
        .limit(limit + 1);
      const page = toPage(rows, limit, (row) => [row.issuedAt.toISOString(), row.id]);
      return { items: page.items.map((certificate) => certificateView(certificate)), nextCursor: page.nextCursor };
    },
  );

  // ---- Public verification ----

  app.get<{ Params: { token: string } }>(
    '/certificates/verify/:token',
    {
      schema: { params: verifyParamsSchema, response: { 200: verificationSchema } },
      config: { rateLimit: { max: 60, timeWindow: 60_000, keyGenerator: (request: { ip: string }) => `verify:${request.ip}` } },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      // Strict shape check first; malformed and unknown tokens get the same generic answer.
      if (!VERIFICATION_TOKEN_PATTERN.test(request.params.token)) throw certificateNotFound();
      const [certificate] = await db.select().from(courseCertificates).where(eq(courseCertificates.verificationToken, request.params.token));
      if (!certificate) throw certificateNotFound();
      return {
        status: certificate.status === 'issued' ? ('valid' as const) : ('revoked' as const),
        certificateNumber: certificate.certificateNumber,
        recipientName: certificate.recipientName,
        courseTitle: certificate.courseTitle,
        academicPeriod: `${certificate.termName} (${certificate.academicYear})`,
        issuerName: certificate.issuerName,
        issuedAt: certificate.issuedAt,
        revokedAt: certificate.revokedAt,
      };
    },
  );
};

