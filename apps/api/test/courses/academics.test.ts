/**
 * Academic hierarchy management (AP-012): academic year → term → program → subject, against a
 * temporary PostgreSQL database. Skipped unless TEST_DATABASE_URL is set. Synthetic data only.
 * Tests run in order and build on each other.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { auditLog } from '../../src/db/schema/index.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const COOKIE = 'ap_session';
const WEB_ORIGIN = 'http://localhost:3000';
const EMAILS = { admin: DEV_USERS[0]!.email, instructor: DEV_USERS[1]!.email, student: DEV_USERS[2]!.email, reviewer: DEV_USERS[3]!.email } as const;
type Person = keyof typeof EMAILS;
type Session = { token: string; csrfToken: string; userId: string };

function expectProblem(res: LightMyRequestResponse, status: number, code: string) {
  assert.equal(res.statusCode, status, res.body);
  assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
  const problem = res.json();
  assert.equal(problem.title, STATUS_CODES[status]);
  assert.equal(problem.code, code);
}

function expectStatus(res: LightMyRequestResponse, status: number) {
  assert.equal(res.statusCode, status, res.body);
  return res.json();
}

describe('academic hierarchy management (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  const sessions = new Map<Person, Session>();
  const ids: Record<string, string> = {};
  const id = (key: string) => {
    const value = ids[key];
    assert.ok(value, `missing id ${key}`);
    return value;
  };
  const call = (who: Person | null, method: 'GET' | 'POST' | 'PUT', url: string, options: { payload?: object; csrf?: string | null } = {}) => {
    const current = who ? sessions.get(who) : null;
    const csrf = options.csrf === undefined ? current?.csrfToken : options.csrf;
    return app.inject({
      method,
      url: `/api/v1${url}`,
      ...(options.payload ? { payload: options.payload } : {}),
      cookies: current ? { [COOKIE]: current.token } : {},
      headers: method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {},
    });
  };
  const audits = async (action: string, entityId: string) =>
    database.db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));

  before(async () => {
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: WEB_ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000' }), database: database.db });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAILS[person], password: PASSWORD }, headers: { origin: WEB_ORIGIN } });
      const body = expectStatus(res, 200);
      const token = res.cookies.find((cookie) => cookie.name === COOKIE)?.value;
      assert.ok(token);
      sessions.set(person, { token, csrfToken: body.csrfToken, userId: body.user.id });
    }
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  it('stores the academic year on terms (Peru-style codes) and rejects mismatches and duplicates', async () => {
    const first = expectStatus(await call('admin', 'POST', '/terms', { payload: { code: '2026-1', name: 'Semestre 2026-1', startsOn: '2026-03-16', endsOn: '2026-07-17' } }), 201);
    assert.equal(first.academicYear, 2026, 'year taken from the code');
    const second = expectStatus(await call('admin', 'POST', '/terms', { payload: { code: '2026-2', name: 'Semestre 2026-2', academicYear: 2026, startsOn: '2026-08-17', endsOn: '2026-12-11' } }), 201);
    const legacy = expectStatus(await call('admin', 'POST', '/terms', { payload: { code: 'VERANO-A', name: 'Verano', startsOn: '2027-01-11', endsOn: '2027-02-26' } }), 201);
    assert.equal(legacy.academicYear, 2027, 'year taken from the start date when the code has no year');
    expectProblem(await call('admin', 'POST', '/terms', { payload: { code: '2027-1', name: 'X', academicYear: 2026, startsOn: '2027-03-15', endsOn: '2027-07-16' } }), 422, 'TERM_YEAR_MISMATCH');
    expectProblem(await call('admin', 'POST', '/terms', { payload: { code: '2026-2', name: 'Duplicado', startsOn: '2026-08-17', endsOn: '2026-12-11' } }), 409, 'TERM_CODE_TAKEN');
    ids.term1 = first.id;
    ids.term2 = second.id;
    const list = expectStatus(await call('admin', 'GET', '/terms?limit=100'), 200);
    assert.deepEqual(
      list.items.map((t: { code: string; academicYear: number }) => [t.code, t.academicYear]),
      [['2026-1', 2026], ['2026-2', 2026], ['VERANO-A', 2027]],
    );
    const isCheck = (error: unknown) => (error as { code?: string }).code === '23514';
    await assert.rejects(database.pool.query(`INSERT INTO terms (code, name, academic_year, starts_on, ends_on) VALUES ('X-1999', 'x', 1999, '1999-01-01', '1999-02-01')`), isCheck);
  });

  it('edits terms: name and dates persist; code and academic year are the stable identity', async () => {
    const updated = expectStatus(
      await call('admin', 'PUT', `/terms/${id('term2')}`, { payload: { name: 'Semestre académico 2026-2', startsOn: '2026-08-24', endsOn: '2026-12-18' } }),
      200,
    );
    assert.deepEqual([updated.code, updated.academicYear, updated.name, updated.startsOn, updated.endsOn], ['2026-2', 2026, 'Semestre académico 2026-2', '2026-08-24', '2026-12-18']);
    expectProblem(await call('admin', 'PUT', `/terms/${id('term2')}`, { payload: { name: 'X', startsOn: '2026-12-01', endsOn: '2026-08-01' } }), 422, 'INVALID_TERM_DATES');
    expectProblem(await call('admin', 'PUT', `/terms/${id('term2')}`, { payload: { name: 'X', code: '2030-1', startsOn: '2026-08-24', endsOn: '2026-12-18' } }), 400, 'VALIDATION_ERROR');
    expectProblem(await call('admin', 'PUT', `/terms/${id('term2')}`, { payload: { name: '   ', startsOn: '2026-08-24', endsOn: '2026-12-18' } }), 400, 'VALIDATION_ERROR');
    expectProblem(await call('admin', 'PUT', '/terms/00000000-0000-4000-8000-000000000000', { payload: { name: 'X', startsOn: '2026-08-24', endsOn: '2026-12-18' } }), 404, 'NOT_FOUND');
    const [entry] = await audits('term.updated', id('term2'));
    assert.deepEqual((entry?.metadata.before as { name: string }).name, 'Semestre 2026-2');
  });

  it('creates and edits reusable programs (code immutable, duplicates rejected, audited)', async () => {
    const program = expectStatus(await call('admin', 'POST', '/programs', { payload: { code: 'IT-MGMT', name: 'IT Management' } }), 201);
    ids.program = program.id;
    expectProblem(await call('admin', 'POST', '/programs', { payload: { code: 'IT-MGMT', name: 'Otro' } }), 409, 'PROGRAM_CODE_TAKEN');
    const updated = expectStatus(
      await call('admin', 'PUT', `/programs/${program.id}`, { payload: { name: 'Gestión de TI', description: 'Programa profesional', isActive: true } }),
      200,
    );
    assert.deepEqual([updated.code, updated.name, updated.description, updated.isActive], ['IT-MGMT', 'Gestión de TI', 'Programa profesional', true]);
    const cleared = expectStatus(await call('admin', 'PUT', `/programs/${program.id}`, { payload: { name: 'IT Management', description: '  ', isActive: true } }), 200);
    assert.equal(cleared.description, null);
    expectProblem(await call('admin', 'PUT', `/programs/${program.id}`, { payload: { name: 'X', code: 'NEW', isActive: true } }), 400, 'VALIDATION_ERROR');
    assert.equal((await audits('program.updated', program.id)).length, 2);
  });

  it('manages subjects as reusable versioned templates; new subjects cannot overwrite existing ones', async () => {
    const subject = expectStatus(
      await call('admin', 'POST', '/course-templates', {
        payload: { code: 'ITIL-F', programId: id('program'), title: 'ITIL Foundation', baseVersion: 0, sections: [{ title: 'Introducción' }, { title: 'Prácticas' }] },
      }),
      201,
    );
    ids.subject = subject.templateId;
    expectProblem(
      await call('admin', 'POST', '/course-templates', { payload: { code: 'ITIL-F', programId: id('program'), title: 'Duplicate', baseVersion: 0, sections: [] } }),
      409,
      'TEMPLATE_CODE_TAKEN',
    );
    const detail = expectStatus(await call('admin', 'GET', `/course-templates/${id('subject')}`), 200);
    assert.deepEqual([detail.code, detail.programId, detail.versionCount, detail.latestVersion.version], ['ITIL-F', id('program'), 1, 1]);
    assert.deepEqual(detail.latestVersion.sections.map((s: { title: string }) => s.title), ['Introducción', 'Prácticas']);

    // An offering in 2026-2 keeps version 1 after the subject is edited.
    const offering = expectStatus(
      await call('admin', 'POST', '/courses', { payload: { programId: id('program'), termId: id('term2'), templateId: id('subject'), code: 'ITIL-F-2026-2', status: 'published' } }),
      201,
    );
    ids.offering = offering.id;
    const edits = await Promise.all(
      ['ITIL 4 Foundation', 'ITIL 4 Foundation (rev)'].map((title) =>
        call('admin', 'POST', '/course-templates', {
          payload: { code: 'ITIL-F', programId: id('program'), title, baseVersion: 1, sections: [{ title: 'Introducción' }, { title: 'Prácticas' }, { title: 'Examen de práctica' }] },
        }),
      ),
    );
    const statuses = edits.map((res) => res.statusCode).sort();
    assert.deepEqual(statuses, [201, 409], 'concurrent edits from the same version: one wins, one conflicts');
    expectProblem(edits.find((res) => res.statusCode === 409)!, 409, 'TEMPLATE_VERSION_CONFLICT');
    const v2 = expectStatus(await call('admin', 'GET', `/course-templates/${id('subject')}`), 200);
    assert.deepEqual([v2.versionCount, v2.latestVersion.version, v2.latestVersion.sections.length], [2, 2, 3]);
    const course = expectStatus(await call('admin', 'GET', `/courses/${id('offering')}`), 200);
    assert.equal(course.templateVersionId, detail.latestVersion.id, 'existing offering stays on version 1');
    expectProblem(await call('admin', 'GET', '/course-templates/00000000-0000-4000-8000-000000000000'), 404, 'NOT_FOUND');
  });

  it('filters course offerings by term, program and subject', async () => {
    const other = expectStatus(
      await call('admin', 'POST', '/courses', { payload: { programId: id('program'), termId: id('term1'), templateId: id('subject'), code: 'ITIL-F-2026-1', status: 'draft' } }),
      201,
    );
    expectProblem(
      await call('admin', 'POST', '/courses', { payload: { programId: id('program'), termId: id('term2'), templateId: id('subject'), code: 'ITIL-F-2026-2' } }),
      409,
      'COURSE_CODE_TAKEN',
    );
    const codes = async (query: string) =>
      expectStatus(await call('admin', 'GET', `/courses?limit=100&${query}`), 200).items.map((c: { code: string }) => c.code);
    assert.deepEqual(await codes(`termId=${id('term2')}`), ['ITIL-F-2026-2']);
    assert.deepEqual(await codes(`termId=${id('term1')}&templateId=${id('subject')}`), [other.code]);
    assert.deepEqual(await codes(`programId=${id('program')}`), ['ITIL-F-2026-1', 'ITIL-F-2026-2']);
    expectProblem(await call('admin', 'GET', '/courses?termId=not-a-uuid'), 400, 'VALIDATION_ERROR');
    // Filters only narrow what a caller may already see.
    expectStatus(await call('admin', 'POST', `/courses/${id('offering')}/enrollments`, { payload: { email: EMAILS.student, role: 'student' } }), 201);
    const studentView = expectStatus(await call('student', 'GET', `/courses?programId=${id('program')}`), 200);
    assert.deepEqual(studentView.items.map((c: { code: string }) => c.code), ['ITIL-F-2026-2']);
  });

  it('restricts every academic write to administrators (design team included) and keeps CSRF', async () => {
    for (const who of ['instructor', 'reviewer', 'student'] as const) {
      expectProblem(await call(who, 'PUT', `/programs/${id('program')}`, { payload: { name: 'Hack', isActive: false } }), 403, 'FORBIDDEN');
      expectProblem(await call(who, 'PUT', `/terms/${id('term2')}`, { payload: { name: 'Hack', startsOn: '2026-08-24', endsOn: '2026-12-18' } }), 403, 'FORBIDDEN');
      expectProblem(await call(who, 'GET', `/course-templates/${id('subject')}`), 403, 'FORBIDDEN');
      expectProblem(
        await call(who, 'POST', '/course-templates', { payload: { code: 'ITIL-F', programId: id('program'), title: 'Hack', baseVersion: 2, sections: [] } }),
        403,
        'FORBIDDEN',
      );
    }
    expectProblem(await call(null, 'PUT', `/programs/${id('program')}`, { payload: { name: 'X', isActive: true } }), 401, 'UNAUTHENTICATED');
    expectProblem(await call('admin', 'PUT', `/programs/${id('program')}`, { payload: { name: 'X', isActive: true }, csrf: null }), 403, 'CSRF_TOKEN_INVALID');
    const program = expectStatus(await call('admin', 'GET', '/programs?limit=100'), 200).items.find((p: { id: string }) => p.id === id('program'));
    assert.deepEqual([program.name, program.isActive], ['IT Management', true], 'rejected requests changed nothing');
  });

  it('deactivating a program keeps its subjects and offerings but blocks new offerings', async () => {
    expectStatus(await call('admin', 'PUT', `/programs/${id('program')}`, { payload: { name: 'IT Management', isActive: false } }), 200);
    expectProblem(
      await call('admin', 'POST', '/courses', { payload: { programId: id('program'), termId: id('term2'), templateId: id('subject'), code: 'ITIL-F-B' } }),
      422,
      'PROGRAM_INACTIVE',
    );
    expectStatus(await call('admin', 'GET', `/courses/${id('offering')}`), 200);
    expectStatus(await call('admin', 'GET', `/course-templates/${id('subject')}`), 200);
    expectStatus(await call('admin', 'PUT', `/programs/${id('program')}`, { payload: { name: 'IT Management', isActive: true } }), 200);
  });
});
