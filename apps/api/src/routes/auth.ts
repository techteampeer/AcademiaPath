import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { auditIp } from '../audit.js';
import { clearSessionCookie, setSessionCookie } from '../auth/cookies.js';
import { getAuth } from '../auth/hooks.js';
import { getDummyPasswordHash, hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, findLoginAccount, revokeSession, revokeSessionByToken } from '../auth/sessions.js';
import { deriveCsrfToken, isWellFormedSessionToken } from '../auth/tokens.js';
import type { Database } from '../db/client.js';
import { accountInvitations, auditLog, userCredentials, users } from '../db/schema/index.js';
import { ApiProblem, sendError } from '../http/errors.js';
import {
  hasCredentialSql,
  hashInvitationToken,
  isWellFormedInvitationToken,
  revokeOpenInvitations,
  revokeUserSessions,
} from '../users/accounts.js';
import { csrfTokenResponseSchema, loginBodySchema, loginResponseSchema } from './schemas.js';
import { activationBodySchema, activationPreviewBodySchema, activationPreviewSchema } from './user-schemas.js';

type LoginBody = { email: string; password: string };

const normalizeEmail = (email: unknown) => String(email ?? '').trim().toLowerCase();

/** One answer for every unusable token (malformed, unknown, expired, used, revoked, inactive account). */
const invitationInvalid = () => new ApiProblem(400, 'INVITATION_INVALID', 'This activation link is invalid, has expired or was already used.');

/**
 * The open activation link for a token: unused, unrevoked, unexpired (database clock), for an active
 * account that has no password yet. Null otherwise.
 */
async function findOpenInvitation(db: Database, token: string) {
  if (!isWellFormedInvitationToken(token)) return null;
  const [row] = await db
    .select({
      id: accountInvitations.id,
      userId: users.id,
      email: users.email,
      givenName: users.givenName,
      familyName: users.familyName,
      expiresAt: accountInvitations.expiresAt,
    })
    .from(accountInvitations)
    .innerJoin(users, eq(users.id, accountInvitations.userId))
    .where(
      and(
        eq(accountInvitations.tokenHash, hashInvitationToken(token)),
        isNull(accountInvitations.usedAt),
        isNull(accountInvitations.revokedAt),
        gt(accountInvitations.expiresAt, sql`now()`),
        eq(users.isActive, true),
        sql`NOT ${hasCredentialSql}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Minimal checks beyond the 12-character minimum: not built from the email name, not one repeated character. */
function isWeakPassword(password: string, email: string): boolean {
  const lowered = password.toLowerCase();
  const localPart = email.split('@')[0] ?? '';
  return (localPart.length >= 3 && lowered.includes(localPart)) || new Set(password).size < 5;
}


export const authRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app;

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    return payload;
  });

  app.post<{ Body: LoginBody }>(
    '/auth/login',
    {
      schema: { body: loginBodySchema, response: { 200: loginResponseSchema } },
      config: {
        rateLimit: {
          max: config.loginRateLimit.max,
          timeWindow: config.loginRateLimit.windowMs,
          // After body validation, so the limit is per client IP and email.
          hook: 'preHandler',
          keyGenerator: (request) => `login:${request.ip}:${normalizeEmail((request.body as LoginBody).email)}`,
        },
      },
    },
    async (request, reply) => {
      const account = await findLoginAccount(db, request.body.email.trim());
      // Always run Argon2 verification so unknown emails cost the same as wrong passwords.
      const passwordValid = await verifyPassword(
        account?.passwordHash ?? (await getDummyPasswordHash()),
        request.body.password,
      );
      if (!account || !account.isActive || !passwordValid) {
        return sendError(reply, 401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
      }

      const previousToken = request.cookies[config.session.cookieName];
      const session = await db.transaction(async (tx) => {
        if (previousToken && isWellFormedSessionToken(previousToken)) {
          await revokeSessionByToken(tx, previousToken);
        }
        const created = await createSession(tx, account.user.id, config.session.ttlSeconds);
        await tx.insert(auditLog).values({
          actorUserId: account.user.id,
          action: 'auth.login',
          entityType: 'user',
          entityId: account.user.id,
          metadata: { sessionId: created.sessionId },
          ipAddress: auditIp(request.ip),
        });
        return created;
      });

      setSessionCookie(reply, config, session.token);
      return {
        user: account.user,
        csrfToken: deriveCsrfToken(session.token),
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );

  // ---- Account activation (pre-authentication, like sign-in: Origin check and rate limit) ----

  const activationRateLimit = (name: string) => ({
    rateLimit: {
      max: config.loginRateLimit.max * 2,
      timeWindow: config.loginRateLimit.windowMs,
      keyGenerator: (request: { ip: string }) => `${name}:${request.ip}`,
    },
  });

  app.post<{ Body: { token: string } }>(
    '/auth/activation/preview',
    {
      schema: { body: activationPreviewBodySchema, response: { 200: activationPreviewSchema } },
      config: activationRateLimit('activation-preview'),
    },
    async (request) => {
      const invitation = await findOpenInvitation(db, request.body.token);
      if (!invitation) throw invitationInvalid();
      return { email: invitation.email, givenName: invitation.givenName, familyName: invitation.familyName, expiresAt: invitation.expiresAt };
    },
  );

  app.post<{ Body: { token: string; password: string } }>(
    '/auth/activate',
    { schema: { body: activationBodySchema }, config: activationRateLimit('activation') },
    async (request, reply) => {
      const { token, password } = request.body;
      const invitation = await findOpenInvitation(db, token);
      if (!invitation) throw invitationInvalid();
      if (isWeakPassword(password, invitation.email)) {
        throw new ApiProblem(422, 'PASSWORD_TOO_WEAK', 'Choose a password that does not contain your email name and is not a repeated character.');
      }
      // Hash before the transaction so no row stays locked during the deliberately slow Argon2id work.
      const passwordHash = await hashPassword(password);

      await db.transaction(async (tx) => {
        // Same lock order as deactivation (user, then links), so the two cannot deadlock.
        const [user] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.id, invitation.userId)).for('update');
        if (!user?.isActive) throw invitationInvalid();
        // Atomic single-use claim: a concurrent or repeated request finds no open, unexpired link.
        const [claimed] = await tx
          .update(accountInvitations)
          .set({ usedAt: sql`now()` })
          .where(
            and(
              eq(accountInvitations.id, invitation.id),
              eq(accountInvitations.userId, invitation.userId),
              isNull(accountInvitations.usedAt),
              isNull(accountInvitations.revokedAt),
              gt(accountInvitations.expiresAt, sql`now()`),
            ),
          )
          .returning({ id: accountInvitations.id });
        if (!claimed) throw invitationInvalid();
        const [credential] = await tx.insert(userCredentials).values({ userId: invitation.userId, passwordHash }).onConflictDoNothing().returning({ userId: userCredentials.userId });
        // Activation never replaces an existing password (it is not a password reset).
        if (!credential) throw invitationInvalid();
        await revokeOpenInvitations(tx, invitation.userId);
        await revokeUserSessions(tx, invitation.userId);
        await tx.insert(auditLog).values({
          actorUserId: invitation.userId,
          action: 'account.activated',
          entityType: 'user',
          entityId: invitation.userId,
          metadata: { invitationId: invitation.id },
          ipAddress: auditIp(request.ip),
        });
      });
      return reply.code(204).send();
    },
  );

  app.post('/auth/logout', { preHandler: [app.requireAuth, app.requireCsrf] }, async (request, reply) => {
    const auth = getAuth(request);
    await db.transaction(async (tx) => {
      await revokeSession(tx, auth.sessionId);
      await tx.insert(auditLog).values({
        actorUserId: auth.user.id,
        action: 'auth.logout',
        entityType: 'user',
        entityId: auth.user.id,
        metadata: { sessionId: auth.sessionId },
        ipAddress: auditIp(request.ip),
      });
    });
    clearSessionCookie(reply, config);
    return reply.code(204).send();
  });

  app.get(
    '/auth/csrf',
    { preHandler: app.requireAuth, schema: { response: { 200: csrfTokenResponseSchema } } },
    async (request) => ({ csrfToken: getAuth(request).csrfToken }),
  );
};
