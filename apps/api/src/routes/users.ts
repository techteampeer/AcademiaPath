import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import { getAuth } from '../auth/hooks.js';
import { withUniqueConflict } from '../db/errors.js';
import { courses, enrollments, users, type CourseRole, type Locale, type SystemRole } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';
import { decodeCursor, toPage } from '../http/pagination.js';
import {
  activationPath,
  countOtherActiveAdministrators,
  hasCredentialSql,
  hasControlCharacters,
  hasPassword,
  isSyntheticAddress,
  isValidEmail,
  issueInvitation,
  loadUserDetail,
  lockAdministratorChanges,
  normalizeEmail,
  revokeOpenInvitations,
  revokeUserSessions,
  userSummaryColumns,
} from '../users/accounts.js';
import {
  accountInvitationSchema,
  userCreateResultSchema,
  userCreateSchema,
  userDetailSchema,
  userIdParamsSchema,
  userListQuerySchema,
  userPageSchema,
  userUpdateSchema,
} from './user-schemas.js';

type UserParams = { userId: string };
type ListQuery = { q?: string; status?: 'active' | 'inactive'; activation?: 'activated' | 'pending'; limit: number; cursor?: string };
type CreateBody = {
  email: string;
  givenName: string;
  familyName: string;
  systemRole: SystemRole;
  preferredLocale: Locale;
  enrollments?: Array<{ courseId: string; role: CourseRole }>;
};
type UpdateBody = Partial<{ email: string; givenName: string; familyName: string; systemRole: SystemRole; preferredLocale: Locale }>;

const userNotFound = () => new ApiProblem(404, 'NOT_FOUND', 'User not found.');
const invalid = (detail: string) => new ApiProblem(400, 'VALIDATION_ERROR', detail);

/** Escapes LIKE wildcards so a search for "a_b" or "100%" matches literally. */
const likePattern = (value: string) => `%${value.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function cleanEmail(raw: string): string {
  const value = normalizeEmail(raw);
  if (!isValidEmail(value)) throw invalid('Enter a valid email address.');
  return value;
}

function cleanName(raw: string, field: string): string {
  const value = raw.trim();
  if (!value || hasControlCharacters(value)) throw invalid(`Enter a valid ${field}.`);
  return value;
}

/**
 * Administrator-managed accounts. Every route requires an authenticated administrator; writes also
 * require the session's CSRF token (and, globally, an allowed Origin). Course instructors and other
 * course roles have no access here.
 */
export const userRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app;
  const adminRead = { preValidation: [app.requireAuth, app.requireAdministrator] };
  const adminWrite = { preValidation: [app.requireAuth, app.requireCsrf, app.requireAdministrator] };

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  const detailOrThrow = async (userId: string) => {
    const detail = await loadUserDetail(db, userId);
    if (!detail) throw userNotFound();
    return detail;
  };

  // ---- Directory ----

  app.get<{ Querystring: ListQuery }>(
    '/users',
    { ...adminRead, schema: { querystring: userListQuerySchema, response: { 200: userPageSchema } } },
    async (request) => {
      const { q, status, activation, limit } = request.query;
      const after = decodeCursor(request.query.cursor, 'string');
      const emailKey = sql<string>`lower(${users.email})`;
      const pattern = q ? likePattern(q.trim()) : null;
      const rows = await db
        .select({ ...userSummaryColumns, emailKey })
        .from(users)
        .where(
          and(
            pattern
              ? sql`(lower(${users.email}) LIKE ${pattern} ESCAPE '\\' OR lower(${users.givenName} || ' ' || ${users.familyName}) LIKE ${pattern} ESCAPE '\\')`
              : undefined,
            status ? eq(users.isActive, status === 'active') : undefined,
            activation === 'pending' ? sql`NOT ${hasCredentialSql}` : activation === 'activated' ? hasCredentialSql : undefined,
            after ? sql`(${emailKey}, ${users.id}) > (${after.key}, ${after.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(emailKey), asc(users.id))
        .limit(limit + 1);
      const page = toPage(rows, limit, (row) => [row.emailKey, row.id]);
      return { items: page.items.map(({ emailKey: _key, ...user }) => user), nextCursor: page.nextCursor };
    },
  );

  app.get<{ Params: UserParams }>(
    '/users/:userId',
    { ...adminRead, schema: { params: userIdParamsSchema, response: { 200: userDetailSchema } } },
    async (request) => detailOrThrow(request.params.userId),
  );

  // ---- Create ----

  app.post<{ Body: CreateBody }>(
    '/users',
    { ...adminWrite, schema: { body: userCreateSchema, response: { 201: userCreateResultSchema } } },
    async (request, reply) => {
      const auth = getAuth(request);
      const email = cleanEmail(request.body.email);
      const givenName = cleanName(request.body.givenName, 'given name');
      const familyName = cleanName(request.body.familyName, 'family name');
      const { systemRole, preferredLocale } = request.body;
      const initial = request.body.enrollments ?? [];
      if (new Set(initial.map((e) => e.courseId)).size !== initial.length) {
        throw new ApiProblem(422, 'DUPLICATE_COURSE', 'Each course can be listed only once (one role per course).');
      }
      const delivery = config.accounts.invitationDelivery;
      const invitationStatus = delivery === 'disabled' ? 'disabled' : isSyntheticAddress(email) ? 'issued' : 'synthetic_only';

      const { userId, invitation } = await db.transaction(async (tx) => {
        const [created] = await withUniqueConflict(
          () => tx.insert(users).values({ email, givenName, familyName, systemRole, preferredLocale, isActive: true }).returning(),
          'users_email_lower_unique',
          'EMAIL_TAKEN',
          'An account with this email already exists.',
        );
        if (!created) throw new Error('User was not created');
        await recordAudit(tx, request, {
          action: 'user.created',
          entityType: 'user',
          entityId: created.id,
          before: null,
          after: { email, givenName, familyName, systemRole, preferredLocale, isActive: true },
        });

        if (initial.length) {
          const found = await tx.select({ id: courses.id }).from(courses).where(inArray(courses.id, initial.map((e) => e.courseId)));
          if (found.length !== initial.length) throw new ApiProblem(422, 'COURSE_NOT_FOUND', 'A selected course does not exist.');
          for (const { courseId, role } of initial) {
            const [enrollment] = await tx.insert(enrollments).values({ courseId, userId: created.id, role }).returning();
            if (!enrollment) throw new Error('Enrollment was not created');
            await recordAudit(tx, request, {
              action: 'enrollment.created',
              entityType: 'enrollment',
              entityId: enrollment.id,
              before: null,
              after: { courseId, userId: created.id, role, status: enrollment.status },
            });
          }
        }

        let issued: Awaited<ReturnType<typeof issueInvitation>> | null = null;
        if (invitationStatus === 'issued') {
          issued = await issueInvitation(tx, { userId: created.id, createdByUserId: auth.user.id, ttlHours: config.accounts.invitationTtlHours });
          await auditInvitation(tx, request, created.id, issued);
        }
        return { userId: created.id, invitation: issued };
      });

      return reply.code(201).send({
        user: await detailOrThrow(userId),
        invitation: invitation ? { id: invitation.id, expiresAt: invitation.expiresAt, delivery: 'local_link', activationPath: activationPath(invitation.token) } : null,
        invitationStatus,
      });
    },
  );

  // ---- Update ----

  app.put<{ Params: UserParams; Body: UpdateBody }>(
    '/users/:userId',
    { ...adminWrite, schema: { params: userIdParamsSchema, body: userUpdateSchema, response: { 200: userDetailSchema } } },
    async (request) => {
      const auth = getAuth(request);
      const body = request.body;
      const next = {
        ...(body.email !== undefined ? { email: cleanEmail(body.email) } : {}),
        ...(body.givenName !== undefined ? { givenName: cleanName(body.givenName, 'given name') } : {}),
        ...(body.familyName !== undefined ? { familyName: cleanName(body.familyName, 'family name') } : {}),
        ...(body.systemRole !== undefined ? { systemRole: body.systemRole } : {}),
        ...(body.preferredLocale !== undefined ? { preferredLocale: body.preferredLocale } : {}),
      };

      await db.transaction(async (tx) => {
        if (next.systemRole !== undefined) await lockAdministratorChanges(tx);
        const [current] = await tx.select().from(users).where(eq(users.id, request.params.userId)).for('update');
        if (!current) throw userNotFound();

        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(next) as Array<[keyof typeof next, string]>) {
          // Emails compare case-insensitively (stored lowercase; older rows may differ only in case).
          const unchanged = key === 'email' ? current.email.toLowerCase() === value : current[key] === value;
          if (!unchanged) {
            before[key] = current[key];
            after[key] = value;
          }
        }
        if (Object.keys(after).length === 0) return;

        if ('email' in after) {
          // The email identifies the person who activates the account; it is locked once a password exists.
          if (await hasPassword(tx, current.id)) {
            throw new ApiProblem(409, 'EMAIL_LOCKED', 'The email of an activated account cannot be changed.');
          }
          await revokeOpenInvitations(tx, current.id);
        }
        if ('systemRole' in after) {
          if (current.id === auth.user.id) throw new ApiProblem(409, 'SELF_ACCOUNT_CHANGE', 'You cannot change your own system role.');
          if (current.systemRole === 'administrator' && current.isActive && (await countOtherActiveAdministrators(tx, current.id)) === 0) {
            throw new ApiProblem(409, 'LAST_ADMINISTRATOR', 'The last active administrator cannot be demoted.');
          }
        }

        await withUniqueConflict(
          () => tx.update(users).set(after).where(eq(users.id, current.id)),
          'users_email_lower_unique',
          'EMAIL_TAKEN',
          'An account with this email already exists.',
        );
        await recordAudit(tx, request, { action: 'user.updated', entityType: 'user', entityId: current.id, before, after });
      });
      return detailOrThrow(request.params.userId);
    },
  );

  // ---- Status ----

  app.post<{ Params: UserParams }>(
    '/users/:userId/deactivate',
    { ...adminWrite, schema: { params: userIdParamsSchema, response: { 200: userDetailSchema } } },
    async (request) => {
      const auth = getAuth(request);
      await db.transaction(async (tx) => {
        await lockAdministratorChanges(tx);
        const [current] = await tx.select().from(users).where(eq(users.id, request.params.userId)).for('update');
        if (!current) throw userNotFound();
        if (current.id === auth.user.id) throw new ApiProblem(409, 'SELF_ACCOUNT_CHANGE', 'You cannot deactivate your own account.');
        if (!current.isActive) return;
        if (current.systemRole === 'administrator' && (await countOtherActiveAdministrators(tx, current.id)) === 0) {
          throw new ApiProblem(409, 'LAST_ADMINISTRATOR', 'The last active administrator cannot be deactivated.');
        }
        await tx.update(users).set({ isActive: false }).where(eq(users.id, current.id));
        const revokedSessionCount = await revokeUserSessions(tx, current.id);
        const revokedInvitationCount = await revokeOpenInvitations(tx, current.id);
        await recordAudit(tx, request, {
          action: 'user.deactivated',
          entityType: 'user',
          entityId: current.id,
          before: { isActive: true },
          after: { isActive: false, revokedSessionCount, revokedInvitationCount },
        });
      });
      return detailOrThrow(request.params.userId);
    },
  );

  app.post<{ Params: UserParams }>(
    '/users/:userId/reactivate',
    { ...adminWrite, schema: { params: userIdParamsSchema, response: { 200: userDetailSchema } } },
    async (request) => {
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(users).where(eq(users.id, request.params.userId)).for('update');
        if (!current) throw userNotFound();
        if (current.isActive) return;
        // Sessions and activation links revoked at deactivation stay revoked; the user signs in again.
        await tx.update(users).set({ isActive: true }).where(eq(users.id, current.id));
        await recordAudit(tx, request, { action: 'user.reactivated', entityType: 'user', entityId: current.id, before: { isActive: false }, after: { isActive: true } });
      });
      return detailOrThrow(request.params.userId);
    },
  );

  // ---- Activation links ----

  app.post<{ Params: UserParams }>(
    '/users/:userId/invitations',
    { ...adminWrite, schema: { params: userIdParamsSchema, response: { 201: accountInvitationSchema } } },
    async (request, reply) => {
      const auth = getAuth(request);
      if (config.accounts.invitationDelivery === 'disabled') {
        throw new ApiProblem(409, 'INVITATIONS_DISABLED', 'Activation links are disabled in this environment.');
      }
      const issued = await db.transaction(async (tx) => {
        const [current] = await tx.select().from(users).where(eq(users.id, request.params.userId)).for('update');
        if (!current) throw userNotFound();
        if (!current.isActive) throw new ApiProblem(422, 'USER_INACTIVE', 'The user account is not active.');
        if (await hasPassword(tx, current.id)) {
          throw new ApiProblem(409, 'ACCOUNT_ALREADY_ACTIVATED', 'This account is already activated. Activation links are not password resets.');
        }
        if (!isSyntheticAddress(current.email)) {
          throw new ApiProblem(422, 'INVITATION_SYNTHETIC_ONLY', 'Local activation links are only issued for synthetic addresses (for example @academiapath.example).');
        }
        const invitation = await issueInvitation(tx, { userId: current.id, createdByUserId: auth.user.id, ttlHours: config.accounts.invitationTtlHours });
        await auditInvitation(tx, request, current.id, invitation);
        return invitation;
      });
      return reply.code(201).send({ id: issued.id, expiresAt: issued.expiresAt, delivery: 'local_link', activationPath: activationPath(issued.token) });
    },
  );
};

/** Audits an issued link by id and expiry only: never the token or its hash. */
async function auditInvitation(
  tx: Parameters<typeof recordAudit>[0],
  request: FastifyRequest,
  userId: string,
  invitation: { id: string; expiresAt: Date },
) {
  await recordAudit(tx, request, {
    action: 'user.invitation_issued',
    entityType: 'user',
    entityId: userId,
    before: null,
    after: { invitationId: invitation.id, expiresAt: invitation.expiresAt.toISOString(), delivery: 'local_link' },
  });
}
