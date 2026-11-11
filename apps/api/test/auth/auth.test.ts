/**
 * Authentication API tests against a temporary PostgreSQL database (see test/helpers/database.ts).
 * Skipped unless TEST_DATABASE_URL is set. Passwords are random per run; nothing here is a real credential.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp, type BuildAppOptions } from '../../src/app.js';
import { getCourseRole } from '../../src/auth/authorization.js';
import { hashPassword } from '../../src/auth/password.js';
import { generateSessionToken } from '../../src/auth/tokens.js';
import { loadConfig } from '../../src/config.js';
import {
  auditLog,
  courses,
  enrollments,
  sessions,
  terms,
  userCredentials,
  users,
  type SystemRole,
} from '../../src/db/schema/index.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const WEB_ORIGIN = 'http://localhost:3000';
const COOKIE = 'ap_session';
const URLS = {
  login: '/api/v1/auth/login',
  logout: '/api/v1/auth/logout',
  csrf: '/api/v1/auth/csrf',
  me: '/api/v1/me',
} as const;

type App = ReturnType<typeof buildApp>;
type Cookie = LightMyRequestResponse['cookies'][number];

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Asserts an RFC 9457 problem details response with the given application error code. */
function expectError(res: LightMyRequestResponse, statusCode: number, code: string) {
  assert.equal(res.statusCode, statusCode, res.body);
  assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
  const problem = res.json();
  assert.equal(problem.type, 'about:blank');
  assert.equal(problem.title, STATUS_CODES[statusCode]);
  assert.equal(problem.status, statusCode);
  assert.equal(typeof problem.detail, 'string');
  assert.equal(problem.code, code);
}

function isCleared(cookie: Cookie | undefined): boolean {
  return (
    cookie !== undefined &&
    cookie.value === '' &&
    (cookie.maxAge === 0 || (cookie.expires !== undefined && cookie.expires.getTime() <= Date.now()))
  );
}

describe('authentication API (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let passwordHash: string;
  let app: App;
  let seq = 0;

  const makeApp = (env: NodeJS.ProcessEnv = {}, logger?: BuildAppOptions['logger']) =>
    buildApp({
      config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: WEB_ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', ...env }),
      database: database.db,
      logger,
    });

  const createAccount = async (options: { systemRole?: SystemRole; isActive?: boolean } = {}) => {
    seq += 1;
    const email = `user${seq}@academiapath.example`;
    const [user] = await database.db
      .insert(users)
      .values({
        email,
        givenName: 'Test',
        familyName: `User ${seq}`,
        systemRole: options.systemRole ?? 'user',
        isActive: options.isActive ?? true,
      })
      .returning();
    assert.ok(user);
    await database.db.insert(userCredentials).values({ userId: user.id, passwordHash });
    return { user, email };
  };

  const login = (
    target: App,
    email: string,
    password = PASSWORD,
    extra: { headers?: Record<string, string>; cookies?: Record<string, string> } = {},
  ) => target.inject({ method: 'POST', url: URLS.login, payload: { email, password }, ...extra });

  const sessionCookie = (res: LightMyRequestResponse) => res.cookies.find((cookie) => cookie.name === COOKIE);

  const signIn = async (email: string) => {
    const res = await login(app, email);
    assert.equal(res.statusCode, 200, res.body);
    const cookie = sessionCookie(res);
    assert.ok(cookie);
    return { token: cookie.value, csrfToken: res.json().csrfToken as string };
  };

  const me = (token: string, target: App = app) =>
    target.inject({ method: 'GET', url: URLS.me, cookies: { [COOKIE]: token } });

  const logout = (token: string, csrfToken?: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: URLS.logout,
      cookies: { [COOKIE]: token },
      headers: { ...(csrfToken === undefined ? {} : { 'x-csrf-token': csrfToken }), ...headers },
    });

  before(async () => {
    database = await createTestDatabase();
    passwordHash = await hashPassword(PASSWORD);
    app = makeApp();
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  // 1. Successful login
  it('logs in with valid credentials (email is case-insensitive) and audits it', async () => {
    const { user, email } = await createAccount();
    const res = await login(app, email.toUpperCase());
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.deepEqual(body.user, {
      id: user.id,
      email,
      givenName: 'Test',
      familyName: user.familyName,
      systemRole: 'user',
      preferredLocale: 'es',
    });
    assert.match(body.csrfToken, /^[A-Za-z0-9_-]{43}$/);
    const ttlMs = Date.parse(body.expiresAt) - Date.now();
    assert.ok(ttlMs > 7.9 * 3_600_000 && ttlMs < 8 * 3_600_000 + 60_000, 'session expires in ~8 hours');
    assert.equal(res.headers['cache-control'], 'no-store');
    const audited = await database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'auth.login'), eq(auditLog.actorUserId, user.id)));
    assert.equal(audited.length, 1);
  });

  // 15. Cookie attributes
  it('sets an HttpOnly, SameSite=Lax, host-only session cookie (development)', async () => {
    const { email } = await createAccount();
    const cookie = sessionCookie(await login(app, email));
    assert.ok(cookie);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Lax');
    assert.equal(cookie.path, '/');
    assert.equal(cookie.domain, undefined);
    assert.equal(cookie.maxAge, 8 * 3600);
    assert.ok(!cookie.secure, 'local HTTP development does not require Secure');
    assert.match(cookie.value, /^[A-Za-z0-9_-]{43}$/);
  });

  it('uses a Secure __Host- session cookie in production', async () => {
    const prodApp = makeApp({
      NODE_ENV: 'production',
      APP_ORIGINS: 'https://lms.academiapath.example',
      DOCUMENT_STORAGE_DIR: '/var/lib/academiapath/documents',
    });
    try {
      const { email } = await createAccount();
      const res = await login(prodApp, email);
      assert.equal(res.statusCode, 200, res.body);
      const cookie = res.cookies.find((c) => c.name === '__Host-ap_session');
      assert.ok(cookie);
      assert.equal(cookie.secure, true);
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.sameSite, 'Lax');
      assert.equal(cookie.path, '/');
      assert.equal(cookie.domain, undefined);
      assert.equal(sessionCookie(res), undefined);
    } finally {
      await prodApp.close();
    }
  });

  // 2. Incorrect password
  it('rejects an incorrect password with a generic error and no cookie', async () => {
    const { email } = await createAccount();
    const res = await login(app, email, `${PASSWORD}x`);
    expectError(res, 401, 'INVALID_CREDENTIALS');
    assert.equal(res.json().detail, 'Invalid email or password.');
    assert.equal(sessionCookie(res), undefined);
  });

  // 3. Unknown user without enumeration
  it('answers unknown and inactive accounts exactly like a wrong password', async () => {
    const { email } = await createAccount();
    const inactive = await createAccount({ isActive: false });
    const wrongPassword = await login(app, email, 'not-the-password');
    const unknown = await login(app, 'nobody@academiapath.example');
    const inactiveCorrectPassword = await login(app, inactive.email);
    for (const res of [unknown, inactiveCorrectPassword]) {
      assert.equal(res.statusCode, wrongPassword.statusCode);
      assert.equal(res.body, wrongPassword.body);
      assert.equal(sessionCookie(res), undefined);
    }
  });

  // 4. Missing credentials
  it('rejects missing or empty credentials and non-JSON bodies', async () => {
    const payloads = [{}, { email: 'a@academiapath.example' }, { password: PASSWORD }, { email: '', password: '' }];
    for (const payload of payloads) {
      const res = await app.inject({ method: 'POST', url: URLS.login, payload });
      expectError(res, 400, 'VALIDATION_ERROR');
      assert.equal(sessionCookie(res), undefined);
    }
    expectError(await app.inject({ method: 'POST', url: URLS.login }), 400, 'VALIDATION_ERROR');
    const form = await app.inject({
      method: 'POST',
      url: URLS.login,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=a&password=b',
    });
    expectError(form, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  // 5. Authenticated /me
  it('returns only safe profile fields from GET /me', async () => {
    const { user, email } = await createAccount();
    const { token } = await signIn(email);
    const res = await me(token);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      user: {
        id: user.id,
        email,
        givenName: 'Test',
        familyName: user.familyName,
        systemRole: 'user',
        preferredLocale: 'es',
      },
    });
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  // 6. Unauthenticated /me
  it('rejects GET /me without a session cookie', async () => {
    expectError(await app.inject({ method: 'GET', url: URLS.me }), 401, 'UNAUTHENTICATED');
  });

  // 14. Invalid or missing cookie handling
  it('rejects malformed or unknown session cookies and clears them', async () => {
    for (const token of ['garbage', '', generateSessionToken(), `${generateSessionToken()}x`]) {
      const res = await me(token);
      expectError(res, 401, 'UNAUTHENTICATED');
      assert.ok(isCleared(sessionCookie(res)), `cookie cleared for ${JSON.stringify(token)}`);
    }
  });

  // 7. Logout
  it('logs out: revokes the session, clears the cookie and audits it', async () => {
    const { user, email } = await createAccount();
    const { token, csrfToken } = await signIn(email);
    const res = await logout(token, csrfToken);
    assert.equal(res.statusCode, 204);
    assert.ok(isCleared(sessionCookie(res)));
    const [row] = await database.db.select().from(sessions).where(eq(sessions.tokenHash, sha256(token)));
    assert.ok(row?.revokedAt instanceof Date, 'revoked_at is set');
    const audited = await database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'auth.logout'), eq(auditLog.actorUserId, user.id)));
    assert.equal(audited.length, 1);
  });

  // 8. Revoked session
  it('rejects a revoked session', async () => {
    const { email } = await createAccount();
    const { token, csrfToken } = await signIn(email);
    assert.equal((await logout(token, csrfToken)).statusCode, 204);
    expectError(await me(token), 401, 'UNAUTHENTICATED');
    expectError(await logout(token, csrfToken), 401, 'UNAUTHENTICATED');
  });

  // 9. Expired session
  it('rejects an expired session and clears the cookie', async () => {
    const { email } = await createAccount();
    const { token } = await signIn(email);
    assert.equal((await me(token)).statusCode, 200);
    await database.pool.query(
      `UPDATE sessions SET created_at = now() - interval '9 hours', expires_at = now() - interval '1 second'
       WHERE token_hash = $1`,
      [sha256(token)],
    );
    const res = await me(token);
    expectError(res, 401, 'UNAUTHENTICATED');
    assert.ok(isCleared(sessionCookie(res)));
  });

  it('rejects sessions of deactivated users', async () => {
    const { user, email } = await createAccount();
    const { token } = await signIn(email);
    await database.db.update(users).set({ isActive: false }).where(eq(users.id, user.id));
    expectError(await me(token), 401, 'UNAUTHENTICATED');
  });

  it('revokes a previously presented session on login', async () => {
    const { email } = await createAccount();
    const first = await signIn(email);
    const res = await login(app, email, PASSWORD, { cookies: { [COOKIE]: first.token } });
    assert.equal(res.statusCode, 200);
    expectError(await me(first.token), 401, 'UNAUTHENTICATED');
    const replacement = sessionCookie(res);
    assert.ok(replacement && replacement.value !== first.token);
    assert.equal((await me(replacement.value)).statusCode, 200);
  });

  // 10. No password hashes or tokens in responses
  it('never returns password hashes or session tokens in response bodies', async () => {
    const { email } = await createAccount();
    const loginRes = await login(app, email);
    const token = sessionCookie(loginRes)?.value;
    assert.ok(token);
    const bodies = [
      loginRes.body,
      (await me(token)).body,
      (await app.inject({ method: 'GET', url: URLS.csrf, cookies: { [COOKIE]: token } })).body,
    ];
    for (const body of bodies) {
      assert.ok(!body.includes('$argon2'), 'no password hash');
      assert.ok(!/password/i.test(body), 'no password fields');
      assert.ok(!body.includes(token), 'no session token');
      assert.ok(!body.includes(sha256(token)), 'no session token hash');
    }
  });

  // 11. Tokens stored as hashes
  it('stores only SHA-256 session token hashes and Argon2id password hashes', async () => {
    const { user, email } = await createAccount();
    const { token } = await signIn(email);
    const { rows } = await database.pool.query<{ json: string; token_hash: string }>(
      `SELECT row_to_json(s)::text AS json, s.token_hash FROM sessions s WHERE s.user_id = $1`,
      [user.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.token_hash, sha256(token));
    assert.ok(!rows[0]?.json.includes(token), 'raw token is not stored');

    const [credential] = await database.db.select().from(userCredentials).where(eq(userCredentials.userId, user.id));
    assert.match(credential?.passwordHash ?? '', /^\$argon2id\$/);

    const isCheckViolation = (error: unknown) => (error as { code?: string }).code === '23514';
    await assert.rejects(
      database.pool.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
        [user.id, generateSessionToken()],
      ),
      isCheckViolation,
      'database rejects a raw token',
    );
    await assert.rejects(
      database.pool.query(`UPDATE user_credentials SET password_hash = $2 WHERE user_id = $1`, [user.id, PASSWORD]),
      isCheckViolation,
      'database rejects a plaintext password',
    );
  });

  // 12. Login rate limiting
  it('rate limits repeated login attempts per client and email', async () => {
    const limited = makeApp({ LOGIN_RATE_LIMIT_MAX: '3', LOGIN_RATE_LIMIT_WINDOW_MINUTES: '15' });
    try {
      const { email } = await createAccount();
      const other = await createAccount();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expectError(await login(limited, email, 'wrong-password'), 401, 'INVALID_CREDENTIALS');
      }
      const blocked = await login(limited, email, 'wrong-password');
      expectError(blocked, 429, 'RATE_LIMITED');
      assert.ok(Number(blocked.headers['retry-after']) > 0, 'Retry-After header is set');
      expectError(await login(limited, email.toUpperCase()), 429, 'RATE_LIMITED');
      assert.equal((await login(limited, other.email)).statusCode, 200, 'other accounts are unaffected');
    } finally {
      await limited.close();
    }
  });

  it('honors X-Forwarded-For only from trusted proxies', async () => {
    // Injected requests come from 127.0.0.1, which plays the trusted proxy here.
    const proxied = makeApp({ TRUST_PROXY: '127.0.0.1', LOGIN_RATE_LIMIT_MAX: '3' });
    const auditedIpsOf = (userId: string) =>
      database.db
        .select({ ip: auditLog.ipAddress })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'auth.login'), eq(auditLog.actorUserId, userId)));
    try {
      const { email } = await createAccount();
      // Rotating a spoofed left-most X-Forwarded-For entry does not change the rate-limit key.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const headers = { 'x-forwarded-for': `203.0.113.${attempt}, 198.51.100.7` };
        expectError(await login(proxied, email, 'wrong-password', { headers }), 401, 'INVALID_CREDENTIALS');
      }
      const headers = { 'x-forwarded-for': '203.0.113.99, 198.51.100.7' };
      expectError(await login(proxied, email, 'wrong-password', { headers }), 429, 'RATE_LIMITED');

      // The audited IP is the one added by the trusted proxy, not the client-supplied one.
      const audited = await createAccount();
      const ok = await login(proxied, audited.email, PASSWORD, { headers: { 'x-forwarded-for': '203.0.113.5, 198.51.100.8' } });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.deepEqual(await auditedIpsOf(audited.user.id), [{ ip: '198.51.100.8' }]);

      // A client connecting directly (not via a trusted proxy) cannot spoof its address.
      const direct = await createAccount();
      const spoofed = await proxied.inject({
        method: 'POST',
        url: URLS.login,
        payload: { email: direct.email, password: PASSWORD },
        headers: { 'x-forwarded-for': '198.51.100.9' },
        remoteAddress: '192.0.2.10',
      });
      assert.equal(spoofed.statusCode, 200, spoofed.body);
      assert.deepEqual(await auditedIpsOf(direct.user.id), [{ ip: '192.0.2.10' }]);

      // A malformed forwarded address does not break login; it is simply not audited.
      const malformed = await createAccount();
      const res = await login(proxied, malformed.email, PASSWORD, { headers: { 'x-forwarded-for': 'not-an-ip' } });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(await auditedIpsOf(malformed.user.id), [{ ip: null }]);
    } finally {
      await proxied.close();
    }
  });

  // 13. CSRF validation
  it('requires the session-bound CSRF token to log out', async () => {
    const session = await signIn((await createAccount()).email);
    const otherSession = await signIn((await createAccount()).email);
    expectError(await logout(session.token), 403, 'CSRF_TOKEN_INVALID');
    expectError(await logout(session.token, 'invalid-token'), 403, 'CSRF_TOKEN_INVALID');
    expectError(await logout(session.token, otherSession.csrfToken), 403, 'CSRF_TOKEN_INVALID');
    assert.equal((await me(session.token)).statusCode, 200, 'session survives rejected logouts');

    const csrfRes = await app.inject({ method: 'GET', url: URLS.csrf, cookies: { [COOKIE]: session.token } });
    assert.equal(csrfRes.statusCode, 200);
    assert.equal(csrfRes.json().csrfToken, session.csrfToken, 'bootstrap endpoint returns the same token');
    expectError(await app.inject({ method: 'GET', url: URLS.csrf }), 401, 'UNAUTHENTICATED');
    assert.equal((await logout(session.token, session.csrfToken)).statusCode, 204);
  });

  it('rejects state-changing browser requests from disallowed origins', async () => {
    const { email } = await createAccount();
    const evil = await login(app, email, PASSWORD, { headers: { origin: 'https://evil.example' } });
    expectError(evil, 403, 'ORIGIN_NOT_ALLOWED');
    assert.equal(sessionCookie(evil), undefined);
    expectError(await login(app, email, PASSWORD, { headers: { origin: 'null' } }), 403, 'ORIGIN_NOT_ALLOWED');
    expectError(
      await login(app, email, PASSWORD, { headers: { 'sec-fetch-site': 'cross-site' } }),
      403,
      'ORIGIN_NOT_ALLOWED',
    );

    const allowed = await login(app, email, PASSWORD, { headers: { origin: WEB_ORIGIN, 'sec-fetch-site': 'same-site' } });
    assert.equal(allowed.statusCode, 200);
    const token = sessionCookie(allowed)?.value;
    assert.ok(token);
    const csrfToken = allowed.json().csrfToken as string;
    expectError(await logout(token, csrfToken, { origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
    assert.equal((await logout(token, csrfToken, { origin: WEB_ORIGIN })).statusCode, 204);
  });

  // ---- Browser sign-in through the Cloud Run web proxy (production) ----
  // Cloud Run serves the web app at its deterministic URL and at its default *.a.run.app URL. Next.js forwards
  // /api/* to the API with the browser's Origin unchanged, the API's host as Host and the web host as
  // X-Forwarded-Host. deploy.yml derives APP_ORIGINS from the web service's own URLs (infra/web-origins.sh).
  const CLOUD_WEB = {
    deterministic: 'https://academiapath-web-871079669510.us-central1.run.app',
    default: 'https://academiapath-web-q2w3e4r5ta-uc.a.run.app',
  };
  const proxied = (origin: string): Record<string, string> => ({
    host: 'academiapath-api-871079669510.us-central1.run.app',
    origin,
    'x-forwarded-host': new URL(origin).host,
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '203.0.113.7',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  });
  const noOrigin = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'origin'));
  const cloudApp = (appOrigins: string) =>
    makeApp({ NODE_ENV: 'production', APP_ORIGINS: appOrigins, DOCUMENT_STORAGE_DIR: '/var/lib/academiapath/documents' });
  const PROD_COOKIE = '__Host-ap_session';

  it('Cloud Run: a web URL missing from APP_ORIGINS is refused with 403 ORIGIN_NOT_ALLOWED (the browser login failure)', async () => {
    // Before the fix, deploy.yml listed only the deterministic URL.
    const prodApp = cloudApp(CLOUD_WEB.deterministic);
    try {
      const { email } = await createAccount();
      assert.equal((await login(prodApp, email, PASSWORD, { headers: proxied(CLOUD_WEB.deterministic) })).statusCode, 200);
      const refused = await login(prodApp, email, PASSWORD, { headers: proxied(CLOUD_WEB.default) });
      expectError(refused, 403, 'ORIGIN_NOT_ALLOWED');
      assert.equal(refused.cookies.length, 0);
      // The Origin check runs before the password is checked, so even a wrong password gets 403, not 401.
      expectError(await login(prodApp, email, 'wrong-password-1', { headers: proxied(CLOUD_WEB.default) }), 403, 'ORIGIN_NOT_ALLOWED');
    } finally {
      await prodApp.close();
    }
  });

  it('Cloud Run: browsers on either web URL sign in through the proxy; the session works and sign-out ends it', async () => {
    const prodApp = cloudApp(`${CLOUD_WEB.deterministic},${CLOUD_WEB.default}`);
    try {
      for (const origin of [CLOUD_WEB.deterministic, CLOUD_WEB.default]) {
        const { user, email } = await createAccount();
        const wrong = await login(prodApp, email, `${PASSWORD}x`, { headers: proxied(origin) });
        expectError(wrong, 401, 'INVALID_CREDENTIALS');
        assert.equal(wrong.cookies.length, 0);

        const res = await login(prodApp, email, PASSWORD, { headers: proxied(origin) });
        assert.equal(res.statusCode, 200, `${origin}: ${res.body}`);
        assert.equal(res.json().user.email, email);
        const cookie = res.cookies.find((c) => c.name === PROD_COOKIE);
        assert.ok(cookie, `${origin}: session cookie`);
        assert.equal(cookie.secure, true);
        assert.equal(cookie.httpOnly, true);
        assert.equal(cookie.sameSite, 'Lax');
        assert.equal(cookie.path, '/');
        assert.equal(cookie.domain, undefined, 'host-only: the browser keeps it for the web host it signed in on');
        const csrfToken = res.json().csrfToken as string;
        assert.match(csrfToken, /^[A-Za-z0-9_-]{20,}$/);

        // The browser sends the cookie back on same-origin requests (GET carries no Origin).
        const getHeaders = noOrigin(proxied(origin));
        const signedIn = await prodApp.inject({ method: 'GET', url: URLS.me, headers: getHeaders, cookies: { [PROD_COOKIE]: cookie.value } });
        assert.equal(signedIn.statusCode, 200, signedIn.body);
        assert.equal(signedIn.json().user.id, user.id);

        const out = await prodApp.inject({
          method: 'POST',
          url: URLS.logout,
          headers: { ...proxied(origin), 'x-csrf-token': csrfToken },
          cookies: { [PROD_COOKIE]: cookie.value },
        });
        assert.equal(out.statusCode, 204, out.body);
        assert.ok(isCleared(out.cookies.find((c) => c.name === PROD_COOKIE)));
        const after = await prodApp.inject({ method: 'GET', url: URLS.me, headers: getHeaders, cookies: { [PROD_COOKIE]: cookie.value } });
        expectError(after, 401, 'UNAUTHENTICATED');
      }
    } finally {
      await prodApp.close();
    }
  });

  it('Cloud Run: untrusted origins stay refused, whatever the proxy headers say', async () => {
    const prodApp = cloudApp(`${CLOUD_WEB.deterministic},${CLOUD_WEB.default}`);
    try {
      const { email } = await createAccount();
      const host = new URL(CLOUD_WEB.deterministic).host;
      const untrusted = [
        'https://evil.example',
        `http://${host}`, // plain HTTP
        `https://${host}:8443`, // another port
        `https://${host}.evil.example`, // look-alike suffix
        'https://evil-academiapath-web-871079669510.us-central1.run.app', // look-alike prefix
        'https://academiapath-api-871079669510.us-central1.run.app', // the API's own URL is not a browser origin
        'https://other-service-871079669510.us-central1.run.app', // another Cloud Run service
        'null',
      ];
      for (const origin of untrusted) {
        // X-Forwarded-Host claims an allowed web host: it must not launder an untrusted Origin.
        const res = await login(prodApp, email, PASSWORD, { headers: { ...proxied(CLOUD_WEB.deterministic), origin } });
        expectError(res, 403, 'ORIGIN_NOT_ALLOWED');
        assert.equal(res.cookies.length, 0, origin);
      }
      expectError(await login(prodApp, email, PASSWORD, { headers: { ...noOrigin(proxied(CLOUD_WEB.deterministic)), 'sec-fetch-site': 'cross-site' } }), 403, 'ORIGIN_NOT_ALLOWED');

      // A signed-in session cannot be ended (or used for any change) from another site.
      const res = await login(prodApp, email, PASSWORD, { headers: proxied(CLOUD_WEB.default) });
      const token = res.cookies.find((c) => c.name === PROD_COOKIE)!.value;
      const csrfToken = res.json().csrfToken as string;
      const forged = await prodApp.inject({
        method: 'POST',
        url: URLS.logout,
        headers: { ...proxied(CLOUD_WEB.default), origin: 'https://evil.example', 'x-csrf-token': csrfToken },
        cookies: { [PROD_COOKIE]: token },
      });
      expectError(forged, 403, 'ORIGIN_NOT_ALLOWED');
      assert.equal((await prodApp.inject({ method: 'GET', url: URLS.me, cookies: { [PROD_COOKIE]: token } })).statusCode, 200);
    } finally {
      await prodApp.close();
    }
  });

  it('does not let users grant themselves administrator permissions', async () => {
    const { email } = await createAccount();
    const escalation = await app.inject({
      method: 'POST',
      url: URLS.login,
      payload: { email, password: PASSWORD, systemRole: 'administrator' },
    });
    expectError(escalation, 400, 'VALIDATION_ERROR');
    const { token } = await signIn(email);
    assert.equal((await me(token)).json().user.systemRole, 'user');

    const guarded = makeApp();
    guarded.get('/api/v1/test/admin-only', { preHandler: [guarded.requireAuth, guarded.requireAdministrator] }, async () => ({
      ok: true,
    }));
    try {
      const url = '/api/v1/test/admin-only';
      expectError(await guarded.inject({ method: 'GET', url }), 401, 'UNAUTHENTICATED');
      expectError(await guarded.inject({ method: 'GET', url, cookies: { [COOKIE]: token } }), 403, 'FORBIDDEN');
      const admin = await signIn((await createAccount({ systemRole: 'administrator' })).email);
      assert.equal((await guarded.inject({ method: 'GET', url, cookies: { [COOKIE]: admin.token } })).statusCode, 200);
    } finally {
      await guarded.close();
    }
  });

  it('resolves course-level roles separately from the system role', async () => {
    const admin = await createAccount({ systemRole: 'administrator' });
    const instructor = await createAccount();
    const [term] = await database.db
      .insert(terms)
      .values({ code: 'AUTH-T1', name: 'Auth term', academicYear: 2026, startsOn: '2026-08-17', endsOn: '2026-12-11' })
      .returning();
    assert.ok(term);
    const [course] = await database.db.insert(courses).values({ termId: term.id, code: 'AUTH-101', title: 'Auth course' }).returning();
    assert.ok(course);
    await database.db.insert(enrollments).values({ courseId: course.id, userId: instructor.user.id, role: 'instructor' });
    assert.equal(await getCourseRole(database.db, instructor.user.id, course.id), 'instructor');
    assert.equal(await getCourseRole(database.db, admin.user.id, course.id), null);
  });

  it('does not log passwords, session tokens or CSRF tokens', async () => {
    const lines: string[] = [];
    const logged = makeApp({}, { level: 'trace', stream: { write: (line) => void lines.push(line) } });
    try {
      const { email } = await createAccount();
      const loginRes = await login(logged, email);
      const token = sessionCookie(loginRes)?.value;
      assert.ok(token);
      const csrfToken = loginRes.json().csrfToken as string;
      await me(token, logged);
      await logged.inject({ method: 'POST', url: URLS.logout, cookies: { [COOKIE]: token }, headers: { 'x-csrf-token': csrfToken } });
      await login(logged, email, 'wrong-password-value');
      const output = lines.join('');
      assert.ok(output.includes('incoming request'), 'request logs were captured');
      for (const secret of [PASSWORD, 'wrong-password-value', token, csrfToken, sha256(token)]) {
        assert.ok(!output.includes(secret), 'secret value is not logged');
      }
    } finally {
      await logged.close();
    }
  });

  it('provisions synthetic development users idempotently', async () => {
    const seedPassword = randomBytes(18).toString('base64url');
    await seedDevUsers(database.db, seedPassword);
    await seedDevUsers(database.db, seedPassword);
    for (const devUser of DEV_USERS) {
      const rows = await database.db.select().from(users).where(eq(users.email, devUser.email));
      assert.equal(rows.length, 1, `${devUser.email} exists once`);
      assert.equal(rows[0]?.systemRole, devUser.systemRole);
      const res = await login(app, devUser.email, seedPassword);
      assert.equal(res.statusCode, 200, res.body);
    }
  });
});
