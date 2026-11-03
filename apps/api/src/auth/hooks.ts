import type { FastifyRequest, onRequestAsyncHookHandler, preHandlerAsyncHookHandler } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { sendError } from '../http/errors.js';
import { isAdministrator } from './authorization.js';
import { clearSessionCookie } from './cookies.js';
import { findActiveSession } from './sessions.js';
import { deriveCsrfToken, isWellFormedSessionToken, safeEqual } from './tokens.js';
import type { AuthContext } from './types.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createAuthHooks({ db, config }: { db: Database; config: AppConfig }) {
  const requireAuth: preHandlerAsyncHookHandler = async (request, reply) => {
    request.auth = null;
    const token = request.cookies[config.session.cookieName];
    if (token === undefined) {
      return sendError(reply, 401, 'UNAUTHENTICATED', 'Authentication required.');
    }
    const session = isWellFormedSessionToken(token) ? await findActiveSession(db, token) : null;
    if (!session) {
      clearSessionCookie(reply, config);
      return sendError(reply, 401, 'UNAUTHENTICATED', 'Authentication required.');
    }
    request.auth = { ...session, csrfToken: deriveCsrfToken(token) };
  };

  const requireCsrf: preHandlerAsyncHookHandler = async (request, reply) => {
    if (!request.auth) {
      return sendError(reply, 401, 'UNAUTHENTICATED', 'Authentication required.');
    }
    const header = request.headers['x-csrf-token'];
    if (typeof header !== 'string' || !safeEqual(header, request.auth.csrfToken)) {
      return sendError(reply, 403, 'CSRF_TOKEN_INVALID', 'Missing or invalid CSRF token.');
    }
  };

  const requireAdministrator: preHandlerAsyncHookHandler = async (request, reply) => {
    if (!request.auth) {
      return sendError(reply, 401, 'UNAUTHENTICATED', 'Authentication required.');
    }
    if (!isAdministrator(request.auth.user)) {
      return sendError(reply, 403, 'FORBIDDEN', 'Administrator access required.');
    }
  };

  return { requireAuth, requireCsrf, requireAdministrator };
}

/**
 * Rejects state-changing browser requests from origins that are not allowed. Requests without
 * an Origin header (non-browser clients) pass, unless the browser marks them as cross-site.
 */
export function createOriginCheck(config: AppConfig): onRequestAsyncHookHandler {
  return async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    const crossSite = origin === undefined && request.headers['sec-fetch-site'] === 'cross-site';
    if ((origin !== undefined && !config.allowedOrigins.includes(origin)) || crossSite) {
      return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed.');
    }
  };
}

/** Returns the auth context set by `requireAuth`; throws (fails closed) if it is missing. */
export function getAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new Error('Route requires the requireAuth pre-handler');
  return request.auth;
}
