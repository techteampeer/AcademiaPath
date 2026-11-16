/**
 * AP-DEMO-02: administrator-handed-over activation links (ACCOUNT_INVITATION_DELIVERY=administrator_handoff) against
 * a temporary PostgreSQL database (skipped unless TEST_DATABASE_URL is set). An administrator creates a pending
 * account with its roles, explicitly issues a short-lived single-use link after confirming the person's identity and
 * hands it over privately; the person chooses their own password. Every account here is synthetic, nothing is sent
 * anywhere and every password is random per run.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { eq, inArray, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp, type BuildAppOptions } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { accountInvitations, auditLog, userCredentials, users, type SystemRole } from '../../src/db/schema/index.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = randomBytes(18).toString('base64url');
const HANDOFF = { ACCOUNT_INVITATION_DELIVERY: 'administrator_handoff' };
const CONFIRMED = { identityConfirmed: true };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/** A fresh password the "person" chooses on the activation page. */
const chosenPassword = () => `Chosen ${randomBytes(9).toString('base64url')}`;

type App = ReturnType<typeof buildApp>;
type Session = { token: string; csrf: string; userId: string };
type Method = 'GET' | 'POST' | 'PUT';
type Invitation = { id: string; expiresAt: string; delivery: string; activationPath: string };

describe('administrator-handed-over activation links (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: App;
  const logLines: string[] = [];
  let admin: Session;
  let instructor: Session;
  let student: Session;
  let seq = 0;
  const course: Record<'a' | 'b', string> = {} as never;

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

  /** A synthetic account that already has a password (created directly, like the seed jobs). */
  const account = async (systemRole: SystemRole = 'user') => {
    seq += 1;
    const email = `existing${seq}@academiapath.example`;
    const [user] = await database.db.insert(users).values({ email, givenName: 'Demo', familyName: `Existing ${seq}`, systemRole }).returning();
    await database.db.insert(userCredentials).values({ userId: user!.id, passwordHash: await hashPassword(PASSWORD) });
    return { id: user!.id, email };
  };

  const createUser = async (body: Record<string, unknown>) => {
    const res = await call('POST', '/users', admin, body);
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { user: { id: string; email: string; systemRole: string }; invitation: Invitation | null; invitationStatus: string };
  };
  const issue = async (userId: string) => {
    const res = await call('POST', `/users/${userId}/invitations`, admin, CONFIRMED);
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as Invitation;
  };
  const tokenOf = (invitation: Invitation) => invitation.activationPath.split('#token=')[1]!;
  const preview = (token: string) => request(app, 'POST', '/auth/activation/preview', { body: { token } });
  const activate = (token: string, password: string, extra: Record<string, unknown> = {}) =>
    request(app, 'POST', '/auth/activate', { body: { token, password, ...extra } });
  const invitationsOf = (userId: string) => database.db.select().from(accountInvitations).where(eq(accountInvitations.userId, userId));
  const credentialOf = async (userId: string) => (await database.db.select().from(userCredentials).where(eq(userCredentials.userId, userId)))[0];
  const issuedAudits = async (userId: string) =>
    (await database.db.select().from(auditLog).where(eq(auditLog.action, 'user.invitation_issued')).orderBy(auditLog.createdAt))
      .filter((row) => row.entityId === userId)
      .map((row) => ({ actor: row.actorUserId, after: (row.metadata as { after: Record<string, unknown> }).after }));

  before(async () => {
    database = await createTestDatabase();
    app = makeApp(HANDOFF, { level: 'info', stream: { write: (line: string) => void logLines.push(line) } });
    await app.ready();
    admin = await signIn((await account('administrator')).email);

    const program = (await call('POST', '/programs', admin, { code: 'HO', name: 'Handoff' })).json();
    const term = (await call('POST', '/terms', admin, { code: '2026-2', name: 'Semestre 2026-2', startsOn: '2026-08-17', endsOn: '2026-12-11' })).json();
    for (const key of ['a', 'b'] as const) {
      const template = await call('POST', '/course-templates', admin, { code: `HO-${key}`, programId: program.id, title: `Course ${key}`, sections: [{ title: 'Unit 1' }] });
      assert.equal(template.statusCode, 201, template.body);
      const created = await call('POST', '/courses', admin, { programId: program.id, termId: term.id, templateId: template.json().templateId, code: `HO-${key}-01`, status: 'published' });
      assert.equal(created.statusCode, 201, created.body);
      course[key] = created.json().id;
    }
    const teacher = await account();
    const learner = await account();
    for (const [person, role] of [[teacher, 'instructor'], [learner, 'student']] as const) {
      const res = await call('POST', `/courses/${course.a}/enrollments`, admin, { userId: person.id, role });
      assert.equal(res.statusCode, 201, res.body);
    }
    instructor = await signIn(teacher.email);
    student = await signIn(learner.email);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  it('creates a pending account without a link; only a confirmed administrator request issues a 24-hour link', async () => {
    // Handed-over links do not need a reserved demonstration domain: nothing is ever sent to the address.
    const created = await createUser({ email: 'handoff.tester@academiapath.pe', givenName: 'Demo', familyName: 'Handoff' });
    assert.equal(created.invitationStatus, 'handoff_required');
    assert.equal(created.invitation, null, 'never issued automatically');
    assert.equal((await invitationsOf(created.user.id)).length, 0);
    const pending = (await call('GET', `/users/${created.user.id}`, admin)).json();
    assert.deepEqual([pending.activationState, pending.activation.pendingInvitation], ['pending', null]);

    for (const body of [undefined, null, {}, { identityConfirmed: false }]) {
      expectProblem(await call('POST', `/users/${created.user.id}/invitations`, admin, body), 422, 'INVITATION_CONFIRMATION_REQUIRED');
    }
    expectProblem(await call('POST', `/users/${created.user.id}/invitations`, admin, { ...CONFIRMED, delivery: 'local_link' }), 400, 'VALIDATION_ERROR');
    assert.equal((await invitationsOf(created.user.id)).length, 0, 'refused requests issue nothing');

    const issuedAt = Date.now();
    const invitation = await issue(created.user.id);
    assert.equal(invitation.delivery, 'administrator_handoff');
    assert.match(invitation.activationPath, /^\/activate#token=[A-Za-z0-9_-]{43}$/, 'the token travels in the fragment, never the query');
    const lifetime = Date.parse(invitation.expiresAt) - issuedAt;
    assert.ok(lifetime > 23.9 * 3_600_000 && lifetime <= 24 * 3_600_000 + 60_000, `expires in about 24 hours (${lifetime} ms)`);

    const token = tokenOf(invitation);
    const [stored] = await invitationsOf(created.user.id);
    assert.equal(stored!.tokenHash, sha256(token), 'only the SHA-256 hash is stored');
    assert.equal(stored!.createdByUserId, admin.userId);
    const shown = await preview(token);
    assert.equal(shown.statusCode, 200, shown.body);
    assert.equal(shown.json().email, 'handoff.tester@academiapath.pe');
    const detail = (await call('GET', `/users/${created.user.id}`, admin)).json();
    assert.equal(detail.activation.pendingInvitation.id, invitation.id);
    assert.equal(detail.activation.pendingInvitation.expired, false);
    assert.doesNotMatch(JSON.stringify(detail), new RegExp(token), 'the link is shown once, never again');
  });

  it('refuses everyone but an administrator, and requests without CSRF or from another origin', async () => {
    const target = (await createUser({ email: 'refused.person@academiapath.pe', givenName: 'Demo', familyName: 'Refused' })).user;
    const url = `/users/${target.id}/invitations`;
    for (const session of [instructor, student]) {
      expectProblem(await call('POST', url, session, CONFIRMED), 403, 'FORBIDDEN');
      expectProblem(await call('POST', '/users', session, { email: 'self.made@academiapath.pe', givenName: 'Self', familyName: 'Made' }), 403, 'FORBIDDEN');
      expectProblem(await call('GET', `/users/${target.id}`, session), 403, 'FORBIDDEN');
    }
    expectProblem(await request(app, 'POST', url, { body: CONFIRMED }), 401, 'UNAUTHENTICATED');
    expectProblem(await request(app, 'POST', '/users', { body: { email: 'anonymous@academiapath.pe', givenName: 'Any', familyName: 'One' } }), 401, 'UNAUTHENTICATED');
    expectProblem(await request(app, 'POST', url, { session: admin, body: CONFIRMED, csrf: null }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await request(app, 'POST', url, { session: admin, body: CONFIRMED, csrf: 'forged' }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await request(app, 'POST', url, { session: admin, body: CONFIRMED, origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
    assert.equal((await request(app, 'POST', '/auth/register', { body: { email: 'open@academiapath.pe', password: chosenPassword() } })).statusCode, 404, 'no public registration');
    assert.equal((await invitationsOf(target.id)).length, 0);
    const emails = ['self.made@academiapath.pe', 'anonymous@academiapath.pe', 'open@academiapath.pe'];
    assert.equal((await database.db.select().from(users).where(inArray(users.email, emails))).length, 0, 'no account was created');
  });

  it('activates once with exactly the roles the administrator assigned; the person chooses the password', async () => {
    const created = await createUser({
      email: 'role.check@academiapath.pe',
      givenName: 'Demo',
      familyName: 'Roles',
      enrollments: [
        { courseId: course.a, role: 'instructor' },
        { courseId: course.b, role: 'student' },
      ],
    });
    assert.equal(created.user.systemRole, 'user', 'not an administrator unless chosen');
    const token = tokenOf(await issue(created.user.id));

    expectProblem(await activate(token, chosenPassword(), { systemRole: 'administrator' }), 400, 'VALIDATION_ERROR');
    expectProblem(await activate(token, 'short pass'), 400, 'VALIDATION_ERROR');
    assert.equal((await preview(token)).statusCode, 200, 'refused attempts do not use the link');

    const password = chosenPassword();
    assert.equal((await activate(token, password)).statusCode, 204);
    const session = await signIn('role.check@academiapath.pe', password);
    assert.equal((await request(app, 'GET', '/me', { session })).json().user.systemRole, 'user');
    const visible = (await request(app, 'GET', '/courses', { session })).json().items as Array<{ id: string; viewerRole: string }>;
    assert.deepEqual(visible.map((c) => [c.id, c.viewerRole]).sort(), [[course.a, 'instructor'], [course.b, 'student']].sort());
    expectProblem(await request(app, 'GET', '/users', { session }), 403, 'FORBIDDEN');
    assert.match((await credentialOf(created.user.id))!.passwordHash, /^\$argon2id\$/);

    // Replay of a used link, and a second link for an activated account (links are never password resets).
    expectProblem(await activate(token, chosenPassword()), 400, 'INVITATION_INVALID');
    expectProblem(await preview(token), 400, 'INVITATION_INVALID');
    expectProblem(await call('POST', `/users/${created.user.id}/invitations`, admin, CONFIRMED), 409, 'ACCOUNT_ALREADY_ACTIVATED');
    await signIn('role.check@academiapath.pe', password);

    // An administrator account is only provisioned when the administrator explicitly chooses that role.
    const staff = await createUser({ email: 'staff.check@academiapath.pe', givenName: 'Demo', familyName: 'Staff', systemRole: 'administrator' });
    const staffPassword = chosenPassword();
    assert.equal((await activate(tokenOf(await issue(staff.user.id)), staffPassword)).statusCode, 204);
    const staffSession = await signIn('staff.check@academiapath.pe', staffPassword);
    assert.equal((await request(app, 'GET', '/users', { session: staffSession })).statusCode, 200);
  });

  it('replaces the open link on re-issue and refuses replayed, revoked and expired links', async () => {
    const created = await createUser({ email: 'replay.check@academiapath.pe', givenName: 'Demo', familyName: 'Replay' });
    const first = tokenOf(await issue(created.user.id));
    const second = tokenOf(await issue(created.user.id));
    expectProblem(await preview(first), 400, 'INVITATION_INVALID');
    expectProblem(await activate(first, chosenPassword()), 400, 'INVITATION_INVALID');

    // Deactivation revokes the open link; after reactivation a new confirmed link is needed.
    assert.equal((await call('POST', `/users/${created.user.id}/deactivate`, admin)).statusCode, 200);
    expectProblem(await activate(second, chosenPassword()), 400, 'INVITATION_INVALID');
    expectProblem(await call('POST', `/users/${created.user.id}/invitations`, admin, CONFIRMED), 422, 'USER_INACTIVE');
    assert.equal((await call('POST', `/users/${created.user.id}/reactivate`, admin)).statusCode, 200);
    expectProblem(await activate(second, chosenPassword()), 400, 'INVITATION_INVALID');
    const third = tokenOf(await issue(created.user.id));

    const results = await Promise.all([activate(third, chosenPassword()), activate(third, chosenPassword())]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [204, 400], 'concurrent replay: exactly one activation');
    assert.equal((await database.db.select().from(userCredentials).where(eq(userCredentials.userId, created.user.id))).length, 1);

    // Expired links are refused (the database also refuses to extend them).
    const expiring = await createUser({ email: 'expired.check@academiapath.pe', givenName: 'Demo', familyName: 'Expired' });
    await issue(expiring.user.id);
    await database.db.update(accountInvitations).set({ revokedAt: sql`now()` }).where(eq(accountInvitations.userId, expiring.user.id));
    const stale = randomBytes(32).toString('base64url');
    await database.db.insert(accountInvitations).values({
      userId: expiring.user.id,
      tokenHash: sha256(stale),
      createdByUserId: admin.userId,
      createdAt: sql`now() - interval '25 hours'`,
      expiresAt: sql`now() - interval '1 hour'`,
    });
    expectProblem(await preview(stale), 400, 'INVITATION_INVALID');
    expectProblem(await activate(stale, chosenPassword()), 400, 'INVITATION_INVALID');
    assert.equal((await call('GET', `/users/${expiring.user.id}`, admin)).json().activation.pendingInvitation.expired, true);
    assert.equal(await credentialOf(expiring.user.id), undefined);
  });

  it('never issues links for activated accounts: the demo-style seeded accounts keep their passwords and roles', async () => {
    await seedDevUsers(database.db, PASSWORD);
    const seeded = await database.db.select().from(users).where(inArray(users.email, DEV_USERS.map((u) => u.email)));
    assert.equal(seeded.length, DEV_USERS.length);
    const hashesBefore = new Map(await Promise.all(seeded.map(async (u) => [u.id, (await credentialOf(u.id))!.passwordHash] as const)));
    for (const user of seeded) {
      expectProblem(await call('POST', `/users/${user.id}/invitations`, admin, CONFIRMED), 409, 'ACCOUNT_ALREADY_ACTIVATED');
    }
    const existing = await account();
    expectProblem(await call('POST', `/users/${existing.id}/invitations`, admin, CONFIRMED), 409, 'ACCOUNT_ALREADY_ACTIVATED');
    assert.equal((await database.db.select().from(accountInvitations).where(inArray(accountInvitations.userId, [...hashesBefore.keys(), existing.id]))).length, 0);
    for (const devUser of DEV_USERS) {
      const session = await signIn(devUser.email);
      assert.equal((await request(app, 'GET', '/me', { session })).json().user.systemRole, devUser.systemRole, devUser.email);
    }
    await signIn(existing.email);
    for (const [id, hash] of hashesBefore) assert.equal((await credentialOf(id))!.passwordHash, hash, 'password unchanged');
  });

  it('audits handed-over links (who, when, identity confirmed) without storing or logging any secret', async () => {
    const created = await createUser({ email: 'audit.check@academiapath.pe', givenName: 'Demo', familyName: 'Audit' });
    const invitation = await issue(created.user.id);
    const token = tokenOf(invitation);
    const password = chosenPassword();
    assert.equal((await activate(token, password)).statusCode, 204);
    await signIn('audit.check@academiapath.pe', password);

    const [issued] = await issuedAudits(created.user.id);
    assert.equal(issued!.actor, admin.userId);
    assert.deepEqual(issued!.after, { invitationId: invitation.id, expiresAt: invitation.expiresAt, delivery: 'administrator_handoff', identityConfirmed: true });
    const activated = await database.db.select().from(auditLog).where(eq(auditLog.action, 'account.activated'));
    assert.ok(activated.some((row) => row.entityId === created.user.id && row.actorUserId === created.user.id));

    const everything = JSON.stringify({
      audit: (await database.pool.query('SELECT * FROM audit_log')).rows,
      invitations: (await database.pool.query('SELECT * FROM account_invitations')).rows,
      credentials: (await database.pool.query('SELECT * FROM user_credentials')).rows,
      users: (await database.pool.query('SELECT * FROM users')).rows,
      logs: logLines,
    });
    for (const secret of [token, password, PASSWORD]) assert.ok(!everything.includes(secret), 'secret found in stored data or logs');
    assert.ok(logLines.length > 0, 'requests were logged');
  });

  it('leaves local synthetic links and disabled delivery unchanged', async () => {
    const local = makeApp();
    const disabled = makeApp({ ACCOUNT_INVITATION_DELIVERY: 'disabled' });
    try {
      const synthetic = await request(local, 'POST', '/users', { session: admin, body: { email: 'local.link@academiapath.example', givenName: 'Demo', familyName: 'Local' } });
      assert.equal(synthetic.statusCode, 201, synthetic.body);
      assert.deepEqual([synthetic.json().invitationStatus, synthetic.json().invitation.delivery], ['issued', 'local_link']);
      const [localAudit] = await issuedAudits(synthetic.json().user.id);
      assert.equal(localAudit!.after.delivery, 'local_link');
      assert.equal('identityConfirmed' in localAudit!.after, false);

      // Confirming identity never lifts the local synthetic-only rule.
      const real = await request(local, 'POST', '/users', { session: admin, body: { email: 'local.real@academiapath.pe', givenName: 'Demo', familyName: 'Real' } });
      assert.equal(real.json().invitationStatus, 'synthetic_only');
      expectProblem(await request(local, 'POST', `/users/${real.json().user.id}/invitations`, { session: admin, body: CONFIRMED }), 422, 'INVITATION_SYNTHETIC_ONLY');
      const reissued = await request(local, 'POST', `/users/${synthetic.json().user.id}/invitations`, { session: admin });
      assert.equal(reissued.statusCode, 201, 'local links need no confirmation');
      assert.equal(reissued.json().delivery, 'local_link');

      const off = await request(disabled, 'POST', '/users', { session: admin, body: { email: 'disabled.link@academiapath.pe', givenName: 'Demo', familyName: 'Off' } });
      assert.deepEqual([off.json().invitationStatus, off.json().invitation], ['disabled', null]);
      expectProblem(await request(disabled, 'POST', `/users/${off.json().user.id}/invitations`, { session: admin, body: CONFIRMED }), 409, 'INVITATIONS_DISABLED');
      assert.equal((await invitationsOf(off.json().user.id)).length, 0);
    } finally {
      await local.close();
      await disabled.close();
    }
  });
});
