/**
 * Administrator user management, account activation and enrollment management against a temporary
 * PostgreSQL database (skipped unless TEST_DATABASE_URL is set). All accounts are synthetic and every
 * password is random per run.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp, type BuildAppOptions } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { accountInvitations, auditLog, enrollments, sessions, userCredentials, users, type SystemRole } from '../../src/db/schema/index.js';
import { isSyntheticAddress, isValidEmail, normalizeEmail } from '../../src/users/accounts.js';
import { parseEnrollmentCsv } from '../../src/routes/enrollments.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = randomBytes(18).toString('base64url');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Database errors arrive wrapped by Drizzle; match the PostgreSQL message on the cause chain. */
async function rejectsWithDbError(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    let current: unknown = error;
    while (current instanceof Error) {
      if (pattern.test(current.message)) return true;
      current = current.cause;
    }
    return false;
  });
}

type App = ReturnType<typeof buildApp>;
type Session = { token: string; csrf: string; userId: string };
type Method = 'GET' | 'POST' | 'PUT';

describe('pure helpers', () => {
  it('normalizes and validates emails and recognizes synthetic domains', () => {
    assert.equal(normalizeEmail('  Mixed.Case@AcademiaPath.Example '), 'mixed.case@academiapath.example');
    assert.ok(isValidEmail('a.b+tag@academiapath.example'));
    for (const bad of ['plain', 'a@b', 'a b@x.example', '@x.example', 'a@-x.example', `${'x'.repeat(65)}@x.example`, 'a@x..example']) {
      assert.equal(isValidEmail(bad), false, bad);
    }
    for (const synthetic of ['a@academiapath.example', 'a@x.test', 'a@example.com', 'a@mail.example.org', 'a@host.localhost']) {
      assert.ok(isSyntheticAddress(synthetic), synthetic);
    }
    for (const real of ['a@academiapath.pe', 'a@mail.org', 'a@example.co', 'a@notexample.com']) assert.equal(isSyntheticAddress(real), false, real);
  });

  it('parses enrollment CSV rows without dropping any', () => {
    const rows = parseEnrollmentCsv('email,role\nA@x.example\n\n"b@x.example",student\nnot-an-email\nc@x.example,instructor\nd@x.example,dean\na@x.example\ne@x.example,student,extra');
    assert.deepEqual(
      rows.map((r) => [r.line, r.outcome, r.errorCode]),
      [
        [2, 'create', null],
        [4, 'create', null],
        [5, 'error', 'INVALID_EMAIL'],
        [6, 'error', 'ROLE_NOT_ALLOWED'],
        [7, 'error', 'INVALID_ROLE'],
        [8, 'error', 'DUPLICATE_ROW'],
        [9, 'error', 'INVALID_ROW'],
      ],
    );
  });

  it('allows local activation links only outside production', () => {
    assert.equal(loadConfig({ NODE_ENV: 'test' }).accounts.invitationDelivery, 'local_link');
    const production = { NODE_ENV: 'production', APP_ORIGINS: 'https://lms.example', DOCUMENT_STORAGE_DIR: '/var/lib/academiapath/documents' };
    assert.equal(loadConfig(production).accounts.invitationDelivery, 'disabled');
    assert.throws(() => loadConfig({ ...production, ACCOUNT_INVITATION_DELIVERY: 'local_link' }), /secure delivery/);
    assert.throws(() => loadConfig({ NODE_ENV: 'test', ACCOUNT_INVITATION_DELIVERY: 'email' }), /local_link or disabled/);
    assert.throws(() => loadConfig({ NODE_ENV: 'test', ACCOUNT_INVITATION_TTL_HOURS: '0' }), /ACCOUNT_INVITATION_TTL_HOURS/);
  });
});

describe('user management API (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: App;
  const logLines: string[] = [];
  let admin: Session;
  let seq = 0;
  const course: Record<'a' | 'b', { id: string; sectionId: string }> = {} as never;

  const makeApp = (env: NodeJS.ProcessEnv = {}, logger?: BuildAppOptions['logger']) =>
    buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', ...env }), database: database.db, logger });

  const request = (target: App, method: Method, url: string, options: { session?: Session; body?: unknown; csrf?: string | null; origin?: string | null } = {}) =>
    target.inject({
      method,
      url: `/api/v1${url}`,
      cookies: options.session ? { ap_session: options.session.token } : {},
      headers: {
        ...(options.origin === null ? {} : { origin: options.origin ?? ORIGIN }),
        ...(options.session && method !== 'GET' && options.csrf !== null ? { 'x-csrf-token': options.csrf ?? options.session.csrf } : {}),
      },
      ...(options.body !== undefined ? { payload: options.body as object } : {}),
    });
  const call = (method: Method, url: string, session: Session, body?: unknown) => request(app, method, url, { session, body });

  const expectProblem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };

  const signIn = async (email: string, password = PASSWORD, target = app): Promise<Session> => {
    const res = await request(target, 'POST', '/auth/login', { body: { email, password } });
    assert.equal(res.statusCode, 200, `${email}: ${res.body}`);
    const token = res.cookies.find((c) => c.name === 'ap_session')!.value;
    return { token, csrf: res.json().csrfToken, userId: res.json().user.id };
  };

  /** A synthetic account with a password (created directly, like the dev seed). */
  const account = async (options: { systemRole?: SystemRole; prefix?: string } = {}) => {
    seq += 1;
    const email = `${options.prefix ?? 'person'}${seq}@academiapath.example`;
    const [user] = await database.db
      .insert(users)
      .values({ email, givenName: 'Demo', familyName: `Person ${seq}`, systemRole: options.systemRole ?? 'user' })
      .returning();
    await database.db.insert(userCredentials).values({ userId: user!.id, passwordHash: await hashPassword(PASSWORD) });
    return { id: user!.id, email };
  };

  const createUser = async (body: Record<string, unknown>, session = admin) => {
    const res = await call('POST', '/users', session, body);
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { user: { id: string; email: string }; invitation: { activationPath: string } | null; invitationStatus: string };
  };
  const tokenOf = (invitation: { activationPath: string } | null) => invitation!.activationPath.split('#token=')[1]!;
  const activate = (token: string, password: string) => request(app, 'POST', '/auth/activate', { body: { token, password } });

  const enroll = async (courseId: string, userId: string, role: string) => {
    const res = await call('POST', `/courses/${courseId}/enrollments`, admin, { userId, role });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().id as string;
  };

  const audits = async (action: string) =>
    (await database.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(auditLog.createdAt)).map((r) => ({ actor: r.actorUserId, entity: r.entityId, metadata: r.metadata }));

  before(async () => {
    database = await createTestDatabase();
    app = makeApp({}, { level: 'info', stream: { write: (line: string) => void logLines.push(line) } });
    await app.ready();
    const first = await account({ systemRole: 'administrator', prefix: 'admin' });
    admin = await signIn(first.email);

    // Two published courses in one term (created through the normal administrator API).
    const program = (await call('POST', '/programs', admin, { code: 'UM', name: 'User management' })).json();
    const term = (await call('POST', '/terms', admin, { code: '2026-2', name: 'Semestre 2026-2', startsOn: '2026-08-17', endsOn: '2026-12-11' })).json();
    for (const key of ['a', 'b'] as const) {
      const template = await call('POST', '/course-templates', admin, { code: `UM-${key}`, programId: program.id, title: `Course ${key}`, sections: [{ title: 'Unit 1' }] });
      assert.equal(template.statusCode, 201, template.body);
      const created = await call('POST', '/courses', admin, { programId: program.id, termId: term.id, templateId: template.json().templateId, code: `UM-${key}-01`, status: 'published' });
      assert.equal(created.statusCode, 201, created.body);
      const sections = (await call('GET', `/courses/${created.json().id}/sections`, admin)).json();
      course[key] = { id: created.json().id, sectionId: sections.items[0].id };
    }
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  // 1-2 ------------------------------------------------------------------------------------------

  it('lists users for administrators without credentials or token data', async () => {
    const res = await call('GET', '/users', admin);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    const page = res.json();
    assert.ok(page.items.some((u: { id: string }) => u.id === admin.userId));
    assert.doesNotMatch(res.body, /password|hash|token|argon2/i);
  });

  it('paginates and searches by email or name (case-insensitive, wildcards literal), status and activation', async () => {
    const tag = randomBytes(3).toString('hex');
    for (let i = 0; i < 5; i += 1) await createUser({ email: `page.${tag}.${i}@academiapath.example`, givenName: 'Paula', familyName: `Searchable ${tag}` });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await call('GET', `/users?q=page.${tag}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, admin);
      assert.equal(res.statusCode, 200, res.body);
      assert.ok(res.json().items.length <= 2);
      seen.push(...res.json().items.map((u: { email: string }) => u.email));
      cursor = res.json().nextCursor;
    } while (cursor);
    assert.deepEqual(seen, [0, 1, 2, 3, 4].map((i) => `page.${tag}.${i}@academiapath.example`), 'every user exactly once, ordered by email');
    assert.equal((await call('GET', `/users?q=${encodeURIComponent(`paula SEARCHABLE ${tag}`)}`, admin)).json().items.length, 5, 'full-name search');
    assert.equal((await call('GET', `/users?q=${encodeURIComponent('%')}`, admin)).json().items.length, 0, '% is not a wildcard');
    assert.equal((await call('GET', `/users?q=page.${tag}&activation=pending`, admin)).json().items.length, 5);
    assert.equal((await call('GET', `/users?q=page.${tag}&activation=activated`, admin)).json().items.length, 0);
    assert.equal((await call('GET', `/users?q=page.${tag}&status=inactive`, admin)).json().items.length, 0);
    expectProblem(await call('GET', '/users?cursor=bad', admin), 400, 'INVALID_CURSOR');
    expectProblem(await call('GET', '/users?limit=500', admin), 400, 'VALIDATION_ERROR');
  });

  // 3-6 ------------------------------------------------------------------------------------------

  it('creates a pending account with course roles and a single-use activation link, all audited', async () => {
    const created = await createUser({
      email: 'new.teacher@academiapath.example',
      givenName: 'Demo',
      familyName: 'New Teacher',
      preferredLocale: 'en',
      enrollments: [
        { courseId: course.a.id, role: 'instructor' },
        { courseId: course.b.id, role: 'student' },
      ],
    });
    assert.equal(created.invitationStatus, 'issued');
    assert.match(created.invitation!.activationPath, /^\/activate#token=[A-Za-z0-9_-]{43}$/);
    const user = created.user as unknown as Record<string, unknown> & { activation: { state: string; pendingInvitation: { expired: boolean } }; enrollments: Array<{ role: string }> };
    assert.equal(user.systemRole, 'user');
    assert.equal(user.isActive, true);
    assert.equal(user.activationState, 'pending');
    assert.equal(user.activation.pendingInvitation.expired, false);
    assert.deepEqual(user.enrollments.map((e) => e.role).sort(), ['instructor', 'student']);
    assert.deepEqual((user.courseRoles as string[]).sort(), ['instructor', 'student']);
    const [invitation] = await database.db.select().from(accountInvitations).where(eq(accountInvitations.userId, created.user.id));
    assert.equal(invitation!.tokenHash, sha256(tokenOf(created.invitation)), 'only the hash is stored');
    assert.equal(invitation!.createdByUserId, admin.userId);
    const hoursValid = (invitation!.expiresAt.getTime() - invitation!.createdAt.getTime()) / 3_600_000;
    assert.ok(Math.abs(hoursValid - 72) < 0.01, `expires after 72 h (${hoursValid})`);
    assert.equal((await database.db.select().from(userCredentials).where(eq(userCredentials.userId, created.user.id))).length, 0, 'no default password');
    assert.ok((await audits('user.created')).some((a) => a.entity === created.user.id && a.actor === admin.userId));
    assert.equal((await audits('enrollment.created')).filter((a) => (a.metadata as { after: { userId: string } }).after.userId === created.user.id).length, 2);
    assert.ok((await audits('user.invitation_issued')).some((a) => a.entity === created.user.id));
  });

  it('rejects duplicate emails regardless of case, including concurrent creation', async () => {
    await createUser({ email: 'dup@academiapath.example', givenName: 'Demo', familyName: 'Dup' });
    expectProblem(await call('POST', '/users', admin, { email: 'DUP@AcademiaPath.example', givenName: 'Demo', familyName: 'Dup' }), 409, 'EMAIL_TAKEN');
    const results = await Promise.all([1, 2, 3].map(() => call('POST', '/users', admin, { email: 'race@academiapath.example', givenName: 'Demo', familyName: 'Race' })));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409, 409]);
    const { rows } = await database.pool.query(`SELECT count(*)::int AS n FROM users WHERE lower(email) = 'race@academiapath.example'`);
    assert.equal(rows[0].n, 1);
  });

  it('normalizes emails (trimmed, lowercased) for storage, search and sign-in', async () => {
    const created = await createUser({ email: '  Mixed.Case@AcademiaPath.Example ', givenName: '  Demo ', familyName: ' Mixed ' });
    assert.equal(created.user.email, 'mixed.case@academiapath.example');
    assert.equal((created.user as unknown as { givenName: string }).givenName, 'Demo');
    assert.equal((await activate(tokenOf(created.invitation), 'Correct horse battery 9')).statusCode, 204);
    await signIn('MIXED.case@academiapath.EXAMPLE', 'Correct horse battery 9');
  });

  it('rejects invalid details and crafted fields server-side, creating nothing', async () => {
    const valid = { email: 'valid.details@academiapath.example', givenName: 'Demo', familyName: 'Valid' };
    const before = (await database.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    for (const body of [
      { ...valid, email: 'not-an-email' },
      { ...valid, email: 'two@@academiapath.example' },
      { ...valid, givenName: '   ' },
      { ...valid, familyName: 'Bad\u0007Name' },
      { ...valid, givenName: 'x'.repeat(101) },
      { ...valid, systemRole: 'superuser' },
      { ...valid, isActive: false },
      { ...valid, passwordHash: '$argon2id$v=19$forged' },
      { ...valid, password: 'Chosen by the administrator' },
      { ...valid, enrollments: [{ courseId: course.a.id, role: 'administrator' }] },
      { email: valid.email },
    ]) {
      expectProblem(await call('POST', '/users', admin, body), 400, 'VALIDATION_ERROR');
    }
    expectProblem(
      await call('POST', '/users', admin, { ...valid, enrollments: [{ courseId: course.a.id, role: 'student' }, { courseId: course.a.id, role: 'instructor' }] }),
      422,
      'DUPLICATE_COURSE',
    );
    expectProblem(await call('POST', '/users', admin, { ...valid, enrollments: [{ courseId: '00000000-0000-4000-8000-000000000000', role: 'student' }] }), 422, 'COURSE_NOT_FOUND');
    assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, before, 'the failed create rolled back');
  });

  // 7-10 -----------------------------------------------------------------------------------------

  it('activates a new account once: preview, password rules, then normal sign-in and role dashboard data', async () => {
    const created = await createUser({ email: 'activate.me@academiapath.example', givenName: 'Demo', familyName: 'Activate', enrollments: [{ courseId: course.a.id, role: 'student' }] });
    const token = tokenOf(created.invitation);
    const preview = await request(app, 'POST', '/auth/activation/preview', { body: { token } });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(Object.keys(preview.json()).sort(), ['email', 'expiresAt', 'familyName', 'givenName']);
    assert.equal(preview.json().email, 'activate.me@academiapath.example');
    expectProblem(await activate(token, 'short'), 400, 'VALIDATION_ERROR');
    expectProblem(await activate(token, 'activate.me-password'), 422, 'PASSWORD_TOO_WEAK');
    expectProblem(await activate(token, 'aaaaaaaaaaaaaaaa'), 422, 'PASSWORD_TOO_WEAK');
    assert.equal((await activate(token, 'Lima river stone 42')).statusCode, 204, 'rule failures do not consume the link');
    const session = await signIn('activate.me@academiapath.example', 'Lima river stone 42');
    const me = await request(app, 'GET', '/me', { session });
    assert.equal(me.json().user.systemRole, 'user');
    const visible = await request(app, 'GET', '/courses', { session });
    assert.deepEqual(visible.json().items.map((c: { id: string; viewerRole: string }) => [c.id, c.viewerRole]), [[course.a.id, 'student']]);
    const detail = (await call('GET', `/users/${created.user.id}`, admin)).json();
    assert.equal(detail.activationState, 'activated');
    assert.equal(detail.activation.pendingInvitation, null);
    assert.ok(detail.activation.activatedAt);
    const [credential] = await database.db.select().from(userCredentials).where(eq(userCredentials.userId, created.user.id));
    assert.match(credential!.passwordHash, /^\$argon2id\$/);
    assert.ok((await audits('account.activated')).some((a) => a.actor === created.user.id && a.entity === created.user.id));
  });

  it('refuses expired activation links (and the database refuses to mark them used)', async () => {
    const created = await createUser({ email: 'expired@academiapath.example', givenName: 'Demo', familyName: 'Expired' });
    const token = randomBytes(32).toString('base64url');
    await database.db.update(accountInvitations).set({ revokedAt: sql`now()` }).where(eq(accountInvitations.userId, created.user.id));
    const [expired] = await database.db
      .insert(accountInvitations)
      .values({ userId: created.user.id, tokenHash: sha256(token), createdByUserId: admin.userId, createdAt: sql`now() - interval '2 hours'`, expiresAt: sql`now() - interval '1 hour'` })
      .returning();
    expectProblem(await request(app, 'POST', '/auth/activation/preview', { body: { token } }), 400, 'INVITATION_INVALID');
    expectProblem(await activate(token, 'Expired link password 1'), 400, 'INVITATION_INVALID');
    await rejectsWithDbError(database.db.update(accountInvitations).set({ usedAt: sql`now()` }).where(eq(accountInvitations.id, expired!.id)), /expired account invitation/);
    await rejectsWithDbError(database.db.update(accountInvitations).set({ expiresAt: sql`now() + interval '1 day'` }).where(eq(accountInvitations.id, expired!.id)), /cannot be altered/);
    const detail = (await call('GET', `/users/${created.user.id}`, admin)).json();
    assert.equal(detail.activation.pendingInvitation.expired, true, 'the administrator sees the link expired');
    assert.equal((await database.db.select().from(userCredentials).where(eq(userCredentials.userId, created.user.id))).length, 0);
  });

  it('refuses reused, replaced and concurrently replayed activation links', async () => {
    const first = await createUser({ email: 'reuse@academiapath.example', givenName: 'Demo', familyName: 'Reuse' });
    const replaced = tokenOf(first.invitation);
    const reissued = await call('POST', `/users/${first.user.id}/invitations`, admin);
    assert.equal(reissued.statusCode, 201, reissued.body);
    expectProblem(await activate(replaced, 'Replaced link password 1'), 400, 'INVITATION_INVALID');
    const token = tokenOf(reissued.json());
    const results = await Promise.all([activate(token, 'Concurrent password one'), activate(token, 'Concurrent password two')]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [204, 400]);
    expectProblem(await activate(token, 'Third attempt password'), 400, 'INVITATION_INVALID');
    const [stored] = await database.db.select().from(accountInvitations).where(eq(accountInvitations.tokenHash, sha256(token)));
    assert.ok(stored!.usedAt);
    await rejectsWithDbError(database.db.update(accountInvitations).set({ usedAt: null }).where(eq(accountInvitations.id, stored!.id)), /cannot be altered/);
    expectProblem(await call('POST', `/users/${first.user.id}/invitations`, admin), 409, 'ACCOUNT_ALREADY_ACTIVATED');
    expectProblem(await activate('x'.repeat(43), 'Unknown token password'), 400, 'INVITATION_INVALID');
    expectProblem(await activate('../../etc/passwd', 'Malformed token pass'), 400, 'INVITATION_INVALID');
  });

  it('never stores, logs or audits plaintext passwords or activation tokens', async () => {
    const created = await createUser({ email: 'leak.check@academiapath.example', givenName: 'Demo', familyName: 'Leak' });
    const token = tokenOf(created.invitation);
    const password = `Leak check ${randomBytes(6).toString('hex')}`;
    assert.equal((await request(app, 'POST', '/auth/activation/preview', { body: { token } })).statusCode, 200);
    assert.equal((await activate(token, password)).statusCode, 204);
    await signIn('leak.check@academiapath.example', password);
    const everything = JSON.stringify({
      audit: (await database.pool.query('SELECT * FROM audit_log')).rows,
      invitations: (await database.pool.query('SELECT * FROM account_invitations')).rows,
      credentials: (await database.pool.query('SELECT * FROM user_credentials')).rows,
      users: (await database.pool.query('SELECT * FROM users')).rows,
      logs: logLines,
    });
    for (const secret of [token, password, PASSWORD]) assert.ok(!everything.includes(secret), 'secret found in stored data or logs');
    assert.ok(logLines.length > 0, 'requests were logged');
    const detail = await call('GET', `/users/${created.user.id}`, admin);
    assert.doesNotMatch(detail.body, /token|hash|password/i);
  });

  // 11-14 ----------------------------------------------------------------------------------------

  it('deactivation blocks sign-in and revokes every session at once; reactivation is explicit and safe', async () => {
    const person = await account();
    const sessionA = await signIn(person.email);
    const sessionB = await signIn(person.email);
    assert.equal((await request(app, 'GET', '/me', { session: sessionA })).statusCode, 200);
    const deactivated = await call('POST', `/users/${person.id}/deactivate`, admin);
    assert.equal(deactivated.statusCode, 200, deactivated.body);
    assert.equal(deactivated.json().isActive, false);
    for (const session of [sessionA, sessionB]) expectProblem(await request(app, 'GET', '/me', { session }), 401, 'UNAUTHENTICATED');
    const open = await database.pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [person.id]);
    assert.equal(open.rows[0].n, 0);
    expectProblem(await request(app, 'POST', '/auth/login', { body: { email: person.email, password: PASSWORD } }), 401, 'INVALID_CREDENTIALS');
    const audit = (await audits('user.deactivated')).find((a) => a.entity === person.id);
    assert.equal((audit!.metadata as { after: { revokedSessionCount: number } }).after.revokedSessionCount, 2);
    assert.equal((await call('POST', `/users/${person.id}/deactivate`, admin)).statusCode, 200, 'repeating changes nothing');

    const reactivated = await call('POST', `/users/${person.id}/reactivate`, admin);
    assert.equal(reactivated.json().isActive, true);
    expectProblem(await request(app, 'GET', '/me', { session: sessionA }), 401, 'UNAUTHENTICATED');
    await signIn(person.email);
    assert.ok((await audits('user.reactivated')).some((a) => a.entity === person.id && a.actor === admin.userId));

    // A pending account's link revoked at deactivation stays revoked after reactivation.
    const pending = await createUser({ email: 'pending.deactivated@academiapath.example', givenName: 'Demo', familyName: 'Pending' });
    await call('POST', `/users/${pending.user.id}/deactivate`, admin);
    expectProblem(await call('POST', `/users/${pending.user.id}/invitations`, admin), 422, 'USER_INACTIVE');
    await call('POST', `/users/${pending.user.id}/reactivate`, admin);
    expectProblem(await activate(tokenOf(pending.invitation), 'Revoked link password'), 400, 'INVITATION_INVALID');
    assert.equal((await call('POST', `/users/${pending.user.id}/invitations`, admin)).statusCode, 201, 'a new link is needed');
  });

  it('protects administrators from removing themselves and the last active administrator', async () => {
    expectProblem(await call('POST', `/users/${admin.userId}/deactivate`, admin), 409, 'SELF_ACCOUNT_CHANGE');
    expectProblem(await call('PUT', `/users/${admin.userId}`, admin, { systemRole: 'user' }), 409, 'SELF_ACCOUNT_CHANGE');

    // Two administrators removing each other at the same time: the lock keeps one active.
    for (let round = 0; round < 4; round += 1) {
      const isolated = await createTestDatabase();
      const local = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000' }), database: isolated.db });
      try {
        const ids: string[] = [];
        for (const name of ['one', 'two']) {
          const [user] = await isolated.db.insert(users).values({ email: `${name}@academiapath.example`, givenName: 'Demo', familyName: name, systemRole: 'administrator' }).returning();
          await isolated.db.insert(userCredentials).values({ userId: user!.id, passwordHash: await hashPassword(PASSWORD) });
          ids.push(user!.id);
        }
        const one = await signIn('one@academiapath.example', PASSWORD, local);
        const two = await signIn('two@academiapath.example', PASSWORD, local);
        const action = round % 2 === 0 ? (s: Session, target: string) => request(local, 'POST', `/users/${target}/deactivate`, { session: s }) : (s: Session, target: string) => request(local, 'PUT', `/users/${target}`, { session: s, body: { systemRole: 'user' } });
        const results = await Promise.all([action(one, ids[1]!), action(two, ids[0]!)]);
        const codes = results.map((r) => r.statusCode).sort();
        assert.ok(codes[0] === 200 && [401, 403, 409].includes(codes[1]!), `round ${round}: ${results.map((r) => r.body).join(' | ')}`);
        const { rows } = await isolated.pool.query(`SELECT count(*)::int AS n FROM users WHERE system_role = 'administrator' AND is_active`);
        assert.equal(rows[0].n, 1, 'exactly one active administrator remains');
      } finally {
        await local.close();
        await isolated.drop();
      }
    }

    // An administrator can still demote or deactivate another administrator while one remains.
    const other = await account({ systemRole: 'administrator', prefix: 'second.admin' });
    const demoted = await call('PUT', `/users/${other.id}`, admin, { systemRole: 'user' });
    assert.equal(demoted.json().systemRole, 'user');
    const otherSession = await signIn(other.email);
    expectProblem(await request(app, 'GET', '/users', { session: otherSession }), 403, 'FORBIDDEN');
  });

  // 15-18 ----------------------------------------------------------------------------------------

  it('refuses every administrator endpoint to students and to course instructors', async () => {
    const student = await account();
    const instructor = await account();
    const enrollmentId = await enroll(course.a.id, student.id, 'student');
    await enroll(course.a.id, instructor.id, 'instructor');
    const target = await account();
    for (const person of [student, instructor]) {
      const session = await signIn(person.email);
      for (const [method, url, body] of [
        ['GET', '/users', undefined],
        ['GET', `/users/${target.id}`, undefined],
        ['POST', '/users', { email: 'escalate@academiapath.example', givenName: 'Demo', familyName: 'Escalate', systemRole: 'administrator' }],
        ['PUT', `/users/${target.id}`, { givenName: 'Changed' }],
        ['PUT', `/users/${session.userId}`, { systemRole: 'administrator' }],
        ['POST', `/users/${target.id}/deactivate`, undefined],
        ['POST', `/users/${target.id}/reactivate`, undefined],
        ['POST', `/users/${target.id}/invitations`, undefined],
        ['POST', `/courses/${course.a.id}/enrollments`, { userId: target.id, role: 'student' }],
        ['PUT', `/courses/${course.a.id}/enrollments/${enrollmentId}`, { role: 'instructor' }],
        ['POST', `/courses/${course.a.id}/enrollments/import`, { csv: target.email }],
      ] as Array<[Method, string, unknown]>) {
        expectProblem(await call(method, url, session, body), 403, 'FORBIDDEN');
      }
      const me = await request(app, 'GET', '/me', { session });
      assert.equal(me.json().user.systemRole, 'user', 'no escalation happened');
    }
    expectProblem(await request(app, 'GET', '/users'), 401, 'UNAUTHENTICATED');
    const [unchanged] = await database.db.select().from(enrollments).where(eq(enrollments.id, enrollmentId));
    assert.equal(unchanged!.role, 'student');
  });

  it('keeps course roles scoped to their course and refuses cross-course changes', async () => {
    const person = await account();
    const inB = await enroll(course.b.id, person.id, 'student');
    expectProblem(await call('PUT', `/courses/${course.a.id}/enrollments/${inB}`, admin, { role: 'instructor' }), 404, 'NOT_FOUND');
    expectProblem(await call('PUT', `/courses/${course.b.id}/enrollments/${inB}`, admin, { courseId: course.a.id }), 400, 'VALIDATION_ERROR');
    expectProblem(await call('PUT', `/courses/${course.b.id}/enrollments/${inB}`, admin, { role: 'administrator' }), 400, 'VALIDATION_ERROR');
    expectProblem(await call('POST', `/courses/${course.a.id}/enrollments`, admin, { userId: person.id, role: 'administrator' }), 400, 'VALIDATION_ERROR');
    const [row] = await database.db.select().from(enrollments).where(eq(enrollments.id, inB));
    assert.deepEqual([row!.courseId, row!.role], [course.b.id, 'student']);
  });

  it('supports different roles for one person in different courses', async () => {
    const created = await createUser({
      email: 'two.roles@academiapath.example',
      givenName: 'Demo',
      familyName: 'Two Roles',
      enrollments: [
        { courseId: course.a.id, role: 'non_editing_instructor' },
        { courseId: course.b.id, role: 'student' },
      ],
    });
    assert.equal((await activate(tokenOf(created.invitation), 'Two roles password 7')).statusCode, 204);
    const session = await signIn('two.roles@academiapath.example', 'Two roles password 7');
    assert.equal((await request(app, 'GET', `/courses/${course.a.id}/gradebook`, { session })).statusCode, 200, 'grader in course A');
    expectProblem(await request(app, 'GET', `/courses/${course.b.id}/gradebook`, { session }), 403, 'FORBIDDEN');
    assert.equal((await request(app, 'GET', `/courses/${course.b.id}/grades/mine`, { session })).statusCode, 200, 'student in course B');
    const listed = (await call('GET', '/users?q=two.roles', admin)).json().items[0];
    assert.deepEqual(listed.courseRoles, ['non_editing_instructor', 'student']);
    assert.equal(listed.activeEnrollmentCount, 2);
  });

  // 19-21 ----------------------------------------------------------------------------------------

  it('changes enrollment roles and status with audit records, keeping student work safe', async () => {
    const person = await account();
    const enrollmentId = await enroll(course.a.id, person.id, 'student');
    const session = await signIn(person.email);
    const changed = await call('PUT', `/courses/${course.a.id}/enrollments/${enrollmentId}`, admin, { role: 'non_editing_instructor' });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().role, 'non_editing_instructor');
    assert.equal((await request(app, 'GET', `/courses/${course.a.id}/gradebook`, { session })).statusCode, 200, 'takes effect immediately');
    const withdrawn = await call('PUT', `/courses/${course.a.id}/enrollments/${enrollmentId}`, admin, { status: 'inactive' });
    assert.equal(withdrawn.json().status, 'inactive');
    expectProblem(await request(app, 'GET', `/courses/${course.a.id}`, { session }), 404, 'NOT_FOUND');
    const records = (await audits('enrollment.updated')).filter((a) => a.entity === enrollmentId);
    assert.deepEqual(
      records.map((r) => (r.metadata as { before: { role: string; status: string }; after: { role: string; status: string } })).map((m) => [m.before.role, m.after.role, m.before.status, m.after.status]),
      [
        ['student', 'non_editing_instructor', 'active', 'active'],
        ['non_editing_instructor', 'non_editing_instructor', 'active', 'inactive'],
      ],
    );
    assert.ok(records.every((r) => r.actor === admin.userId));
    assert.equal((await call('PUT', `/courses/${course.a.id}/enrollments/${enrollmentId}`, admin, { status: 'inactive' })).statusCode, 200);
    assert.equal((await audits('enrollment.updated')).filter((a) => a.entity === enrollmentId).length, 2, 'no-op changes are not audited');

    // A student who submitted work keeps the student role (their work and grades stay consistent).
    const instructor = await account();
    const reviewer = await account();
    await enroll(course.b.id, instructor.id, 'instructor');
    await enroll(course.b.id, reviewer.id, 'design_team');
    const learner = await account();
    const learnerEnrollment = await enroll(course.b.id, learner.id, 'student');
    const instructorSession = await signIn(instructor.email);
    const assignment = await request(app, 'POST', `/courses/${course.b.id}/sections/${course.b.sectionId}/activities`, {
      session: instructorSession,
      body: { type: 'assignment', title: 'Essay', instructions: 'Write a paragraph.', dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), lateUntil: null, rubric: [{ title: 'Content', maxPoints: 5 }] },
    });
    assert.equal(assignment.statusCode, 201, assignment.body);
    await request(app, 'POST', `/courses/${course.b.id}/activities/${assignment.json().id}/submit`, { session: instructorSession });
    const approved = await request(app, 'POST', `/courses/${course.b.id}/activities/${assignment.json().id}/review`, { session: await signIn(reviewer.email), body: { decision: 'approve' } });
    assert.equal(approved.statusCode, 200, approved.body);
    const submitted = await request(app, 'POST', `/courses/${course.b.id}/activities/${assignment.json().id}/submissions`, { session: await signIn(learner.email), body: { body: 'My paragraph.' } });
    assert.equal(submitted.statusCode, 201, submitted.body);
    expectProblem(await call('PUT', `/courses/${course.b.id}/enrollments/${learnerEnrollment}`, admin, { role: 'instructor' }), 409, 'ENROLLMENT_HAS_STUDENT_WORK');
    assert.equal((await call('PUT', `/courses/${course.b.id}/enrollments/${learnerEnrollment}`, admin, { status: 'inactive' })).statusCode, 200);

    // An enrollment cannot be reactivated for a deactivated account.
    await call('POST', `/users/${learner.id}/deactivate`, admin);
    expectProblem(await call('PUT', `/courses/${course.b.id}/enrollments/${learnerEnrollment}`, admin, { status: 'active' }), 422, 'USER_INACTIVE');
  });

  it('applies normal CSRF and Origin protections to account management and activation', async () => {
    const body = { email: 'csrf.check@academiapath.example', givenName: 'Demo', familyName: 'Csrf' };
    expectProblem(await request(app, 'POST', '/users', { session: admin, body, csrf: null }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await request(app, 'POST', '/users', { session: admin, body, csrf: 'forged' }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await request(app, 'POST', '/users', { session: admin, body, origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
    const target = await account();
    expectProblem(await request(app, 'POST', `/users/${target.id}/deactivate`, { session: admin, csrf: null }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await request(app, 'POST', '/auth/activate', { body: { token: 'x'.repeat(43), password: 'Cross site password' }, origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
    const crossSite = await app.inject({ method: 'POST', url: '/api/v1/auth/activation/preview', headers: { 'sec-fetch-site': 'cross-site' }, payload: { token: 'x'.repeat(43) } });
    expectProblem(crossSite, 403, 'ORIGIN_NOT_ALLOWED');
    assert.equal((await database.pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'csrf.check@academiapath.example'`)).rows[0].n, 0);
    const [stillActive] = await database.db.select().from(users).where(eq(users.id, target.id));
    assert.equal(stillActive!.isActive, true);
  });

  it('rate limits activation attempts per client address', async () => {
    const limited = makeApp({ LOGIN_RATE_LIMIT_MAX: '1' });
    try {
      const attempt = () => request(limited, 'POST', '/auth/activation/preview', { body: { token: 'y'.repeat(43) } });
      expectProblem(await attempt(), 400, 'INVITATION_INVALID');
      expectProblem(await attempt(), 400, 'INVITATION_INVALID');
      assert.equal((await attempt()).statusCode, 429);
    } finally {
      await limited.close();
    }
  });

  it('keeps the existing dev seed accounts working and manageable', async () => {
    await seedDevUsers(database.db, PASSWORD);
    await seedDevUsers(database.db, PASSWORD);
    for (const devUser of DEV_USERS) {
      const session = await signIn(devUser.email);
      assert.equal((await request(app, 'GET', '/me', { session })).json().user.systemRole, devUser.systemRole);
    }
    for (const devUser of DEV_USERS) {
      const found = (await call('GET', `/users?q=${encodeURIComponent(devUser.email)}`, admin)).json().items as Array<{ email: string; activationState: string }>;
      assert.equal(found.find((u) => u.email === devUser.email)?.activationState, 'activated', devUser.email);
    }
    const seededAdmin = await signIn('admin@academiapath.example');
    assert.equal((await call('GET', '/users', seededAdmin)).statusCode, 200, 'the seeded administrator can manage users');
    const [student] = await database.db.select().from(users).where(eq(users.email, 'student@academiapath.example'));
    expectProblem(await call('PUT', `/users/${student!.id}`, admin, { email: 'renamed@academiapath.example' }), 409, 'EMAIL_LOCKED');
    expectProblem(await call('POST', `/users/${student!.id}/invitations`, admin), 409, 'ACCOUNT_ALREADY_ACTIVATED');
  });

  // Edits, invitations and bulk enrollment ------------------------------------------------------

  it('edits permitted details; the email is correctable only while pending, revoking the old link', async () => {
    const created = await createUser({ email: 'typo@academiapath.exmaple', givenName: 'Demo', familyName: 'Typo' });
    assert.equal(created.invitationStatus, 'synthetic_only', 'misspelled reserved domain is not synthetic');
    const fixed = await call('PUT', `/users/${created.user.id}`, admin, { email: 'Fixed@AcademiaPath.example', givenName: 'Demo', familyName: 'Fixed', preferredLocale: 'en' });
    assert.equal(fixed.statusCode, 200, fixed.body);
    assert.deepEqual([fixed.json().email, fixed.json().familyName, fixed.json().preferredLocale], ['fixed@academiapath.example', 'Fixed', 'en']);
    const link = await call('POST', `/users/${created.user.id}/invitations`, admin);
    assert.equal(link.statusCode, 201);
    expectProblem(await call('PUT', `/users/${created.user.id}`, admin, { email: 'dup@academiapath.example' }), 409, 'EMAIL_TAKEN');
    const again = await call('PUT', `/users/${created.user.id}`, admin, { email: 'fixed.again@academiapath.example' });
    assert.equal(again.statusCode, 200);
    expectProblem(await activate(tokenOf(link.json()), 'Old link after email change'), 400, 'INVITATION_INVALID');
    const update = (await audits('user.updated')).filter((a) => a.entity === created.user.id);
    assert.deepEqual((update[0]!.metadata as { after: Record<string, string> }).after, { email: 'fixed@academiapath.example', familyName: 'Fixed', preferredLocale: 'en' });
    expectProblem(await call('PUT', `/users/${created.user.id}`, admin, {}), 400, 'VALIDATION_ERROR');
    expectProblem(await call('PUT', `/users/${created.user.id}`, admin, { isActive: false }), 400, 'VALIDATION_ERROR');
    expectProblem(await call('GET', '/users/00000000-0000-4000-8000-000000000000', admin), 404, 'NOT_FOUND');
  });

  it('issues local links only for synthetic addresses and never when delivery is disabled', async () => {
    const real = await createUser({ email: 'not.reserved@academiapath.pe', givenName: 'Demo', familyName: 'Not Synthetic' });
    assert.equal(real.invitationStatus, 'synthetic_only');
    assert.equal(real.invitation, null);
    expectProblem(await call('POST', `/users/${real.user.id}/invitations`, admin), 422, 'INVITATION_SYNTHETIC_ONLY');

    const disabled = makeApp({ ACCOUNT_INVITATION_DELIVERY: 'disabled' });
    try {
      const res = await request(disabled, 'POST', '/users', { session: admin, body: { email: 'no.link@academiapath.example', givenName: 'Demo', familyName: 'No Link' } });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(res.json().invitationStatus, 'disabled');
      assert.equal(res.json().invitation, null);
      expectProblem(await request(disabled, 'POST', `/users/${res.json().user.id}/invitations`, { session: admin }), 409, 'INVITATIONS_DISABLED');
      assert.equal((await database.db.select().from(accountInvitations).where(eq(accountInvitations.userId, res.json().user.id))).length, 0);
    } finally {
      await disabled.close();
    }
  });

  it('previews and applies CSV student enrollments all-or-nothing, reporting every row', async () => {
    const [p1, p2, p3, inactive, staff, withdrawn] = await Promise.all([account(), account(), account(), account(), account(), account()]);
    await call('POST', `/users/${inactive!.id}/deactivate`, admin);
    await enroll(course.a.id, staff!.id, 'instructor');
    const withdrawnId = await enroll(course.a.id, withdrawn!.id, 'student');
    await call('PUT', `/courses/${course.a.id}/enrollments/${withdrawnId}`, admin, { status: 'inactive' });
    await enroll(course.a.id, p3!.id, 'student');

    const csv = [
      'email,role',
      p1!.email.toUpperCase(),
      `${p2!.email},student`,
      p3!.email,
      p1!.email,
      'not an email',
      'nobody@academiapath.example',
      inactive!.email,
      `${staff!.email},student`,
      withdrawn!.email,
      `${p2!.email.replace('@', '+x@')},instructor`,
    ].join('\n');
    const preview = await call('POST', `/courses/${course.a.id}/enrollments/import`, admin, { csv });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().applied, false);
    assert.deepEqual(
      preview.json().rows.map((r: { line: number; outcome: string; errorCode: string | null }) => [r.line, r.outcome, r.errorCode]),
      [
        [2, 'create', null],
        [3, 'create', null],
        [4, 'unchanged', null],
        [5, 'error', 'DUPLICATE_ROW'],
        [6, 'error', 'INVALID_EMAIL'],
        [7, 'error', 'USER_NOT_FOUND'],
        [8, 'error', 'USER_INACTIVE'],
        [9, 'error', 'ROLE_CONFLICT'],
        [10, 'error', 'ENROLLMENT_INACTIVE'],
        [11, 'error', 'ROLE_NOT_ALLOWED'],
      ],
    );
    assert.deepEqual(preview.json().summary, { total: 10, create: 2, unchanged: 1, errors: 7 });

    const countA = async () => (await database.pool.query('SELECT count(*)::int AS n FROM enrollments WHERE course_id = $1', [course.a.id])).rows[0].n;
    const beforeApply = await countA();
    expectProblem(await call('POST', `/courses/${course.a.id}/enrollments/import`, admin, { csv, apply: true }), 422, 'IMPORT_HAS_ERRORS');
    assert.equal(await countA(), beforeApply, 'nothing applied when any row fails');

    const clean = [p1!.email, `${p2!.email},student`, p3!.email].join('\r\n');
    const applied = await call('POST', `/courses/${course.a.id}/enrollments/import`, admin, { csv: clean, apply: true });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.deepEqual([applied.json().applied, applied.json().summary], [true, { total: 3, create: 2, unchanged: 1, errors: 0 }]);
    assert.equal(await countA(), beforeApply + 2);
    assert.ok((await audits('enrollments.imported')).some((a) => a.entity === course.a.id && (a.metadata as { after: { created: number } }).after.created === 2));
    const rerun = (await call('POST', `/courses/${course.a.id}/enrollments/import`, admin, { csv: clean, apply: true })).json();
    assert.deepEqual(rerun.summary, { total: 3, create: 0, unchanged: 3, errors: 0 }, 'repeatable');

    expectProblem(await call('POST', '/courses/00000000-0000-4000-8000-000000000000/enrollments/import', admin, { csv: clean }), 404, 'NOT_FOUND');
    const tooMany = Array.from({ length: 501 }, (_, i) => `bulk${i}@academiapath.example`).join('\n');
    expectProblem(await call('POST', `/courses/${course.a.id}/enrollments/import`, admin, { csv: tooMany }), 422, 'IMPORT_TOO_LARGE');
    expectProblem(await call('POST', `/courses/${course.a.id}/enrollments/import`, admin, { csv: clean, apply: 'yes' }), 400, 'VALIDATION_ERROR');
  });

  it('keeps sessions and directory data consistent for a deactivated administrator', async () => {
    const second = await account({ systemRole: 'administrator', prefix: 'admin.extra' });
    const secondSession = await signIn(second.email);
    assert.equal((await call('GET', '/users', secondSession)).statusCode, 200);
    await call('POST', `/users/${second.id}/deactivate`, admin);
    expectProblem(await call('GET', '/users', secondSession), 401, 'UNAUTHENTICATED');
    const listed = (await call('GET', `/users?q=${encodeURIComponent(second.email)}&status=inactive`, admin)).json().items;
    assert.equal(listed.length, 1);
    const revoked = await database.db.select().from(sessions).where(eq(sessions.userId, second.id));
    assert.ok(revoked.every((s) => s.revokedAt !== null));
  });
});
