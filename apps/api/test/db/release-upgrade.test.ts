/**
 * Stakeholder release (AP-043 + AP-044 + AP-045) upgrade check. A temporary database is migrated to the state before
 * the release (through 0033) and filled with representative records: courses with units, enrollments, course and
 * institution calendar events, a certificate policy and an issued certificate. Then migrations 0034 (certificate
 * signatories) and 0035 (hybrid teaching sessions) are applied and both features are exercised on that data.
 * Skipped unless TEST_DATABASE_URL is set; synthetic users only.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { createTestDatabase, migrationsBefore, migrationsFolder, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const SIGNER = { name: 'María Fernanda Quispe Huamán', title: 'Directora de Programas Académicos' };

describe('stakeholder release upgrade from 0033 (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let previous: Awaited<ReturnType<typeof migrationsBefore>> | undefined;
  let app: ReturnType<typeof buildApp>;
  const ids = {} as Record<'staff' | 'reviewer' | 'student' | 'student2' | 'courseA' | 'courseB' | 'unitA1' | 'unitA2' | 'unitB' | 'certificate' | 'token' | 'event', string>;
  const cookies = {} as Record<'staff' | 'reviewer' | 'student2', { token: string; csrf: string }>;
  const raw = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[];
  const request = (who: keyof typeof cookies | null, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: who ? { ap_session: cookies[who].token } : {},
      headers: { origin: ORIGIN, ...(who && method !== 'GET' ? { 'x-csrf-token': cookies[who].csrf } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
  const ok = async <T = any>(who: keyof typeof cookies, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, status = 200): Promise<T> => {
    const res = await request(who, method, url, body);
    assert.equal(res.statusCode, status, `${method} ${url}: ${res.body}`);
    return res.json() as T;
  };
  let beforeEvents: Array<Record<string, unknown>> = [];
  let beforeCertificate: Record<string, unknown> = {};
  let guardsBefore: Array<Record<string, unknown>> = [];
  const guards = () => raw("SELECT p.proname, pg_get_functiondef(p.oid) AS body FROM pg_proc p WHERE p.proname LIKE 'course_certificates_%' ORDER BY p.proname");

  before(async () => {
    previous = await migrationsBefore('0034_certificate_signatories');
    database = await createTestDatabase({ migrationsFolder: previous.folder });
    const hash = await hashPassword(PASSWORD);
    const people = await raw<{ id: string; email: string }>(
      `INSERT INTO users (email, given_name, family_name) VALUES
       ('release.staff@academiapath.example', 'Elena', 'Ríos'), ('release.reviewer@academiapath.example', 'Raúl', 'Paz'),
       ('release.student@academiapath.example', 'Ana', 'Ñúñez'), ('release.student2@academiapath.example', 'Luis', 'Ccori')
       RETURNING id, email`,
    );
    const byEmail = (prefix: string) => people.find((p) => p.email.startsWith(prefix))!.id;
    ids.staff = byEmail('release.staff');
    ids.reviewer = byEmail('release.reviewer');
    ids.student = byEmail('release.student@');
    ids.student2 = byEmail('release.student2');
    for (const person of people) await raw('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [person.id, hash]);
    const [term] = await raw<{ id: string }>("INSERT INTO terms (code, name, starts_on, ends_on, academic_year) VALUES ('2026-2', 'Semestre 2026-2', '2026-08-17', '2026-12-11', 2026) RETURNING id");
    const courses = await raw<{ id: string; code: string }>("INSERT INTO courses (term_id, code, title, status) VALUES ($1, 'REL-A', 'Curso Histórico A', 'published'), ($1, 'REL-B', 'Curso Histórico B', 'published') RETURNING id, code", [term!.id]);
    ids.courseA = courses.find((c) => c.code === 'REL-A')!.id;
    ids.courseB = courses.find((c) => c.code === 'REL-B')!.id;
    const units = await raw<{ id: string; title: string }>("INSERT INTO sections (course_id, title, position) VALUES ($1, 'Unidad 1', 0), ($1, 'Unidad 2', 1), ($2, 'Unidad ajena', 0) RETURNING id, title", [ids.courseA, ids.courseB]);
    ids.unitA1 = units.find((u) => u.title === 'Unidad 1')!.id;
    ids.unitA2 = units.find((u) => u.title === 'Unidad 2')!.id;
    ids.unitB = units.find((u) => u.title === 'Unidad ajena')!.id;
    const enrollments = await raw<{ id: string; user_id: string }>(
      "INSERT INTO enrollments (course_id, user_id, role) VALUES ($1, $2, 'instructor'), ($1, $3, 'design_team'), ($1, $4, 'student'), ($1, $5, 'student') RETURNING id, user_id",
      [ids.courseA, ids.staff, ids.reviewer, ids.student, ids.student2],
    );
    const studentEnrollment = enrollments.find((e) => e.user_id === ids.student)!.id;
    const [event] = await raw<{ id: string }>(
      `INSERT INTO calendar_events (scope, course_id, title, all_day, starts_at, ends_at, time_zone, status, published_at, created_by_user_id, updated_by_user_id)
       VALUES ('course', $1, 'Clase histórica', false, '2026-09-01T00:00:00Z', '2026-09-01T02:00:00Z', 'America/Lima', 'published', now(), $2, $2) RETURNING id`,
      [ids.courseA, ids.staff],
    );
    ids.event = event!.id;
    await raw(
      `INSERT INTO calendar_events (scope, title, all_day, starts_at, ends_at, start_date, end_date, time_zone, status, published_at, created_by_user_id, updated_by_user_id)
       VALUES ('institution', 'Feriado histórico', true, '2026-10-08T05:00:00Z', '2026-10-09T05:00:00Z', '2026-10-08', '2026-10-08', 'America/Lima', 'published', now(), $1, $1)`,
      [ids.staff],
    );
    await raw("INSERT INTO course_certificate_policies (course_id, enabled, require_completion, require_final_grade, issuer_name, version, updated_by_user_id) VALUES ($1, true, true, false, 'Universidad Histórica', 3, $2)", [ids.courseA, ids.staff]);
    ids.token = randomBytes(32).toString('base64url');
    const snapshot = { version: 3, requireCompletion: true, requireFinalGrade: false, minimumGradePercent: null, issuerName: 'Universidad Histórica' };
    const [certificate] = await raw<{ id: string }>(
      `INSERT INTO course_certificates (verification_token, certificate_number, course_id, user_id, enrollment_id, recipient_name, course_title, course_code, term_name, academic_year, issuer_name, policy_version, policy_snapshot, issued_by_user_id)
       VALUES ($1, 'AP-RELE-ASE0-0001', $2, $3, $4, 'Ana Ñúñez', 'Curso Histórico A', 'REL-A', 'Semestre 2026-2', 2026, 'Universidad Histórica', 3, $5::jsonb, $6) RETURNING id`,
      [ids.token, ids.courseA, ids.student, studentEnrollment, JSON.stringify(snapshot), ids.staff],
    );
    ids.certificate = certificate!.id;
    beforeEvents = await raw('SELECT * FROM calendar_events ORDER BY title');
    beforeCertificate = (await raw('SELECT * FROM course_certificates WHERE id = $1', [ids.certificate]))[0]!;
    guardsBefore = await guards();

    await migrate(database.db, { migrationsFolder });

    app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000' }), database: database.db });
    await app.ready();
    for (const [who, email] of [['staff', 'release.staff'], ['reviewer', 'release.reviewer'], ['student2', 'release.student2']] as const) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `${email}@academiapath.example`, password: PASSWORD }, headers: { origin: ORIGIN } });
      assert.equal(res.statusCode, 200, res.body);
      cookies[who] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken };
    }
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    await previous?.cleanup();
  });

  it('both migrations apply in order on top of the existing data', async () => {
    const applied = await raw<{ n: number }>('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    assert.equal(applied[0]!.n, 36, 'migrations 0000–0035');
    const columns = await raw<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE (table_name = 'course_certificate_policies' AND column_name = 'signatories') OR (table_name = 'calendar_events' AND column_name IN ('session_number', 'session_mode', 'join_url', 'session_activity_id')) ORDER BY 1, 2",
    );
    assert.equal(columns.length, 5);
  });

  it('existing events, certificates and certificate guards are preserved', async () => {
    const events = await raw('SELECT * FROM calendar_events ORDER BY title');
    assert.deepEqual(events, beforeEvents.map((row) => ({ ...row, session_number: null, session_mode: null, join_url: null, session_activity_id: null })));
    assert.deepEqual((await raw('SELECT * FROM course_certificates WHERE id = $1', [ids.certificate]))[0], beforeCertificate, 'the issued certificate is untouched');
    assert.deepEqual(await guards(), guardsBefore, 'certificate guard functions unchanged');
    await assert.rejects(raw('UPDATE course_certificates SET policy_snapshot = policy_snapshot || $1::jsonb WHERE id = $2', [JSON.stringify({ signatories: [SIGNER] }), ids.certificate]), /only be revoked/);
    await assert.rejects(raw('DELETE FROM course_certificates WHERE id = $1', [ids.certificate]), /cannot be deleted/);
    const verified = await app.inject({ method: 'GET', url: `/api/v1/certificates/verify/${ids.token}` });
    assert.equal(verified.statusCode, 200, verified.body);
    assert.deepEqual([verified.json().status, verified.json().issuerName, verified.json().signatories], ['valid', 'Universidad Histórica', []], 'the pre-release certificate still verifies, without signatories');
    const calendar = await ok<{ events: Array<{ id: string; session: unknown }> }>('staff', 'GET', `/courses/${ids.courseA}/calendar?from=2026-08-01T00:00:00Z&to=2026-12-01T00:00:00Z`);
    assert.deepEqual(calendar.events.map((e) => [e.id, e.session]), [[ids.event, null]], 'the existing event reads as an ordinary event');
  });

  it('a new certificate on the upgraded policy snapshots its signatories', async () => {
    const policy = await ok<{ version: number; signatories: unknown[] }>('staff', 'GET', `/courses/${ids.courseA}/certificate-policy`);
    assert.deepEqual([policy.version, policy.signatories], [3, []], 'the existing policy has no signatories after the migration');
    await ok('staff', 'PUT', `/courses/${ids.courseA}/certificate-policy`, { expectedVersion: 3, enabled: true, requireCompletion: true, requireFinalGrade: false, minimumGradePercent: null, issuerName: 'Universidad Histórica', signatories: [SIGNER] });
    const activity = await ok<{ id: string }>('staff', 'POST', `/courses/${ids.courseA}/sections/${ids.unitA1}/activities`, { type: 'page', title: 'Lectura', body: 'Contenido sintético.' }, 201);
    await ok('staff', 'POST', `/courses/${ids.courseA}/activities/${activity.id}/submit`);
    await ok('reviewer', 'POST', `/courses/${ids.courseA}/activities/${activity.id}/review`, { decision: 'approve' });
    await ok('student2', 'PUT', `/courses/${ids.courseA}/activities/${activity.id}/completion`);
    const issued = await ok<{ id: string; signatories: unknown[]; policyVersion: number }>('staff', 'POST', `/courses/${ids.courseA}/certificates`, { userId: ids.student2 }, 201);
    assert.deepEqual([issued.signatories, issued.policyVersion], [[SIGNER], 4]);
    const stored = (await raw<{ policy_snapshot: { signatories: unknown[] } }>('SELECT policy_snapshot FROM course_certificates WHERE id = $1', [issued.id]))[0]!.policy_snapshot;
    assert.deepEqual(stored.signatories, [SIGNER]);
    await assert.rejects(raw("UPDATE course_certificates SET policy_snapshot = jsonb_set(policy_snapshot, '{signatories}', '[]') WHERE id = $1", [issued.id]), /only be revoked/);
    assert.deepEqual((await raw('SELECT * FROM course_certificates WHERE id = $1', [ids.certificate]))[0], beforeCertificate, 'the older certificate is still unchanged');
  });

  it('sessions link units of their own course only; an existing event can become a session', async () => {
    const session = await ok<{ session: { number: number; units: Array<{ title: string }> } }>('staff', 'POST', `/courses/${ids.courseA}/calendar/events`, {
      title: 'Sesión 1',
      allDay: false,
      startsAt: '2026-11-23T19:00:00-05:00',
      endsAt: '2026-11-23T21:00:00-05:00',
      timeZone: 'America/Lima',
      status: 'published',
      session: { number: 1, deliveryMode: 'live_online', joinUrl: 'https://meet.example.edu/rel', unitIds: [ids.unitA1, ids.unitA2] },
    }, 201);
    assert.deepEqual([session.session.number, session.session.units.map((u) => u.title)], [1, ['Unidad 1', 'Unidad 2']]);
    const foreign = await request('staff', 'POST', `/courses/${ids.courseA}/calendar/events`, { title: 'Cruzada', allDay: false, startsAt: '2026-11-24T19:00:00-05:00', endsAt: '2026-11-24T21:00:00-05:00', status: 'published', session: { number: 2, deliveryMode: 'live_online', unitIds: [ids.unitB] } });
    assert.equal(foreign.statusCode, 422, foreign.body);
    assert.equal(foreign.json().code, 'SESSION_UNIT_INVALID');
    await assert.rejects(raw('INSERT INTO calendar_event_units (event_id, course_id, section_id) VALUES ($1, $2, $3)', [ids.event, ids.courseA, ids.unitB]), /calendar_event_units_section_fk/);
    const converted = await ok<{ session: { number: number; deliveryMode: string } }>('staff', 'PUT', `/calendar/events/${ids.event}`, {
      title: 'Clase histórica',
      allDay: false,
      startsAt: '2026-09-01T00:00:00Z',
      endsAt: '2026-09-01T02:00:00Z',
      timeZone: 'America/Lima',
      status: 'published',
      session: { number: 2, deliveryMode: 'asynchronous', unitIds: [ids.unitA2] },
    });
    assert.deepEqual([converted.session.number, converted.session.deliveryMode], [2, 'asynchronous']);
  });
});
