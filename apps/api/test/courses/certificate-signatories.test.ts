/**
 * Certificate signatories (AP-043) against temporary PostgreSQL databases (skipped unless TEST_DATABASE_URL
 * is set). Synthetic users and fictional signatory names. Tests run in order.
 *
 * Course A (published) has one reading; its policy requires completion only. Students n0, n1, n2 and n3
 * complete it and receive certificates with 0, 1, 2 and 3 signatories; n4 never completes it. Course B
 * belongs to another instructor. A second database checks migration 0034 against pre-existing records.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { userCredentials, users } from '../../src/db/schema/index.js';
import { createTestDatabase, migrationsBefore, migrationsFolder, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const EMAILS = {
  admin: DEV_USERS[0]!.email,
  instructor: DEV_USERS[1]!.email,
  n0: DEV_USERS[2]!.email,
  reviewer: DEV_USERS[3]!.email,
  assistant: 'assistant.sig@academiapath.example',
  n1: 'sig.student1@academiapath.example',
  n2: 'sig.student2@academiapath.example',
  n3: 'sig.student3@academiapath.example',
  n4: 'sig.student4@academiapath.example',
  pm: 'sig.manager@academiapath.example',
  instructorB: 'sig.instructor2@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Session = { token: string; csrf: string; userId: string };
type Method = 'GET' | 'POST' | 'PUT';
type Signatory = { name: string; title: string };
type Policy = { configured: boolean; version: number; issuerName: string; signatories: Signatory[]; requireCompletion: boolean; requireFinalGrade: boolean };
type Certificate = { id: string; certificateNumber: string; status: string; issuerName: string; policyVersion: number; signatories: Signatory[]; verificationPath: string };

const DIRECTOR = { name: 'María Fernanda Quispe Huamán', title: 'Directora de Programas Académicos' };
const COORDINATOR = { name: 'Jorge Luis Paredes Salazar', title: 'Coordinador del Programa de Maestría' };
const DEAN = { name: 'Rosa Elena Mamani Condori', title: 'Decana de la Facultad de Ingeniería' };

describe('certificate signatories (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  const as = {} as Record<Person, Session>;
  const ids = {} as Record<'courseA' | 'courseB' | 'lesson', string>;
  const certs = {} as Record<'n0' | 'n1' | 'n2' | 'n3', Certificate>;

  const request = (who: Person | null, method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const session = who ? as[who] : null;
    return app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: session ? { ap_session: session.token } : {},
      headers: { origin: ORIGIN, ...(session && method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}), ...headers },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
  };
  const ok = async <T = any>(who: Person, method: Method, url: string, body?: unknown, status = 200): Promise<T> => {
    const res = await request(who, method, url, body);
    assert.equal(res.statusCode, status, `${method} ${url} as ${who}: ${res.body}`);
    return (res.body ? res.json() : null) as T;
  };
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };
  const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[];
  const A = () => `/courses/${ids.courseA}`;
  const current = () => ok<Policy>('admin', 'GET', `${A()}/certificate-policy`);
  /** Saves course A's policy (completion only) with the given changes; `signatories` is sent only when given. */
  const save = async (who: Person, changes: Record<string, unknown> = {}) =>
    request(who, 'PUT', `${A()}/certificate-policy`, {
      expectedVersion: (await current()).version,
      enabled: true,
      requireCompletion: true,
      requireFinalGrade: false,
      minimumGradePercent: null,
      issuerName: 'Universidad Sintética del Perú',
      ...changes,
    });
  const saved = async (who: Person, changes: Record<string, unknown>) => {
    const res = await save(who, changes);
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as Policy;
  };
  const issue = async (student: Person) => ok<Certificate>('instructor', 'POST', `${A()}/certificates`, { userId: as[student].userId }, 201);
  const verify = (certificate: Certificate) => request(null, 'GET', `/certificates/verify/${certificate.verificationPath.slice('/verify/'.length)}`);
  const pdfText = async (who: Person, certificate: Certificate) => {
    const res = await request(who, 'GET', `/certificates/${certificate.id}/pdf`);
    assert.equal(res.statusCode, 200, res.body);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdfjs.getDocument({ data: new Uint8Array(res.rawPayload), verbosity: 0 }).promise;
    return (await (await document.getPage(1)).getTextContent()).items.map((item) => ('str' in item ? item.str : '')).join(' ');
  };

  before(async () => {
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const passwordHash = await hashPassword(PASSWORD);
    for (const person of ['assistant', 'n1', 'n2', 'n3', 'n4', 'pm', 'instructorB'] as const) {
      const [user] = await database.db.insert(users).values({ email: EMAILS[person], givenName: `Lucía ${person}`, familyName: 'Ñahui' }).returning();
      await database.db.insert(userCredentials).values({ userId: user!.id, passwordHash });
    }
    app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000' }), database: database.db });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAILS[person], password: PASSWORD }, headers: { origin: ORIGIN } });
      assert.equal(res.statusCode, 200, res.body);
      as[person] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
    }
    const program = await ok('admin', 'POST', '/programs', { code: 'SIG', name: 'Programa de Firmantes' }, 201);
    const term = await ok('admin', 'POST', '/terms', { code: '2026-2', name: 'Semestre 2026-2', startsOn: '2026-08-17', endsOn: '2026-12-11' }, 201);
    const template = await ok('admin', 'POST', '/course-templates', { code: 'SIG-T', programId: program.id, title: 'Firmantes', sections: [{ title: 'Unidad 1' }] }, 201);
    const course = async (code: string) => (await ok('admin', 'POST', '/courses', { programId: program.id, termId: term.id, templateId: template.templateId, code, status: 'published' }, 201)).id as string;
    ids.courseA = await course('SIG-A');
    ids.courseB = await course('SIG-B');
    const enroll = (courseId: string, person: Person, role: string) => ok('admin', 'POST', `/courses/${courseId}/enrollments`, { email: EMAILS[person], role }, 201);
    for (const [person, role] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['assistant', 'non_editing_instructor'], ['n0', 'student'], ['n1', 'student'], ['n2', 'student'], ['n3', 'student'], ['n4', 'student']] as const) {
      await enroll(ids.courseA, person, role);
    }
    await enroll(ids.courseB, 'instructorB', 'instructor');
    await ok('admin', 'POST', `/programs/${program.id}/managers`, { email: EMAILS.pm }, 201);
    const section = (await ok('admin', 'GET', `${A()}/sections`)).items[0].id;
    ids.lesson = (await ok('instructor', 'POST', `${A()}/sections/${section}/activities`, { type: 'page', title: 'Lectura 1', body: 'Contenido sintético.' }, 201)).id;
    await ok('instructor', 'POST', `${A()}/activities/${ids.lesson}/submit`);
    await ok('reviewer', 'POST', `${A()}/activities/${ids.lesson}/review`, { decision: 'approve' });
    for (const student of ['n0', 'n1', 'n2', 'n3'] as const) await ok(student, 'PUT', `${A()}/activities/${ids.lesson}/completion`);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  it('1, 13, 14. without signatories: optional everywhere, the existing workflow and PDF are unchanged', async () => {
    const empty = await current();
    assert.deepEqual([empty.configured, empty.signatories], [false, []], 'unconfigured policies have no signatories');
    // A client from before AP-043 does not send `signatories` at all.
    const first = await saved('instructor', {});
    assert.deepEqual([first.configured, first.version, first.signatories], [true, 1, []]);
    const eligibility = await ok<{ items: Array<{ student: { id: string }; eligibility: { eligible: boolean } }> }>('instructor', 'GET', `${A()}/certificates/eligibility`);
    const eligible = eligibility.items.filter((item) => item.eligibility.eligible).map((item) => item.student.id).sort();
    assert.deepEqual(eligible, [as.n0.userId, as.n1.userId, as.n2.userId, as.n3.userId].sort(), 'eligibility follows the completion rule only');
    problem(await request('instructor', 'POST', `${A()}/certificates`, { userId: as.n4.userId }), 422, 'CERTIFICATE_NOT_ELIGIBLE');
    certs.n0 = await issue('n0');
    assert.deepEqual([certs.n0.issuerName, certs.n0.signatories], ['Universidad Sintética del Perú', []]);
    const snapshot = (await query<{ policy_snapshot: Record<string, unknown> }>('SELECT policy_snapshot FROM course_certificates WHERE id = $1', [certs.n0.id]))[0]!.policy_snapshot;
    assert.deepEqual(snapshot.signatories, [], 'the snapshot records that there were none');
    const text = await pdfText('n0', certs.n0);
    for (const expected of ['CERTIFICADO DE FINALIZACIÓN', 'Universidad Sintética del Perú', certs.n0.certificateNumber, certs.n0.verificationPath]) assert.ok(text.includes(expected), `PDF contains ${expected}`);
  });

  it('2, 3, 4, 7. one, two and three signatories are saved in the order given; leaving the field out keeps them', async () => {
    assert.deepEqual((await saved('instructor', { signatories: [DIRECTOR] })).signatories, [DIRECTOR]);
    assert.deepEqual((await saved('instructor', { signatories: [COORDINATOR, DIRECTOR] })).signatories, [COORDINATOR, DIRECTOR]);
    const three = await saved('admin', { signatories: [DEAN, DIRECTOR, COORDINATOR] });
    assert.deepEqual(three.signatories, [DEAN, DIRECTOR, COORDINATOR], 'administrators may configure; order is kept');
    const kept = await saved('instructor', { issuerName: 'Universidad Sintética del Perú' });
    assert.deepEqual(kept.signatories, [DEAN, DIRECTOR, COORDINATOR], 'a save without `signatories` keeps them');
    const tidy = await saved('instructor', { signatories: [{ name: '  María   Fernanda Quispe Huamán ', title: 'Directora de\tProgramas Académicos ' }] });
    assert.deepEqual(tidy.signatories, [DIRECTOR], 'spacing is tidied before saving');
    assert.deepEqual((await saved('instructor', { signatories: [] })).signatories, [], 'an empty list removes them');
    const audit = await query<{ metadata: { before: { signatories: Signatory[] }; after: { signatories: Signatory[] } } }>(
      "SELECT metadata FROM audit_log WHERE action = 'certificate_policy.updated' AND entity_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
      [ids.courseA],
    );
    assert.deepEqual([audit[0]!.metadata.before.signatories, audit[0]!.metadata.after.signatories], [[DIRECTOR], []], 'changes are audited');
  });

  it('5, 6. too many, incomplete, malformed, unprintable and repeated signatories are rejected and nothing is saved', async () => {
    await saved('instructor', { signatories: [DIRECTOR] });
    const before = await current();
    const invalid: Array<[unknown, number, string]> = [
      [[DIRECTOR, COORDINATOR, DEAN, { name: 'Pedro Ruiz Gallo', title: 'Rector' }], 400, 'VALIDATION_ERROR'],
      [[{ name: 'Pedro Ruiz Gallo' }], 400, 'VALIDATION_ERROR'],
      [[{ title: 'Rector' }], 400, 'VALIDATION_ERROR'],
      [[{ name: '', title: 'Rector' }], 400, 'VALIDATION_ERROR'],
      [[{ name: '   ', title: 'Rector' }], 400, 'VALIDATION_ERROR'],
      [[{ name: 'Pedro Ruiz Gallo', title: ' ' }], 400, 'VALIDATION_ERROR'],
      [[{ name: 'P'.repeat(81), title: 'Rector' }], 400, 'VALIDATION_ERROR'],
      [[{ name: 'Pedro Ruiz Gallo', title: 'R'.repeat(101) }], 400, 'VALIDATION_ERROR'],
      [[{ name: 'Pedro Ruiz Gallo', title: 'Rector', userId: as.instructor.userId }], 400, 'VALIDATION_ERROR'],
      [[{ name: { given: 'Pedro' }, title: 'Rector' }], 400, 'VALIDATION_ERROR'],
      [[null], 400, 'VALIDATION_ERROR'],
      [['Pedro Ruiz Gallo'], 400, 'VALIDATION_ERROR'],
      [{ name: 'Pedro Ruiz Gallo', title: 'Rector' }, 400, 'VALIDATION_ERROR'],
      [null, 400, 'VALIDATION_ERROR'],
      [[{ name: 'José Pérez Aliaga', title: 'Rector' }, { name: 'jose  PEREZ aliaga', title: 'Decano' }], 422, 'CERTIFICATE_SIGNATORIES_INVALID'],
      [[DIRECTOR, { ...DIRECTOR, title: 'Vicerrectora' }], 422, 'CERTIFICATE_SIGNATORIES_INVALID'],
      [[{ name: 'Li Wei 李伟', title: 'Rector' }], 422, 'CERTIFICATE_SIGNATORIES_INVALID'],
      [[{ name: 'Pedro Ruiz Gallo', title: 'Rector 🎓' }], 422, 'CERTIFICATE_SIGNATORIES_INVALID'],
      [[{ name: 'Pedro\u0000Ruiz', title: 'Rector' }], 422, 'CERTIFICATE_SIGNATORIES_INVALID'],
      [[{ name: '<script>alert(1)</script>‮', title: 'Rector' }], 422, 'CERTIFICATE_SIGNATORIES_INVALID'],
    ];
    for (const [signatories, status, code] of invalid) {
      const res = await save('instructor', { signatories });
      problem(res, status, code);
      assert.doesNotMatch(res.body, /course_certificate_policies|jsonb|postgres|stack/i, 'no database internals');
    }
    const after = await current();
    assert.deepEqual([after.version, after.signatories], [before.version, [DIRECTOR]], 'nothing was saved');
    // The database keeps the limit even for writes that bypass the API.
    const four = JSON.stringify([DIRECTOR, COORDINATOR, DEAN, { name: 'Pedro Ruiz Gallo', title: 'Rector' }]);
    await assert.rejects(query('UPDATE course_certificate_policies SET signatories = $1::jsonb WHERE course_id = $2', [four, ids.courseA]), /signatories_check/);
    await assert.rejects(query(`UPDATE course_certificate_policies SET signatories = '{"name":"x"}'::jsonb WHERE course_id = $1`, [ids.courseA]), /signatories_check/);
  });

  it('15, 16. only instructors of the course and administrators change signatories; everyone else is refused', async () => {
    const before = await current();
    const attempt = { signatories: [{ name: 'Persona No Autorizada', title: 'Cargo inventado' }] };
    problem(await save('assistant', attempt), 403, 'FORBIDDEN');
    problem(await save('reviewer', attempt), 403, 'FORBIDDEN');
    problem(await save('n1', attempt), 403, 'FORBIDDEN');
    problem(await save('pm', attempt), 404, 'NOT_FOUND');
    problem(await save('instructorB', attempt), 404, 'NOT_FOUND');
    const body = { expectedVersion: before.version, enabled: true, requireCompletion: true, requireFinalGrade: false, minimumGradePercent: null, issuerName: 'X', ...attempt };
    problem(await request(null, 'PUT', `${A()}/certificate-policy`, body), 401, 'UNAUTHENTICATED');
    problem(await request('instructor', 'PUT', `${A()}/certificate-policy`, body, { origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
    const noCsrf = await app.inject({ method: 'PUT', url: `/api/v1${A()}/certificate-policy`, cookies: { ap_session: as.instructor.token }, headers: { origin: ORIGIN }, payload: body });
    problem(noCsrf, 403, 'CSRF_TOKEN_INVALID');
    const after = await current();
    assert.deepEqual([after.version, after.signatories], [before.version, before.signatories], 'no refused request changed the policy');
    assert.deepEqual((await ok<Policy>('assistant', 'GET', `${A()}/certificate-policy`)).signatories, before.signatories, 'non-editing instructors read the signatories');
    problem(await request('n1', 'GET', `${A()}/certificate-policy`), 403, 'FORBIDDEN');
  });

  it('8, 10. new certificates snapshot the signatories configured when they are issued and print them in order', async () => {
    await saved('instructor', { signatories: [DIRECTOR] });
    certs.n1 = await issue('n1');
    await saved('instructor', { signatories: [DIRECTOR, COORDINATOR] });
    certs.n2 = await issue('n2');
    await saved('admin', { signatories: [DEAN, DIRECTOR, COORDINATOR] });
    certs.n3 = await issue('n3');
    assert.deepEqual(certs.n1.signatories, [DIRECTOR]);
    assert.deepEqual(certs.n2.signatories, [DIRECTOR, COORDINATOR]);
    assert.deepEqual(certs.n3.signatories, [DEAN, DIRECTOR, COORDINATOR]);
    const stored = (await query<{ policy_snapshot: { signatories: Signatory[]; version: number } }>('SELECT policy_snapshot FROM course_certificates WHERE id = $1', [certs.n3.id]))[0]!.policy_snapshot;
    assert.deepEqual(stored.signatories, [DEAN, DIRECTOR, COORDINATOR], 'stored in the immutable snapshot');
    assert.equal(stored.version, certs.n3.policyVersion);
    const text = await pdfText('n3', certs.n3);
    for (const signer of [DEAN, DIRECTOR, COORDINATOR]) assert.ok(text.includes(signer.name) && text.includes(signer.title), `PDF prints ${signer.name}`);
    assert.ok(text.indexOf(DEAN.name) < text.indexOf(DIRECTOR.name) && text.indexOf(DIRECTOR.name) < text.indexOf(COORDINATOR.name), 'in policy order');
    assert.doesNotMatch(text, /@|electronic signature|firma electr|digitally signed/i, 'no e-mail addresses and no electronic signature claim');
    const one = await pdfText('n1', certs.n1);
    assert.ok(one.includes(DIRECTOR.name) && !one.includes(COORDINATOR.name));
  });

  it('11, 12. later policy changes never alter issued certificates; the snapshot cannot be edited', async () => {
    await saved('instructor', { signatories: [{ name: 'Carlos Alberto Rojas Medina', title: 'Rector' }], issuerName: 'Nueva Institución' });
    await saved('instructor', { signatories: [] });
    const detail = await ok<Certificate>('n3', 'GET', `/certificates/${certs.n3.id}`);
    assert.deepEqual([detail.signatories, detail.issuerName], [[DEAN, DIRECTOR, COORDINATOR], 'Universidad Sintética del Perú']);
    const list = await ok<{ items: Certificate[] }>('instructor', 'GET', `${A()}/certificates`);
    assert.deepEqual(Object.fromEntries(list.items.map((c) => [c.id, c.signatories.length])), { [certs.n0.id]: 0, [certs.n1.id]: 1, [certs.n2.id]: 2, [certs.n3.id]: 3 });
    const text = await pdfText('instructor', certs.n2);
    assert.ok(text.includes(COORDINATOR.name) && !text.includes('Carlos Alberto Rojas Medina') && !text.includes('Nueva Institución'));
    const tampered = JSON.stringify({ version: 1, requireCompletion: true, requireFinalGrade: false, minimumGradePercent: null, issuerName: 'X', signatories: [] });
    await assert.rejects(query('UPDATE course_certificates SET policy_snapshot = $1::jsonb WHERE id = $2', [tampered, certs.n3.id]), /only be revoked/);
    await assert.rejects(query("UPDATE course_certificates SET policy_snapshot = jsonb_set(policy_snapshot, '{signatories,0,name}', '\"Otra Persona\"') WHERE id = $1", [certs.n3.id]), /only be revoked/);
    assert.deepEqual((await ok<Certificate>('admin', 'GET', `/certificates/${certs.n3.id}`)).signatories, [DEAN, DIRECTOR, COORDINATOR]);
  });

  it('12, 19. public verification shows only the names and titles saved at issue time, and keeps its checks', async () => {
    const res = await verify(certs.n3);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['academicPeriod', 'certificateNumber', 'courseTitle', 'issuedAt', 'issuerName', 'recipientName', 'revokedAt', 'signatories', 'status']);
    assert.deepEqual([body.status, body.signatories], ['valid', [DEAN, DIRECTOR, COORDINATOR]]);
    assert.deepEqual(body.signatories.map((s: Signatory) => Object.keys(s).sort()), [['name', 'title'], ['name', 'title'], ['name', 'title']], 'nothing but the printed name and title');
    assert.doesNotMatch(res.body, /@|userId|course_id|policy_snapshot|Rojas Medina/);
    const none = (await verify(certs.n0)).json();
    assert.deepEqual([none.status, none.signatories], ['valid', []], 'certificates without signatories still verify');
    await ok('instructor', 'POST', `${A()}/certificates/${certs.n1.id}/revoke`, { reason: 'Emitido por error (prueba sintética).' });
    const revoked = (await verify(certs.n1)).json();
    assert.deepEqual([revoked.status, revoked.signatories], ['revoked', [DIRECTOR]], 'a revoked certificate keeps its snapshot and verifies as revoked');
    problem(await request('n1', 'GET', `/certificates/${certs.n1.id}/pdf`), 409, 'CERTIFICATE_REVOKED');
    problem(await request(null, 'GET', `/certificates/verify/${randomBytes(32).toString('base64url')}`), 404, 'CERTIFICATE_NOT_FOUND');
  });

  it('16. students read their own certificate with its signatories, never anyone else’s', async () => {
    assert.deepEqual((await ok<Certificate>('n2', 'GET', `/certificates/${certs.n2.id}`)).signatories, [DIRECTOR, COORDINATOR]);
    problem(await request('n2', 'GET', `/certificates/${certs.n3.id}`), 404, 'CERTIFICATE_NOT_FOUND');
    problem(await request('instructorB', 'GET', `/certificates/${certs.n3.id}`), 404, 'CERTIFICATE_NOT_FOUND');
    const mine = await ok<{ certificates: Certificate[] }>('n3', 'GET', `${A()}/certificates/mine`);
    assert.deepEqual(mine.certificates.map((c) => c.signatories), [[DEAN, DIRECTOR, COORDINATOR]]);
  });
});

describe('certificate signatory migration on existing records (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let previous: Awaited<ReturnType<typeof migrationsBefore>> | undefined;
  const raw = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[];

  before(async () => {
    // A copy of the migrations up to 0033 (the state before AP-043).
    previous = await migrationsBefore('0034_certificate_signatories');
    database = await createTestDatabase({ migrationsFolder: previous.folder });
  });

  after(async () => {
    await database?.drop();
    await previous?.cleanup();
  });

  it('20. migration 0034 adds signatories without changing existing policies or certificates', async () => {
    assert.deepEqual(await raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'course_certificate_policies' AND column_name = 'signatories'"), [], 'starts before AP-043');
    const [staff, student] = await raw<{ id: string }>(
      "INSERT INTO users (email, given_name, family_name) VALUES ('legacy.staff@academiapath.example', 'Elena', 'Ríos'), ('legacy.student@academiapath.example', 'Ana', 'Ñúñez') RETURNING id",
    );
    const [term] = await raw<{ id: string }>("INSERT INTO terms (code, name, starts_on, ends_on, academic_year) VALUES ('2026-1', 'Semestre 2026-1', '2026-03-16', '2026-07-10', 2026) RETURNING id");
    const [course] = await raw<{ id: string }>("INSERT INTO courses (term_id, code, title, status) VALUES ($1, 'LEG-1', 'Curso Histórico', 'published') RETURNING id", [term!.id]);
    const [enrollment] = await raw<{ id: string }>("INSERT INTO enrollments (course_id, user_id, role) VALUES ($1, $2, 'student') RETURNING id", [course!.id, student!.id]);
    await raw(
      "INSERT INTO course_certificate_policies (course_id, enabled, require_completion, require_final_grade, issuer_name, version, updated_by_user_id) VALUES ($1, true, true, false, 'Universidad Histórica', 4, $2)",
      [course!.id, staff!.id],
    );
    const legacySnapshot = { version: 4, requireCompletion: true, requireFinalGrade: false, minimumGradePercent: null, issuerName: 'Universidad Histórica' };
    const [certificate] = await raw<{ id: string; verification_token: string }>(
      `INSERT INTO course_certificates (verification_token, certificate_number, course_id, user_id, enrollment_id, recipient_name, course_title, course_code, term_name, academic_year, issuer_name, policy_version, policy_snapshot, issued_by_user_id)
       VALUES ($1, 'AP-LEGA-CY00-0001', $2, $3, $4, 'Ana Ñúñez', 'Curso Histórico', 'LEG-1', 'Semestre 2026-1', 2026, 'Universidad Histórica', 4, $5::jsonb, $6) RETURNING id, verification_token`,
      [randomBytes(32).toString('base64url'), course!.id, student!.id, enrollment!.id, JSON.stringify(legacySnapshot), staff!.id],
    );
    const certificateBefore = (await raw('SELECT * FROM course_certificates WHERE id = $1', [certificate!.id]))[0];
    const policyBefore = (await raw('SELECT * FROM course_certificate_policies WHERE course_id = $1', [course!.id]))[0]!;
    const guards = () => raw("SELECT p.proname, pg_get_functiondef(p.oid) AS body FROM pg_proc p WHERE p.proname LIKE 'course_certificates_%' ORDER BY p.proname");
    const guardsBefore = await guards();

    await migrate(database.db, { migrationsFolder });

    const certificateAfter = (await raw('SELECT * FROM course_certificates WHERE id = $1', [certificate!.id]))[0];
    assert.deepEqual(certificateAfter, certificateBefore, 'the issued certificate is untouched (no backfill)');
    const policyAfter = (await raw('SELECT * FROM course_certificate_policies WHERE course_id = $1', [course!.id]))[0]!;
    assert.deepEqual(policyAfter, { ...policyBefore, signatories: [] }, 'existing policies get an empty list and nothing else changes');
    assert.ok(guardsBefore.length >= 2);
    assert.deepEqual(await guards(), guardsBefore, 'the certificate guard triggers are unchanged');
    await assert.rejects(raw('UPDATE course_certificates SET policy_snapshot = policy_snapshot || $1::jsonb WHERE id = $2', [JSON.stringify({ signatories: [] }), certificate!.id]), /only be revoked/);

    // The application reads the pre-AP-043 certificate as having no signatories, and it still verifies.
    const app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN }), database: database.db });
    try {
      await app.ready();
      const res = await app.inject({ method: 'GET', url: `/api/v1/certificates/verify/${certificate!.verification_token}` });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual([res.json().status, res.json().issuerName, res.json().signatories], ['valid', 'Universidad Histórica', []]);
    } finally {
      await app.close();
    }
  });
});
