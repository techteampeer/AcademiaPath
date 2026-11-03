import { isIP } from 'node:net';
import type { FastifyPluginAsync } from 'fastify';
import { clearSessionCookie, setSessionCookie } from '../auth/cookies.js';
import { getAuth } from '../auth/hooks.js';
import { getDummyPasswordHash, verifyPassword } from '../auth/password.js';
import { createSession, findLoginAccount, revokeSession, revokeSessionByToken } from '../auth/sessions.js';
import { deriveCsrfToken, isWellFormedSessionToken } from '../auth/tokens.js';
import { auditLog } from '../db/schema/index.js';
import { sendError } from '../http/errors.js';
import { csrfTokenResponseSchema, loginBodySchema, loginResponseSchema } from './schemas.js';

type LoginBody = { email: string; password: string };

const normalizeEmail = (email: unknown) => String(email ?? '').trim().toLowerCase();

/** Only valid IPs are audited; a malformed forwarded address must not break login or logout. */
const auditIp = (ip: string) => (isIP(ip) ? ip : null);

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
