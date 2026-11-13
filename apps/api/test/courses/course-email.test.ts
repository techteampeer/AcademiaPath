/**
 * Course e-mail composition (AP-044): the BCC recipient list for an e-mail that instructors write and send from their
 * own e-mail application. Against a temporary PostgreSQL database (skipped unless TEST_DATABASE_URL is set);
 * synthetic users. Tests run in order.
 *
 * Course A (published): instructor, design team (reviewer), non-editing instructor (assistant) and students s1, s2
 * (active), s3 (enrollment made inactive), s4 (account deactivated), plus two students whose stored addresses are
 * blank or invalid. Course B belongs to another instructor and has its own student. Course C has no students.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { userCredentials, users } from '../../src/db/schema/index.js';
import { emailRecipientList } from '../../src/messaging/email-recipients.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const EMAILS = {
  admin: DEV_USERS[0]!.email,
  instructor: DEV_USERS[1]!.email,
  s1: DEV_USERS[2]!.email,
  reviewer: DEV_USERS[3]!.email,
  assistant: 'mail.assistant@academiapath.example',
  s2: 'Mail.Student2@AcademiaPath.example',
  s3: 'mail.student3@academiapath.example',
  s4: 'mail.student4@academiapath.example',
  instructorB: 'mail.instructor2@academiapath.example',
  outsider: 'mail.outsider@academiapath.example',
  pm: 'mail.manager@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Session = { token: string; csrf: string; userId: string };
type Recipients = { course: { id: string; code: string; title: string }; recipientCount: number; recipients: Array<{ name: string; email: string }>; excluded: { invalidEmail: number; duplicateEmail: number } };

describe('course e-mail recipients: list rules (AP-044)', () => {
  it('keeps one valid address per person, compared without case or spaces, as stored', () => {
    const list = emailRecipientList([
      { email: 'Ana.Quispe@Example.edu', givenName: 'Ana', familyName: 'Quispe' },
      { email: ' ana.quispe@example.edu ', givenName: 'Ana', familyName: 'Quispe (2)' },
      { email: 'luis@example.edu', givenName: 'Luis', familyName: 'Ríos' },
      { email: 'LUIS@EXAMPLE.EDU', givenName: 'Luis', familyName: 'Ríos' },
      { email: '', givenName: 'Sin', familyName: 'Correo' },
      { email: null, givenName: 'Nulo', familyName: 'Correo' },
      { email: 'not-an-address', givenName: 'Mal', familyName: 'Correo' },
      { email: 'a b@example.edu', givenName: 'Con', familyName: 'Espacio' },
      { email: 'x@example.edu,y@example.edu', givenName: 'Dos', familyName: 'Direcciones' },
      { email: 'evil@example.edu\r\nBcc: other@example.edu', givenName: 'Salto', familyName: 'Línea' },
    ]);
    assert.deepEqual(list.recipients, [
      { name: 'Ana Quispe', email: 'Ana.Quispe@Example.edu' },
      { name: 'Luis Ríos', email: 'luis@example.edu' },
    ]);
    assert.deepEqual(list.excluded, { invalidEmail: 6, duplicateEmail: 2 });
  });

  it('handles an empty class', () => {
    assert.deepEqual(emailRecipientList([]), { recipients: [], excluded: { invalidEmail: 0, duplicateEmail: 0 } });
  });
});

describe('course e-mail recipients (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  const logLines: string[] = [];
  const as = {} as Record<Person, Session>;
  const ids = {} as Record<'courseA' | 'courseB' | 'courseC' | 'courseD' | 'enrollS3' | 'blank' | 'invalid', string>;

  const request = (who: Person | null, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => {
    const session = who ? as[who] : null;
    return app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: session ? { ap_session: session.token } : {},
      headers: { origin: ORIGIN, ...(session && method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
  };
  const ok = async <T = any>(who: Person, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, status = 200): Promise<T> => {
    const res = await request(who, method, url, body);
    assert.equal(res.statusCode, status, `${method} ${url} as ${who}: ${res.body}`);
    return (res.body ? res.json() : null) as T;
  };
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };
  const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[];
  const recipients = (who: Person, course: string) => ok<Recipients>(who, 'GET', `/courses/${course}/email-recipients`);
  const studentEmails = Object.entries(EMAILS).filter(([person]) => /^s\d|outsider/.test(person)).map(([, email]) => email.toLowerCase());

  before(async () => {
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const passwordHash = await hashPassword(PASSWORD);
    for (const person of ['assistant', 's2', 's3', 's4', 'instructorB', 'outsider', 'pm'] as const) {
      const [user] = await database.db.insert(users).values({ email: EMAILS[person], givenName: `Rosa ${person}`, familyName: 'Ñahui' }).returning();
      await database.db.insert(userCredentials).values({ userId: user!.id, passwordHash });
    }
    // Two students whose stored addresses are not usable (written directly: the account forms never allow them).
    const [blank] = await database.db.insert(users).values({ email: '', givenName: 'Sin', familyName: 'Correo' }).returning();
    const [invalid] = await database.db.insert(users).values({ email: 'not-an-address', givenName: 'Correo', familyName: 'Inválido' }).returning();
    ids.blank = blank!.id;
    ids.invalid = invalid!.id;
    app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000' }),
      database: database.db,
      logger: { level: 'info', stream: { write: (line: string) => void logLines.push(line) } },
    });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAILS[person], password: PASSWORD }, headers: { origin: ORIGIN } });
      assert.equal(res.statusCode, 200, res.body);
      as[person] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
    }
    const program = await ok('admin', 'POST', '/programs', { code: 'MAIL', name: 'Programa de Correo' }, 201);
    const term = await ok('admin', 'POST', '/terms', { code: '2026-2', name: 'Semestre 2026-2', startsOn: '2026-08-17', endsOn: '2026-12-11' }, 201);
    const template = await ok('admin', 'POST', '/course-templates', { code: 'MAIL-T', programId: program.id, title: 'Correo', sections: [{ title: 'Unidad 1' }] }, 201);
    const course = async (code: string) => (await ok('admin', 'POST', '/courses', { programId: program.id, termId: term.id, templateId: template.templateId, code, status: 'published' }, 201)).id as string;
    ids.courseA = await course('MAIL-A');
    ids.courseB = await course('MAIL-B');
    ids.courseC = await course('MAIL-C');
    ids.courseD = await course('MAIL-D');
    const enroll = async (courseId: string, person: Person, role: string) => (await ok('admin', 'POST', `/courses/${courseId}/enrollments`, { email: EMAILS[person], role }, 201)).id as string;
    for (const [person, role] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['assistant', 'non_editing_instructor'], ['s1', 'student'], ['s2', 'student'], ['s4', 'student']] as const) {
      await enroll(ids.courseA, person, role);
    }
    ids.enrollS3 = await enroll(ids.courseA, 's3', 'student');
    await ok('admin', 'PUT', `/courses/${ids.courseA}/enrollments/${ids.enrollS3}`, { status: 'inactive' });
    for (const userId of [ids.blank, ids.invalid]) await ok('admin', 'POST', `/courses/${ids.courseA}/enrollments`, { userId, role: 'student' }, 201);
    await ok('admin', 'POST', `/users/${as.s4.userId}/deactivate`);
    await enroll(ids.courseB, 'instructorB', 'instructor');
    await enroll(ids.courseB, 'outsider', 'student');
    await enroll(ids.courseC, 'instructor', 'instructor');
    await enroll(ids.courseD, 'instructor', 'instructor');
    await ok('admin', 'POST', `/programs/${program.id}/managers`, { email: EMAILS.pm }, 201);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  it('instructors of the course get its active students only, with exclusions counted', async () => {
    const res = await request('instructor', 'GET', `/courses/${ids.courseA}/email-recipients`);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = res.json() as Recipients;
    assert.deepEqual(body.course, { id: ids.courseA, code: 'MAIL-A', title: body.course.title });
    assert.deepEqual(
      body.recipients.map((r) => r.email).sort(),
      [EMAILS.s1, EMAILS.s2].sort(),
      'active students only: no inactive enrollment, no deactivated account, no staff',
    );
    assert.equal(body.recipientCount, 2);
    assert.ok(body.recipients.some((r) => r.email === EMAILS.s2), 'an address is returned as stored');
    assert.deepEqual(body.excluded, { invalidEmail: 2, duplicateEmail: 0 }, 'blank and invalid stored addresses are left out and counted');
    for (const staff of [EMAILS.instructor, EMAILS.reviewer, EMAILS.assistant, EMAILS.s3, EMAILS.s4]) assert.doesNotMatch(res.body, new RegExp(staff.replace(/[.]/g, '\\.'), 'i'));
    assert.deepEqual(Object.keys(body.recipients[0]!).sort(), ['email', 'name'], 'nothing but a name and an address');
  });

  it('administrators may use it in any course (existing institutional access)', async () => {
    assert.equal((await recipients('admin', ids.courseA)).recipientCount, 2);
    assert.deepEqual((await recipients('admin', ids.courseB)).recipients.map((r) => r.email), [EMAILS.outsider]);
  });

  it('instructors of other courses, students, non-editing instructors, the design team and program managers are refused', async () => {
    problem(await request('instructorB', 'GET', `/courses/${ids.courseA}/email-recipients`), 404, 'NOT_FOUND');
    problem(await request('instructor', 'GET', `/courses/${ids.courseB}/email-recipients`), 404, 'NOT_FOUND');
    problem(await request('s1', 'GET', `/courses/${ids.courseA}/email-recipients`), 403, 'FORBIDDEN');
    problem(await request('outsider', 'GET', `/courses/${ids.courseA}/email-recipients`), 404, 'NOT_FOUND');
    problem(await request('assistant', 'GET', `/courses/${ids.courseA}/email-recipients`), 403, 'FORBIDDEN');
    problem(await request('reviewer', 'GET', `/courses/${ids.courseA}/email-recipients`), 403, 'FORBIDDEN');
    problem(await request('pm', 'GET', `/courses/${ids.courseA}/email-recipients`), 404, 'NOT_FOUND');
    problem(await request(null, 'GET', `/courses/${ids.courseA}/email-recipients`), 401, 'UNAUTHENTICATED');
    problem(await request('instructor', 'GET', '/courses/not-a-uuid/email-recipients'), 400, 'VALIDATION_ERROR');
    for (const who of ['instructorB', 's1', 'outsider', 'assistant', 'reviewer', 'pm', null] as const) {
      const res = await request(who, 'GET', `/courses/${ids.courseA}/email-recipients`);
      for (const email of studentEmails) assert.ok(!res.body.toLowerCase().includes(email), `${who ?? 'anonymous'} sees no student address`);
    }
  });

  it('active versus inactive enrollments follow the current enrollment status', async () => {
    await ok('admin', 'PUT', `/courses/${ids.courseA}/enrollments/${ids.enrollS3}`, { status: 'active' });
    assert.ok((await recipients('instructor', ids.courseA)).recipients.some((r) => r.email === EMAILS.s3), 'reactivated enrollment is included');
    await ok('admin', 'PUT', `/courses/${ids.courseA}/enrollments/${ids.enrollS3}`, { status: 'inactive' });
    assert.ok(!(await recipients('instructor', ids.courseA)).recipients.some((r) => r.email === EMAILS.s3), 'inactive again: excluded');
  });

  it('an empty class has no recipients', async () => {
    assert.deepEqual(await recipients('instructor', ids.courseC), { course: (await recipients('admin', ids.courseC)).course, recipientCount: 0, recipients: [], excluded: { invalidEmail: 0, duplicateEmail: 0 } });
  });

  it('large classes return every unique address', async () => {
    const values = Array.from({ length: 320 }, (_, i) => `('large.student${String(i).padStart(3, '0')}@academiapath.example', 'Estudiante', 'Número ${i}')`).join(',');
    const created = await query<{ id: string }>(`INSERT INTO users (email, given_name, family_name) VALUES ${values} RETURNING id`);
    await query(`INSERT INTO enrollments (course_id, user_id, role) SELECT $1, unnest($2::uuid[]), 'student'`, [ids.courseD, created.map((row) => row.id)]);
    const list = await recipients('instructor', ids.courseD);
    assert.equal(list.recipientCount, 320);
    assert.equal(new Set(list.recipients.map((r) => r.email.toLowerCase())).size, 320);
  });

  it('each listing is audited with counts only; addresses never reach the audit log or the request log', async () => {
    const rows = await query<{ actor_user_id: string; metadata: { after: Record<string, number> } }>(
      "SELECT actor_user_id, metadata FROM audit_log WHERE action = 'course.email_recipients_listed' AND entity_id = $1 ORDER BY created_at",
      [ids.courseA],
    );
    assert.ok(rows.length >= 4);
    assert.deepEqual(rows[0]!.metadata.after, { recipients: 2, invalidEmail: 2, duplicateEmail: 0 });
    assert.equal(rows[0]!.actor_user_id, as.instructor.userId);
    const audit = JSON.stringify(await query("SELECT metadata FROM audit_log WHERE action = 'course.email_recipients_listed'"));
    assert.doesNotMatch(audit, /@/, 'no address in the audit log');
    const refused = await query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'course.email_recipients_listed' AND actor_user_id = ANY($1::uuid[])", [[as.s1.userId, as.assistant.userId, as.reviewer.userId, as.instructorB.userId]]);
    assert.equal(refused[0]!.n, 0, 'refused requests list nothing and audit nothing');
    assert.ok(logLines.some((line) => line.includes('/email-recipients')), 'requests are logged (method, URL, status)');
    const logs = logLines.join('\n').toLowerCase();
    for (const email of [...studentEmails, 'large.student000@academiapath.example']) assert.ok(!logs.includes(email), `request log never contains ${email}`);
  });

  it('nothing can be sent, queued or tracked through the API', async () => {
    for (const method of ['POST', 'PUT'] as const) {
      const res = await request('instructor', method, `/courses/${ids.courseA}/email-recipients`, {});
      assert.equal(res.statusCode, 404, `${method} has no route`);
    }
    assert.equal((await query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name ILIKE '%email%'"))[0]!.n, 0, 'no e-mail storage');
  });

  it('existing course messaging keeps working for the same people', async () => {
    const messaging = await ok<{ role: string; contacts: Array<{ id: string }> }>('instructor', 'GET', `/courses/${ids.courseA}/messaging`);
    assert.equal(messaging.role, 'instructor');
    assert.deepEqual(messaging.contacts.map((c) => c.id).sort(), [as.s1.userId, as.s2.userId, ids.blank, ids.invalid].sort(), 'in-app contacts still include every active student');
    assert.equal((await ok<{ role: string }>('s1', 'GET', `/courses/${ids.courseA}/messaging`)).role, 'student');
  });
});
