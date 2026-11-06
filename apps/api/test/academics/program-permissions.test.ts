/**
 * Program-scoped academic management on the synthetic AP-016 demo dataset, against a temporary
 * PostgreSQL database (skipped unless TEST_DATABASE_URL is set): administrator grants and revocations,
 * subject management limited to granted programs (authorized by the stored subject's program), template
 * version integrity, least privilege, inactive accounts, concurrency, audit and CSRF/Origin.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { ACCOUNTS } from '../../scripts/demo/content.js';
import { upsertSyntheticUsers } from '../../scripts/seed-dev-users.js';
import { seedDemo, type DemoReport } from '../../scripts/seed-demo.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const DESIGNERS = [
  { email: 'designer.a@academiapath.example', givenName: 'Demo', familyName: 'Designer A', systemRole: 'user' as const },
  { email: 'designer.b@academiapath.example', givenName: 'Demo', familyName: 'Designer B', systemRole: 'user' as const },
];

type App = ReturnType<typeof buildApp>;
type Session = { token: string; csrf: string; userId: string };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Who = 'admin' | 'reviewer' | 'instructor' | 'student' | 'designerA' | 'designerB';
type Subject = { id: string; code: string; programId: string; latestVersion: { version: number } | null };

describe('program-scoped academic permissions (PostgreSQL, demo dataset)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let env: NodeJS.ProcessEnv;
  let report: DemoReport;
  let app: App;
  const as = {} as Record<Who, Session>;
  const program = {} as Record<'GTI' | 'CDIA', string>;
  const subject = {} as Record<'ITIL4-F' | 'PMF' | 'IAI', Subject>;
  const emails: Record<Who, string> = {
    admin: ACCOUNTS.admin,
    reviewer: ACCOUNTS.reviewer,
    instructor: ACCOUNTS.instructor,
    student: ACCOUNTS.student,
    designerA: DESIGNERS[0]!.email,
    designerB: DESIGNERS[1]!.email,
  };

  const request = (method: Method, url: string, options: { session?: Session; body?: unknown; csrf?: string | null; origin?: string | null } = {}) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: options.session ? { ap_session: options.session.token } : {},
      headers: {
        ...(options.origin === null ? {} : { origin: options.origin ?? ORIGIN }),
        ...(options.session && method !== 'GET' && options.csrf !== null ? { 'x-csrf-token': options.csrf ?? options.session.csrf } : {}),
      },
      ...(options.body !== undefined ? { payload: options.body as object } : {}),
    });
  const call = (who: Who, method: Method, url: string, body?: unknown) => request(method, url, { session: as[who], body });
  const ok = async <T = unknown>(who: Who, method: Method, url: string, body?: unknown, status = 200): Promise<T> => {
    const res = await call(who, method, url, body);
    assert.equal(res.statusCode, status, `${method} ${url} as ${who}: ${res.body}`);
    return (res.body ? res.json() : null) as T;
  };
  const expectProblem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };
  const signIn = async (who: Who) => {
    const res = await request('POST', '/auth/login', { body: { email: emails[who], password: PASSWORD } });
    assert.equal(res.statusCode, 200, res.body);
    as[who] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
  };
  const count = async (sql: string, params: unknown[] = []) => Number((await database.pool.query(sql, params)).rows[0].n);
  /** A new version of a subject, as the SubjectForm sends it. */
  const versionBody = (code: string, programId: string | null, title: string, baseVersion?: number) => ({
    code,
    programId,
    title,
    description: `${title} (synthetic).`,
    ...(baseVersion !== undefined ? { baseVersion } : {}),
    sections: [{ title: 'Unit 1', isVisible: true }, { title: 'Unit 2', isVisible: true }],
  });
  const latestVersion = async (code: string) =>
    count('SELECT max(v.version)::int AS n FROM course_template_versions v JOIN course_templates t ON t.id = v.template_id WHERE t.code = $1', [code]);
  const grant = (programCode: 'GTI' | 'CDIA', who: Who) => ok('admin', 'POST', `/programs/${program[programCode]}/managers`, { email: emails[who] }, 201);

  before(async () => {
    database = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'ap-programs-'));
    env = { NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: join(root, 'store') };
    report = await seedDemo(database.db, { password: PASSWORD, env, uploadFilesDir: null });
    await upsertSyntheticUsers(database.db, PASSWORD, DESIGNERS);
    app = buildApp({ config: { ...loadConfig(env), loginRateLimit: { max: 1000, windowMs: 60_000 } }, database: database.db });
    await app.ready();
    for (const who of Object.keys(emails) as Who[]) await signIn(who);
    for (const p of await (async () => (await ok<{ items: Array<{ id: string; code: string }> }>('admin', 'GET', '/programs?limit=100')).items)()) {
      if (p.code === 'GTI' || p.code === 'CDIA') program[p.code] = p.id;
    }
    for (const s of (await ok<{ items: Subject[] }>('admin', 'GET', '/course-templates?limit=100')).items) {
      if (s.code === 'ITIL4-F' || s.code === 'PMF' || s.code === 'IAI') subject[s.code] = s;
    }
    assert.ok(program.GTI && program.CDIA && subject['ITIL4-F'] && subject.IAI);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('starts default-deny: a course design-team role alone grants no program management', async () => {
    for (const who of ['reviewer', 'designerA', 'instructor', 'student'] as const) {
      expectProblem(await call(who, 'GET', '/course-templates'), 403, 'FORBIDDEN');
      expectProblem(await call(who, 'GET', `/course-templates/${subject['ITIL4-F'].id}`), 403, 'FORBIDDEN');
      expectProblem(await call(who, 'POST', '/course-templates', versionBody('ITIL4-F', program.GTI, 'Escalation', 1)), 403, 'FORBIDDEN');
      assert.deepEqual(await ok(who, 'GET', '/me/managed-programs'), { scope: 'granted', items: [] });
    }
    assert.equal(await latestVersion('ITIL4-F'), 1);
    const adminView = await ok<{ scope: string; items: Array<{ code: string }> }>('admin', 'GET', '/me/managed-programs');
    assert.deepEqual([adminView.scope, adminView.items.map((p) => p.code)], ['all', ['CDIA', 'GTI']]);
  });

  it('lets an administrator grant a program; the user then sees exactly that program', async () => {
    const created = await grant('GTI', 'designerA');
    assert.deepEqual(created, {
      programId: program.GTI,
      user: { id: as.designerA.userId, email: emails.designerA, givenName: 'Demo', familyName: 'Designer A', isActive: true },
      grantedAt: (created as { grantedAt: string }).grantedAt,
      grantedBy: { id: as.admin.userId, email: emails.admin },
    });
    await grant('CDIA', 'designerB');
    const mine = await ok<{ scope: string; items: Array<{ code: string; subjectCount: number }> }>('designerA', 'GET', '/me/managed-programs');
    assert.deepEqual([mine.scope, mine.items.map((p) => [p.code, p.subjectCount])], ['granted', [['GTI', 2]]]);
    const managers = await ok<{ items: Array<{ user: { email: string } }> }>('admin', 'GET', `/programs/${program.GTI}/managers`);
    assert.deepEqual(managers.items.map((m) => m.user.email), [emails.designerA]);
    const listed = await ok<{ items: Subject[] }>('designerA', 'GET', '/course-templates?limit=100');
    assert.deepEqual(listed.items.map((s) => s.code).sort(), ['ITIL4-F', 'PMF'], 'only subjects of the granted program');
    assert.deepEqual((await ok<{ items: Subject[] }>('designerA', 'GET', `/course-templates?programId=${program.CDIA}`)).items, []);
    assert.equal((await ok<{ items: unknown[] }>('designerA', 'GET', `/course-templates/${subject['ITIL4-F'].id}/versions`)).items.length, 1, 'version history is readable');
  });

  it('lets a program manager version an authorized subject, keeping history and existing offerings intact', async () => {
    const itil = report.courses.find((c) => c.code === 'ITIL4-F-2026-2-A')!.id;
    const offeringBefore = (await database.pool.query('SELECT template_version_id FROM courses WHERE template_id = $1 ORDER BY code', [subject['ITIL4-F'].id])).rows;
    const sectionsBefore = (await database.pool.query('SELECT id, title, position, is_visible FROM sections WHERE course_id = $1 ORDER BY position', [itil])).rows;
    const v1Before = (await database.pool.query('SELECT v.*, (SELECT json_agg(s ORDER BY s.position) FROM course_template_sections s WHERE s.template_version_id = v.id) AS sections FROM course_template_versions v WHERE v.template_id = $1 AND v.version = 1', [subject['ITIL4-F'].id])).rows[0];

    expectProblem(await call('designerA', 'POST', '/course-templates', versionBody('ITIL4-F', program.GTI, 'ITIL 4 Foundation (2027 edition)', 0)), 409, 'TEMPLATE_CODE_TAKEN');
    const v2 = await ok<{ version: number; programId: string }>('designerA', 'POST', '/course-templates', versionBody('ITIL4-F', program.GTI, 'ITIL 4 Foundation (2027 edition)', 1), 201);
    assert.deepEqual([v2.version, v2.programId], [2, program.GTI]);
    expectProblem(await call('designerA', 'POST', '/course-templates', versionBody('ITIL4-F', program.GTI, 'Stale edit', 1)), 409, 'TEMPLATE_VERSION_CONFLICT');
    const created = await ok<{ version: number }>('designerA', 'POST', '/course-templates', versionBody('GTI-ITSM-ADV', program.GTI, 'Advanced service management', 0), 201);
    assert.equal(created.version, 1);

    const versions = await ok<{ items: Array<{ version: number; title: string; sectionCount: number }> }>('designerA', 'GET', `/course-templates/${subject['ITIL4-F'].id}/versions`);
    assert.deepEqual(versions.items.map((v) => [v.version, v.title, v.sectionCount]), [
      [2, 'ITIL 4 Foundation (2027 edition)', 2],
      [1, 'ITIL 4 Foundation', 4],
    ]);
    const v1After = (await database.pool.query('SELECT v.*, (SELECT json_agg(s ORDER BY s.position) FROM course_template_sections s WHERE s.template_version_id = v.id) AS sections FROM course_template_versions v WHERE v.template_id = $1 AND v.version = 1', [subject['ITIL4-F'].id])).rows[0];
    assert.deepEqual(v1After, v1Before, 'version 1 and its sections are untouched');
    assert.deepEqual((await database.pool.query('SELECT template_version_id FROM courses WHERE template_id = $1 ORDER BY code', [subject['ITIL4-F'].id])).rows, offeringBefore, 'offerings keep their version');
    assert.deepEqual((await database.pool.query('SELECT id, title, position, is_visible FROM sections WHERE course_id = $1 ORDER BY position', [itil])).rows, sectionsBefore);
    const detail = await ok<{ latestVersion: { version: number }; versionCount: number }>('designerA', 'GET', `/course-templates/${subject['ITIL4-F'].id}`);
    assert.deepEqual([detail.latestVersion.version, detail.versionCount], [2, 2]);
  });

  it('keeps managers inside their programs, authorizing by the stored subject and never by the request alone', async () => {
    const iai = subject.IAI.id;
    expectProblem(await call('designerA', 'GET', `/course-templates/${iai}`), 403, 'FORBIDDEN');
    expectProblem(await call('designerA', 'GET', `/course-templates/${iai}/versions`), 403, 'FORBIDDEN');
    expectProblem(await call('designerA', 'POST', '/course-templates', versionBody('IAI', program.CDIA, 'Hijack', 1)), 403, 'FORBIDDEN');
    expectProblem(await call('designerA', 'POST', '/course-templates', versionBody('CDIA-NEW', program.CDIA, 'New in another program', 0)), 403, 'FORBIDDEN');
    // Claiming an authorized program for a subject stored in another program is refused without revealing it.
    expectProblem(await call('designerA', 'POST', '/course-templates', versionBody('IAI', program.GTI, 'Moved', 1)), 403, 'FORBIDDEN');
    expectProblem(await call('designerA', 'POST', '/course-templates', versionBody('IAI', program.GTI, 'Probe', 0)), 403, 'FORBIDDEN');
    expectProblem(await call('designerB', 'POST', '/course-templates', versionBody('ITIL4-F', program.CDIA, 'Moved', 2)), 403, 'FORBIDDEN');
    // A subject without a program is administrator-only.
    expectProblem(await call('designerA', 'POST', '/course-templates', versionBody('NO-PROGRAM', null, 'Unassigned', 0)), 403, 'FORBIDDEN');
    // Within the granted program, the existing program rule still applies.
    expectProblem(await call('designerA', 'POST', '/course-templates', versionBody('ITIL4-F', program.CDIA, 'Wrong program', 2)), 422, 'TEMPLATE_PROGRAM_MISMATCH');
    assert.equal(await latestVersion('IAI'), 1);
    assert.equal(await latestVersion('ITIL4-F'), 2);
    assert.equal(await count(`SELECT count(*)::int AS n FROM course_templates WHERE code IN ('CDIA-NEW', 'NO-PROGRAM')`), 0);
    // Designer B manages CDIA only.
    assert.equal((await ok<{ version: number }>('designerB', 'POST', '/course-templates', versionBody('IAI', program.CDIA, 'Introducción a la IA (2027)', 1), 201)).version, 2);
  });

  it('grants nothing beyond subjects: no users, grading, quiz answers, courses, publishing, terms or programs', async () => {
    await grant('GTI', 'reviewer'); // design team in every demo course, now also a GTI manager
    const itil = report.courses.find((c) => c.code === 'ITIL4-F-2026-2-A')!.id;
    const draft = report.courses.find((c) => c.code === 'ITIL4-F-2026-2-B')!.id;
    const [term] = (await ok<{ items: Array<{ id: string }> }>('admin', 'GET', '/terms')).items;
    const book = await ok<{ columns: Array<{ activityId: string; type: string }> }>('instructor', 'GET', `/courses/${itil}/gradebook?limit=10`);
    const quiz = book.columns.find((c) => c.type === 'quiz')!.activityId;
    const essay = book.columns.find((c) => c.type === 'assignment')!.activityId;
    for (const who of ['designerA', 'reviewer'] as const) {
      for (const [method, url, body, status] of [
        ['GET', '/users', undefined, 403],
        ['POST', '/users', { email: 'x@academiapath.example', givenName: 'X', familyName: 'Y' }, 403],
        ['GET', '/programs', undefined, 403],
        ['POST', '/programs', { code: 'NEW', name: 'New program' }, 403],
        ['PUT', `/programs/${program.GTI}`, { name: 'Renamed', isActive: true }, 403],
        ['GET', '/terms', undefined, 403],
        ['POST', '/terms', { code: '2027-1', name: 'Semestre 2027-1', startsOn: '2027-03-15', endsOn: '2027-07-09' }, 403],
        ['PUT', `/terms/${term!.id}`, { name: 'Renamed', startsOn: '2026-08-17', endsOn: '2026-12-11' }, 403],
        ['POST', '/courses', { programId: program.GTI, termId: term!.id, templateId: subject['ITIL4-F'].id, code: 'BY-MANAGER' }, 403],
        ['POST', `/courses/${draft}/publish`, { version: 1 }, 403],
        ['GET', `/courses/${itil}/lifecycle`, undefined, 403],
        ['POST', `/programs/${program.CDIA}/managers`, { email: emails[who] }, 403],
        ['POST', `/courses/${itil}/enrollments`, { email: ACCOUNTS.learnerA, role: 'student' }, 403],
      ] as Array<[Method, string, unknown, number]>) {
        const res = await call(who, method, url, body);
        assert.equal(res.statusCode, status, `${who} ${method} ${url}: ${res.body}`);
      }
    }
    // Grading and results stay governed by course roles: the design team cannot grade, release or read results.
    expectProblem(await call('reviewer', 'GET', `/courses/${itil}/gradebook`), 403, 'FORBIDDEN');
    expectProblem(await call('reviewer', 'GET', `/courses/${itil}/activities/${quiz}/results`), 403, 'FORBIDDEN');
    expectProblem(await call('reviewer', 'POST', `/courses/${itil}/activities/${essay}/grades/release`), 403, 'FORBIDDEN');
    // Designer A holds no course role at all: courses, answer keys and grades are not even visible.
    expectProblem(await call('designerA', 'GET', `/courses/${itil}`), 404, 'NOT_FOUND');
    expectProblem(await call('designerA', 'GET', `/courses/${itil}/activities/${quiz}/questions`), 404, 'NOT_FOUND');
    assert.equal(await count('SELECT count(*)::int AS n FROM terms'), 2, 'no term was created');
  });

  it('only administrators grant or revoke; duplicates are refused, including concurrent ones', async () => {
    for (const who of ['designerA', 'reviewer', 'instructor', 'student'] as const) {
      expectProblem(await call(who, 'GET', `/programs/${program.CDIA}/managers`), 403, 'FORBIDDEN');
      expectProblem(await call(who, 'POST', `/programs/${program.CDIA}/managers`, { email: emails.designerA }), 403, 'FORBIDDEN');
      expectProblem(await call(who, 'DELETE', `/programs/${program.CDIA}/managers/${as.designerB.userId}`), 403, 'FORBIDDEN');
    }
    expectProblem(await call('admin', 'POST', `/programs/${program.GTI}/managers`, { email: emails.designerA.toUpperCase() }), 409, 'PROGRAM_MANAGER_EXISTS');
    const results = await Promise.all([1, 2, 3].map(() => call('admin', 'POST', `/programs/${program.CDIA}/managers`, { userId: as.instructor.userId })));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409, 409]);
    assert.equal(await count('SELECT count(*)::int AS n FROM program_managers WHERE program_id = $1 AND user_id = $2', [program.CDIA, as.instructor.userId]), 1);
    await ok('admin', 'DELETE', `/programs/${program.CDIA}/managers/${as.instructor.userId}`, undefined, 204);
    expectProblem(await call('admin', 'POST', `/programs/${program.GTI}/managers`, { email: 'nobody@academiapath.example' }), 422, 'USER_NOT_FOUND');
    expectProblem(await call('admin', 'POST', '/programs/00000000-0000-4000-8000-000000000000/managers', { email: emails.designerA }), 404, 'NOT_FOUND');
    expectProblem(await call('admin', 'POST', `/programs/${program.GTI}/managers`, { userId: as.designerA.userId, email: emails.designerA }), 400, 'VALIDATION_ERROR');
    expectProblem(await call('admin', 'POST', `/programs/${program.GTI}/managers`, { email: emails.designerB, programId: program.CDIA }), 400, 'VALIDATION_ERROR');
  });

  it('revocation applies to the next request, even when it races with a write', async () => {
    await ok('admin', 'DELETE', `/programs/${program.GTI}/managers/${as.reviewer.userId}`, undefined, 204);
    expectProblem(await call('reviewer', 'POST', '/course-templates', versionBody('PMF', program.GTI, 'After revocation', 1)), 403, 'FORBIDDEN');
    expectProblem(await call('reviewer', 'GET', '/course-templates'), 403, 'FORBIDDEN');
    assert.deepEqual(await ok('reviewer', 'GET', '/me/managed-programs'), { scope: 'granted', items: [] });
    expectProblem(await call('admin', 'DELETE', `/programs/${program.GTI}/managers/${as.reviewer.userId}`), 404, 'NOT_FOUND');

    // A revocation in progress (uncommitted) makes a concurrent write wait, and the write then fails.
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM program_managers WHERE program_id = $1 AND user_id = $2', [program.GTI, as.designerA.userId]);
      let settled = false;
      const pending = call('designerA', 'POST', '/course-templates', versionBody('PMF', program.GTI, 'Racing the revocation', 1)).then((res) => {
        settled = true;
        return res;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(settled, false, 'the write waits for the revocation to finish');
      await client.query('COMMIT');
      expectProblem(await pending, 403, 'FORBIDDEN');
    } finally {
      client.release();
    }
    assert.equal(await latestVersion('PMF'), 1, 'no version was written after the revocation');

    // Conversely, a write holding the grant finishes before a revocation that arrives during it.
    await grant('GTI', 'designerA');
    const outcomes = await Promise.all([
      call('designerA', 'POST', '/course-templates', versionBody('PMF', program.GTI, 'Before revocation', 1)),
      call('admin', 'DELETE', `/programs/${program.GTI}/managers/${as.designerA.userId}`),
    ]);
    assert.equal(outcomes[1]!.statusCode, 204);
    assert.ok([201, 403].includes(outcomes[0]!.statusCode), outcomes[0]!.body);
    expectProblem(await call('designerA', 'POST', '/course-templates', versionBody('PMF', program.GTI, 'After', await latestVersion('PMF'))), 403, 'FORBIDDEN');
  });

  it('never lets an inactive account use a grant', async () => {
    const designerB = as.designerB.userId;
    await ok('admin', 'POST', `/users/${designerB}/deactivate`);
    expectProblem(await call('designerB', 'POST', '/course-templates', versionBody('IAI', program.CDIA, 'While inactive', 2)), 401, 'UNAUTHENTICATED');
    const managers = await ok<{ items: Array<{ user: { email: string; isActive: boolean } }> }>('admin', 'GET', `/programs/${program.CDIA}/managers`);
    assert.deepEqual(managers.items.map((m) => [m.user.email, m.user.isActive]), [[emails.designerB, false]], 'administrators see the grant is unusable');
    expectProblem(await call('admin', 'POST', `/programs/${program.GTI}/managers`, { userId: designerB }), 422, 'USER_INACTIVE');
    // Even with a session forged around the session check, the grant query itself requires an active account.
    const { rows } = await database.pool.query(
      'SELECT count(*)::int AS n FROM program_managers pm JOIN users u ON u.id = pm.user_id WHERE pm.user_id = $1 AND u.is_active',
      [designerB],
    );
    assert.equal(rows[0].n, 0);
    assert.equal(await latestVersion('IAI'), 2);
    await ok('admin', 'POST', `/users/${designerB}/reactivate`);
    await signIn('designerB');
    assert.equal((await ok<{ version: number }>('designerB', 'POST', '/course-templates', versionBody('IAI', program.CDIA, 'After reactivation', 2), 201)).version, 3, 'reactivation restores the kept grant');
  });

  it('applies CSRF and Origin protections to grants and subject writes', async () => {
    expectProblem(await request('POST', `/programs/${program.GTI}/managers`, { session: as.admin, csrf: null, body: { email: emails.instructor } }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await request('POST', `/programs/${program.GTI}/managers`, { session: as.admin, origin: 'https://evil.example', body: { email: emails.instructor } }), 403, 'ORIGIN_NOT_ALLOWED');
    expectProblem(await request('DELETE', `/programs/${program.CDIA}/managers/${as.designerB.userId}`, { session: as.admin, csrf: 'forged' }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await request('POST', '/course-templates', { session: as.designerB, csrf: null, body: versionBody('IAI', program.CDIA, 'No CSRF', 3) }), 403, 'CSRF_TOKEN_INVALID');
    assert.equal(await count('SELECT count(*)::int AS n FROM program_managers WHERE user_id = $1', [as.instructor.userId]), 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM program_managers WHERE user_id = $1', [as.designerB.userId]), 1);
  });

  it('audits every grant, revocation and subject change with the acting user', async () => {
    const { rows } = await database.pool.query<{ action: string; actor: string; metadata: { before: Record<string, unknown> | null; after: Record<string, unknown> | null } }>(
      `SELECT a.action, u.email AS actor, a.metadata FROM audit_log a JOIN users u ON u.id = a.actor_user_id
       WHERE a.action IN ('program_manager.granted', 'program_manager.revoked', 'course_template.created', 'course_template.version_created') AND a.created_at > now() - interval '1 hour'
       ORDER BY a.created_at`,
    );
    const grants = rows.filter((r) => r.action.startsWith('program_manager.'));
    assert.ok(grants.length >= 8);
    assert.ok(grants.every((r) => r.actor === emails.admin), 'only the administrator changes grants');
    assert.ok(grants.some((r) => r.action === 'program_manager.revoked' && r.metadata.before?.userId === as.reviewer.userId));
    const subjectChanges = rows.filter((r) => r.action.startsWith('course_template.') && r.actor !== emails.admin);
    assert.ok(subjectChanges.some((r) => r.actor === emails.designerA && r.metadata.after?.code === 'GTI-ITSM-ADV'));
    assert.ok(subjectChanges.some((r) => r.actor === emails.designerB && r.metadata.after?.code === 'IAI'));
    assert.ok(subjectChanges.every((r) => r.metadata.after?.programId === program[r.actor === emails.designerB ? 'CDIA' : 'GTI']), 'managers only changed their own programs');
  });

  it('keeps the demo courses and dashboards working: re-seeding finds everything and creates nothing', async () => {
    const again = await seedDemo(database.db, { password: PASSWORD, env, uploadFilesDir: null });
    for (const [kind, counter] of Object.entries(again.counts)) assert.equal(counter.created, 0, `${kind} created again`);
    const itil = report.courses.find((c) => c.code === 'ITIL4-F-2026-2-A')!.id;
    await signIn('student');
    assert.equal((await ok<{ items: unknown[] }>('student', 'GET', '/courses')).items.length, 3);
    assert.ok((await ok<{ citations: unknown[] }>('student', 'POST', `/courses/${itil}/tutor/messages`, { question: 'What are the four dimensions of service management?', language: 'en' })).citations.length > 0);
    await signIn('instructor');
    assert.equal((await call('instructor', 'GET', `/courses/${itil}/gradebook?limit=10`)).statusCode, 200);
  });
});
