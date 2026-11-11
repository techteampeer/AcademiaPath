/**
 * Drives the real AcademiaPath API in-process (Fastify inject) as real, signed-in users. Every request
 * goes through the normal authentication, CSRF, Origin, authorization, validation and audit code paths;
 * there are no demo-only routes. Used by the local demo seed (password sign-in) and the cloud demo seed
 * (server-side sessions for a trusted one-off job, revoked when it finishes).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createSession, revokeSession } from '../../src/auth/sessions.js';
import { deriveCsrfToken } from '../../src/auth/tokens.js';
import type { AppConfig } from '../../src/config.js';
import type { Database } from '../../src/db/client.js';
import { auditLog, users } from '../../src/db/schema/index.js';

type Method = 'GET' | 'POST' | 'PUT';

export class DemoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'DemoApiError';
  }
}

export type Actor = {
  email: string;
  call<T = unknown>(method: Method, path: string, body?: object): Promise<T>;
  /** Like `call`, but returns null for the given problem codes (e.g. ENROLLMENT_EXISTS when re-running). */
  callAllowing<T = unknown>(codes: string[], method: Method, path: string, body?: object): Promise<T | null>;
  upload<T = unknown>(path: string, file: { name: string; bytes: Buffer; title: string }): Promise<T>;
  listAll<T>(path: string): Promise<T[]>;
};

export async function signIn(app: FastifyInstance, origin: string, email: string, password: string): Promise<Actor> {
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password }, headers: { origin } });
  if (login.statusCode !== 200) throw new DemoApiError(login.statusCode, undefined, `Sign-in failed for ${email} (status ${login.statusCode}). Check DEV_SEED_PASSWORD.`);
  const { csrfToken } = login.json() as { csrfToken: string };
  const cookies = Object.fromEntries(login.cookies.map((cookie) => [cookie.name, cookie.value]));
  return actorFor(app, origin, email, cookies, csrfToken);
}

/**
 * A session for a trusted seeding job, created server-side with the same session code as sign-in (no
 * password is used or needed). It is audited, lasts at most 30 minutes and `close()` revokes it.
 */
export async function sessionActor(
  app: FastifyInstance,
  db: Database,
  config: Pick<AppConfig, 'session'>,
  origin: string,
  email: string,
): Promise<{ actor: Actor; close: () => Promise<void> }> {
  const [user] = await db
    .select({ id: users.id, isActive: users.isActive })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  if (!user) throw new Error(`Demo account ${email} does not exist.`);
  if (!user.isActive) throw new Error(`Demo account ${email} is deactivated; reactivate it before seeding.`);
  const session = await createSession(db, user.id, 30 * 60);
  await db.insert(auditLog).values({
    actorUserId: user.id,
    action: 'auth.seed_session',
    entityType: 'user',
    entityId: user.id,
    metadata: { sessionId: session.sessionId, source: 'demo_seed' },
  });
  const actor = actorFor(app, origin, email, { [config.session.cookieName]: session.token }, deriveCsrfToken(session.token));
  return { actor, close: () => revokeSession(db, session.sessionId) };
}

function actorFor(app: FastifyInstance, origin: string, email: string, cookies: Record<string, string>, csrfToken: string): Actor {
  const send = async (method: Method, path: string, payload?: object | Buffer, contentType?: string) => {
    const res = await app.inject({
      method,
      url: `/api/v1${path}`,
      cookies,
      headers: {
        origin,
        ...(method === 'GET' ? {} : { 'x-csrf-token': csrfToken }),
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      ...(payload !== undefined ? { payload } : {}),
    });
    const body = res.body ? (JSON.parse(res.body) as unknown) : null;
    if (res.statusCode >= 400) {
      const problem = (body ?? {}) as { code?: string; detail?: string };
      throw new DemoApiError(res.statusCode, problem.code, `${method} ${path} as ${email}: ${res.statusCode} ${problem.code ?? ''} ${problem.detail ?? ''}`.trim());
    }
    return body;
  };

  const actor: Actor = {
    email,
    call: async <T>(method: Method, path: string, body?: object) => (await send(method, path, body)) as T,
    callAllowing: async <T>(codes: string[], method: Method, path: string, body?: object) => {
      try {
        return (await send(method, path, body)) as T;
      } catch (error) {
        if (error instanceof DemoApiError && error.code && codes.includes(error.code)) return null;
        throw error;
      }
    },
    upload: async <T>(path: string, file: { name: string; bytes: Buffer; title: string }) => {
      const boundary = `----academiapath-demo-${randomUUID()}`;
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${file.title}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        file.bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return (await send('POST', path, payload, `multipart/form-data; boundary=${boundary}`)) as T;
    },
    listAll: async <T>(path: string) => {
      const items: T[] = [];
      let cursor: string | null = null;
      do {
        const separator = path.includes('?') ? '&' : '?';
        const page = (await send('GET', `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)) as { items: T[]; nextCursor: string | null };
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return items;
    },
  };
  return actor;
}
