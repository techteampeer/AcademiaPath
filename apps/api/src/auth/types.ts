import type { preHandlerAsyncHookHandler } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/client.js';
import type { Locale, SystemRole } from '../db/schema/index.js';

/** Profile fields that are safe to return to the signed-in user. */
export type SafeUser = {
  id: string;
  email: string;
  givenName: string;
  familyName: string;
  /** System-level role only. Course-level roles come from enrollments. */
  systemRole: SystemRole;
  preferredLocale: Locale;
};

/** Resolved by `requireAuth`. Holds no raw session token. */
export type AuthContext = {
  user: SafeUser;
  sessionId: string;
  expiresAt: Date;
  csrfToken: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    config: AppConfig;
    db: Database;
    /** The API server clock: quiz deadlines and answer times use it (never the browser clock). */
    now: () => Date;
    /** Resolves the session cookie into `request.auth`; responds 401 otherwise. */
    requireAuth: preHandlerAsyncHookHandler;
    /** Requires a valid `X-CSRF-Token` for the current session. Use after `requireAuth`. */
    requireCsrf: preHandlerAsyncHookHandler;
    /** Requires the system-level administrator role. Use after `requireAuth`. */
    requireAdministrator: preHandlerAsyncHookHandler;
  }
}
