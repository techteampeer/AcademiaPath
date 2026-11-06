/**
 * DEVELOPMENT ONLY: drives the real AcademiaPath API in-process (Fastify inject) as real, signed-in
 * users. Every request goes through the normal authentication, CSRF, Origin, authorization, validation
 * and audit code paths; there are no demo-only routes.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

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
