import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { recordAudit } from '../audit.js';
import { getPgError } from '../db/errors.js';
import {
  assignmentSubmissions,
  courses,
  enrollments,
  grades,
  quizAttempts,
  tutorUsage,
  courseCertificates,
  users,
  type CourseRole,
  type EnrollmentStatus,
  studentGroupMembers,
} from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';
import { isValidEmail, normalizeEmail } from '../users/accounts.js';
import { courseIdParamsSchema, enrollmentSchema } from './course-schemas.js';
import {
  enrollmentImportBodySchema,
  enrollmentImportResultSchema,
  enrollmentParamsSchema,
  enrollmentUpdateSchema,
  type ImportErrorCode,
} from './user-schemas.js';

type EnrollmentParams = { id: string; enrollmentId: string };
type ImportRow = { line: number; email: string; role: string | null; outcome: 'create' | 'unchanged' | 'error'; errorCode: ImportErrorCode | null };

export const MAX_IMPORT_ROWS = 500;
const COURSE_ROLES = new Set<string>(['design_team', 'instructor', 'non_editing_instructor', 'student']);

const enrollmentNotFound = () => new ApiProblem(404, 'NOT_FOUND', 'Enrollment not found.');

/** Strips optional surrounding double quotes from a simple CSV field. */
const unquote = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).trim() : trimmed;
};

/** Parses `email[,role]` lines (optional `email,role` header, blank lines ignored) without dropping any row. */
export function parseEnrollmentCsv(csv: string): ImportRow[] {
  const rows: ImportRow[] = [];
  const seen = new Set<string>();
  let headerChecked = false;
  csv.split(/\r?\n/).forEach((text, index) => {
    const line = index + 1;
    if (!text.trim()) return;
    const fields = text.split(',').map(unquote);
    if (!headerChecked) {
      headerChecked = true;
      if (fields[0]?.toLowerCase() === 'email' && (fields.length === 1 || fields[1]?.toLowerCase() === 'role')) return;
    }
    const email = normalizeEmail(fields[0] ?? '');
    const roleText = fields[1]?.trim().toLowerCase() || null;
    const error = (errorCode: ImportErrorCode) => rows.push({ line, email: fields[0] ?? '', role: roleText, outcome: 'error', errorCode });
    if (fields.length > 2) return void error('INVALID_ROW');
    if (!isValidEmail(email)) return void error('INVALID_EMAIL');
    if (roleText !== null && !COURSE_ROLES.has(roleText)) return void error('INVALID_ROLE');
    // Staff roles grant content and grading permissions: they are assigned one person at a time.
    if (roleText !== null && roleText !== 'student') return void error('ROLE_NOT_ALLOWED');
    if (seen.has(email)) return void error('DUPLICATE_ROW');
    seen.add(email);
    rows.push({ line, email, role: 'student', outcome: 'create', errorCode: null });
  });
  return rows;
}

const summarize = (rows: ImportRow[]) => ({
  total: rows.length,
  create: rows.filter((r) => r.outcome === 'create').length,
  unchanged: rows.filter((r) => r.outcome === 'unchanged').length,
  errors: rows.filter((r) => r.outcome === 'error').length,
});

/**
 * Administrator enrollment management beyond `POST /courses/:id/enrollments` (in courses.ts): changing a
 * course role or status, and a validated, previewable CSV import of student enrollments.
 */
export const enrollmentRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const adminWrite = { preValidation: [app.requireAuth, app.requireCsrf, app.requireAdministrator] };

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.put<{ Params: EnrollmentParams; Body: { role?: CourseRole; status?: EnrollmentStatus } }>(
    '/courses/:id/enrollments/:enrollmentId',
    { ...adminWrite, schema: { params: enrollmentParamsSchema, body: enrollmentUpdateSchema, response: { 200: enrollmentSchema } } },
    async (request) => {
      return db.transaction(async (tx) => {
        // Scoped to the course in the path: an enrollment of another course is "not found".
        const [row] = await tx
          .select({ enrollment: enrollments, user: { id: users.id, email: users.email, givenName: users.givenName, familyName: users.familyName, isActive: users.isActive } })
          .from(enrollments)
          .innerJoin(users, eq(users.id, enrollments.userId))
          .where(and(eq(enrollments.id, request.params.enrollmentId), eq(enrollments.courseId, request.params.id)))
          .for('update', { of: enrollments });
        if (!row) throw enrollmentNotFound();
        const { enrollment, user } = row;
        const role = request.body.role ?? enrollment.role;
        const status = request.body.status ?? enrollment.status;
        const { isActive: _isActive, ...publicUser } = user;
        const present = (e: typeof enrollment) => ({ id: e.id, courseId: e.courseId, role: e.role, status: e.status, createdAt: e.createdAt, user: publicUser });
        if (role === enrollment.role && status === enrollment.status) return present(enrollment);

        if (enrollment.role === 'student' && role !== 'student') {
          const hasWork = async () => {
            for (const table of [quizAttempts, assignmentSubmissions, grades]) {
              const [found] = await tx.select({ one: sql`1` }).from(table).where(eq(table.enrollmentId, enrollment.id)).limit(1);
              if (found) return true;
            }
            return false;
          };
          if (await hasWork()) {
            throw new ApiProblem(409, 'ENROLLMENT_HAS_STUDENT_WORK', 'This student has quiz attempts, submissions or grades in the course. Set the enrollment inactive instead.');
          }
        }
        if (status === 'active' && enrollment.status !== 'active' && !user.isActive) {
          throw new ApiProblem(422, 'USER_INACTIVE', 'The user account is not active.');
        }

        const [updated] = await tx.update(enrollments).set({ role, status }).where(eq(enrollments.id, enrollment.id)).returning();
        if (!updated) throw enrollmentNotFound();
        await recordAudit(tx, request, {
          action: 'enrollment.updated',
          entityType: 'enrollment',
          entityId: enrollment.id,
          before: { courseId: enrollment.courseId, userId: enrollment.userId, role: enrollment.role, status: enrollment.status },
          after: { courseId: updated.courseId, userId: updated.userId, role: updated.role, status: updated.status },
        });
        return present(updated);
      });
    },
  );

  app.delete<{ Params: EnrollmentParams }>(
    '/courses/:id/enrollments/:enrollmentId',
    { ...adminWrite, schema: { params: enrollmentParamsSchema } },
    async (request, reply) => {
      await db.transaction(async (tx) => {
        // Scoped to the course in the path: an enrollment of another course is "not found".
        const [enrollment] = await tx
          .select()
          .from(enrollments)
          .where(and(eq(enrollments.id, request.params.enrollmentId), eq(enrollments.courseId, request.params.id)))
          .for('update');
        if (!enrollment) throw enrollmentNotFound();
        // Only a mistaken enrollment without any history can be removed; history is never deleted.
        // AP-028: group memberships (current or past) are history too.
        const [membership] = await tx
          .select({ one: sql`1` })
          .from(studentGroupMembers)
          .where(and(eq(studentGroupMembers.courseId, enrollment.courseId), eq(studentGroupMembers.userId, enrollment.userId)))
          .limit(1);
        for (const table of [quizAttempts, assignmentSubmissions, grades, tutorUsage, courseCertificates]) {
          const [found] = membership ? [membership] : await tx.select({ one: sql`1` }).from(table).where(eq(table.enrollmentId, enrollment.id)).limit(1);
          if (found) {
            throw new ApiProblem(
              409,
              'ENROLLMENT_HAS_HISTORY',
              'This enrollment has quiz attempts, submissions, grades, tutor activity or certificates. Set it inactive instead; its history is kept.',
            );
          }
        }
        await tx.delete(enrollments).where(eq(enrollments.id, enrollment.id));
        await recordAudit(tx, request, {
          action: 'enrollment.deleted',
          entityType: 'enrollment',
          entityId: enrollment.id,
          before: { courseId: enrollment.courseId, userId: enrollment.userId, role: enrollment.role, status: enrollment.status },
          after: null,
        });
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: { csv: string; apply: boolean } }>(
    '/courses/:id/enrollments/import',
    { ...adminWrite, schema: { params: courseIdParamsSchema, body: enrollmentImportBodySchema, response: { 200: enrollmentImportResultSchema } } },
    async (request) => {
      const [course] = await db.select({ id: courses.id }).from(courses).where(eq(courses.id, request.params.id));
      if (!course) throw new ApiProblem(404, 'NOT_FOUND', 'Course not found.');
      const parsed = parseEnrollmentCsv(request.body.csv);
      if (parsed.length > MAX_IMPORT_ROWS) {
        throw new ApiProblem(422, 'IMPORT_TOO_LARGE', `Import at most ${MAX_IMPORT_ROWS} rows at a time.`);
      }

      const validate = async (executor: Pick<typeof db, 'select'>) => {
        const emails = parsed.filter((r) => r.outcome !== 'error').map((r) => r.email);
        const known = emails.length
          ? await executor
              .select({ email: sql<string>`lower(${users.email})`, id: users.id, isActive: users.isActive, role: enrollments.role, status: enrollments.status })
              .from(users)
              .leftJoin(enrollments, and(eq(enrollments.userId, users.id), eq(enrollments.courseId, course.id)))
              .where(sql`lower(${users.email}) IN (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})`)
          : [];
        const byEmail = new Map(known.map((k) => [k.email, k]));
        const rows = parsed.map((row): ImportRow & { userId?: string } => {
          if (row.outcome === 'error') return row;
          const match = byEmail.get(row.email);
          const fail = (errorCode: ImportErrorCode) => ({ ...row, outcome: 'error' as const, errorCode });
          if (!match) return fail('USER_NOT_FOUND');
          if (!match.isActive) return fail('USER_INACTIVE');
          if (match.role !== null && match.role !== 'student') return fail('ROLE_CONFLICT');
          if (match.role === 'student' && match.status !== 'active') return fail('ENROLLMENT_INACTIVE');
          if (match.role === 'student') return { ...row, outcome: 'unchanged' };
          return { ...row, userId: match.id };
        });
        return rows;
      };

      const report = (rows: Array<ImportRow & { userId?: string }>, applied: boolean) => ({
        applied,
        rows: rows.map(({ userId: _userId, ...row }) => row),
        summary: summarize(rows),
      });

      if (!request.body.apply) return report(await validate(db), false);

      try {
        return await db.transaction(async (tx) => {
          const rows = await validate(tx);
          const errors = rows.filter((r) => r.outcome === 'error').length;
          if (errors > 0) {
            throw new ApiProblem(422, 'IMPORT_HAS_ERRORS', `${errors} row(s) have errors, so nothing was applied. Preview the file to see them.`);
          }
          const toCreate = rows.filter((r) => r.outcome === 'create' && r.userId);
          for (const row of toCreate) {
            const [created] = await tx.insert(enrollments).values({ courseId: course.id, userId: row.userId!, role: 'student' }).returning();
            if (!created) throw new Error('Enrollment was not created');
            await recordAudit(tx, request, {
              action: 'enrollment.created',
              entityType: 'enrollment',
              entityId: created.id,
              before: null,
              after: { courseId: course.id, userId: created.userId, role: created.role, status: created.status, source: 'csv_import' },
            });
          }
          const summary = summarize(rows);
          await recordAudit(tx, request, {
            action: 'enrollments.imported',
            entityType: 'course',
            entityId: course.id,
            before: null,
            after: { created: summary.create, unchanged: summary.unchanged, total: summary.total },
          });
          return report(rows, true);
        });
      } catch (error) {
        // A concurrent enrollment made a validated row stale: the whole import rolled back.
        if (getPgError(error)?.code === '23505') {
          throw new ApiProblem(409, 'IMPORT_CONFLICT', 'Enrollments changed while importing; nothing was applied. Preview again.');
        }
        throw error;
      }
    },
  );
};
