/**
 * Course lifecycle administration on the synthetic AP-016 demo dataset, against a temporary PostgreSQL
 * database (skipped unless TEST_DATABASE_URL is set): course details with version control, explicit
 * publish/unpublish transitions, section visibility and order, safe enrollment removal, role limits,
 * audit records and CSRF/Origin protection. Passwords are random per run.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { ACCOUNTS, type Persona } from '../../scripts/demo/content.js';
import { seedDemo, type DemoReport } from '../../scripts/seed-demo.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';

type App = ReturnType<typeof buildApp>;
type Session = { token: string; csrf: string; userId: string };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Course = { id: string; code: string; title: string; description: string | null; status: string; version: number; programId: string; termId: string; templateId: string };
type Section = { id: string; title: string; position: number; isVisible: boolean };

describe('course lifecycle (PostgreSQL, demo dataset)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let env: NodeJS.ProcessEnv;
  let report: DemoReport;
  let app: App;
  const as = {} as Record<Persona, Session>;
  let draftCourse: Course;

  const id = (code: string) => report.courses.find((c) => c.code === code)!.id;
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
  const call = (who: Persona, method: Method, url: string, body?: unknown) => request(method, url, { session: as[who], body });
  const ok = async <T = unknown>(who: Persona, method: Method, url: string, body?: unknown, status = 200): Promise<T> => {
    const res = await call(who, method, url, body);
    assert.equal(res.statusCode, status, `${method} ${url} as ${who}: ${res.body}`);
    return (res.body ? res.json() : null) as T;
  };
  const expectProblem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };
  const listAll = async <T>(who: Persona, url: string) => (await ok<{ items: T[] }>(who, 'GET', `${url}${url.includes('?') ? '&' : '?'}limit=100`)).items;
  const course = (code: string) => ok<Course>('admin', 'GET', `/courses/${id(code)}`);
  const sectionsOf = (courseId: string, who: Persona = 'admin') => listAll<Section>(who, `/courses/${courseId}/sections`);
  /** Every activity title a persona can list in a course, section by section (hidden sections are refused). */
  const visibleTitles = async (who: Persona, courseId: string) => {
    const titles: string[] = [];
    for (const section of await sectionsOf(courseId)) {
      const res = await call(who, 'GET', `/courses/${courseId}/sections/${section.id}/activities?limit=100`);
      if (res.statusCode === 200) titles.push(...res.json().items.map((a: { title: string }) => `${section.title} / ${a.title}`));
    }
    return titles;
  };
  const myGrades = async (who: Persona, courseId: string) => {
    const res = await call(who, 'GET', `/courses/${courseId}/grades/mine`);
    if (res.statusCode !== 200) return res.statusCode;
    return Object.fromEntries(res.json().items.map((i: { type: string; grade: { grade20: number } | null }) => [i.type, i.grade?.grade20 ?? null]));
  };
  const count = async (sql: string, params: unknown[] = []) => Number((await database.pool.query(sql, params)).rows[0].n);
  const templateSnapshot = async () => JSON.stringify((await database.pool.query('SELECT * FROM course_template_sections ORDER BY id')).rows);
  const recordCounts = async (courseId: string) => ({
    enrollments: await count('SELECT count(*)::int AS n FROM enrollments WHERE course_id = $1', [courseId]),
    sections: await count('SELECT count(*)::int AS n FROM sections WHERE course_id = $1', [courseId]),
    activities: await count('SELECT count(*)::int AS n FROM activities a JOIN sections s ON s.id = a.section_id WHERE s.course_id = $1', [courseId]),
    attempts: await count('SELECT count(*)::int AS n FROM quiz_attempts WHERE course_id = $1', [courseId]),
    submissions: await count('SELECT count(*)::int AS n FROM assignment_submissions WHERE course_id = $1', [courseId]),
    grades: await count('SELECT count(*)::int AS n FROM grades WHERE course_id = $1', [courseId]),
  });
  const enrollmentOf = async (courseId: string, persona: Persona) =>
    (await listAll<{ id: string; status: string; user: { email: string } }>('admin', `/courses/${courseId}/enrollments`)).find((e) => e.user.email === ACCOUNTS[persona])!;

  before(async () => {
    database = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'ap-lifecycle-'));
    env = { NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: join(root, 'store') };
    report = await seedDemo(database.db, { password: PASSWORD, env, uploadFilesDir: null });
    app = buildApp({ config: { ...loadConfig(env), loginRateLimit: { max: 1000, windowMs: 60_000 } }, database: database.db });
    await app.ready();
    for (const persona of Object.keys(ACCOUNTS) as Persona[]) {
      const res = await request('POST', '/auth/login', { body: { email: ACCOUNTS[persona], password: PASSWORD } });
      assert.equal(res.statusCode, 200, res.body);
      as[persona] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
    }
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('creates a draft offering from a reusable subject template without touching the template', async () => {
    const templateBefore = await templateSnapshot();
    const itil = await course('ITIL4-F-2026-2-A');
    draftCourse = await ok<Course>(
      'admin',
      'POST',
      '/courses',
      { programId: itil.programId, termId: itil.termId, templateId: itil.templateId, code: 'ITIL4-F-2026-2-C', title: 'ITIL 4 Foundation (Saturday group)', status: 'draft' },
      201,
    );
    assert.deepEqual([draftCourse.status, draftCourse.version], ['draft', 1]);
    assert.deepEqual((await sectionsOf(draftCourse.id)).map((s) => s.title), (await sectionsOf(itil.id)).map((s) => s.title), 'sections copied from the template');
    for (const [persona, role] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['student', 'student'], ['learnerA', 'student']] as const) {
      await ok('admin', 'POST', `/courses/${draftCourse.id}/enrollments`, { email: ACCOUNTS[persona], role }, 201);
    }
    expectProblem(await call('student', 'GET', `/courses/${draftCourse.id}`), 404, 'NOT_FOUND');
    assert.ok(!(await listAll<{ id: string }>('student', '/courses')).some((c) => c.id === draftCourse.id), 'drafts are not listed to students');
    assert.equal(await templateSnapshot(), templateBefore);
  });

  it('edits course details with an explicit version; the code changes only while the course is a draft', async () => {
    const edited = await ok<Course>('admin', 'PUT', `/courses/${draftCourse.id}`, { version: 1, title: '  ITIL 4 Foundation (Saturday cohort) ', description: 'Synthetic Saturday cohort for the demo.' });
    assert.deepEqual([edited.title, edited.description, edited.version], ['ITIL 4 Foundation (Saturday cohort)', 'Synthetic Saturday cohort for the demo.', 2]);
    expectProblem(await call('admin', 'PUT', `/courses/${draftCourse.id}`, { version: 1, title: 'Stale' }), 409, 'COURSE_VERSION_CONFLICT');
    const renamed = await ok<Course>('admin', 'PUT', `/courses/${draftCourse.id}`, { version: 2, code: 'ITIL4-F-2026-2-S', description: null });
    assert.deepEqual([renamed.code, renamed.description, renamed.version], ['ITIL4-F-2026-2-S', null, 3]);
    expectProblem(await call('admin', 'PUT', `/courses/${draftCourse.id}`, { version: 3, code: 'ITIL4-F-2026-2-A' }), 409, 'COURSE_CODE_TAKEN');
    expectProblem(await call('admin', 'PUT', `/courses/${draftCourse.id}`, { version: 3 }), 400, 'VALIDATION_ERROR');
    expectProblem(await call('admin', 'PUT', `/courses/${draftCourse.id}`, { version: 3, status: 'published' }), 400, 'VALIDATION_ERROR');
    expectProblem(await call('admin', 'PUT', `/courses/${draftCourse.id}`, { version: 3, title: '   ' }), 400, 'VALIDATION_ERROR');
    const unchanged = await ok<Course>('admin', 'PUT', `/courses/${draftCourse.id}`, { version: 3, title: renamed.title });
    assert.equal(unchanged.version, 3, 'a no-op edit does not bump the version');
    const itil = await course('ITIL4-F-2026-2-A');
    expectProblem(await call('admin', 'PUT', `/courses/${itil.id}`, { version: itil.version, code: 'ITIL-RENAMED' }), 409, 'COURSE_CODE_LOCKED');
    draftCourse = await ok<Course>('admin', 'GET', `/courses/${draftCourse.id}`);
  });

  it('serializes concurrent edits: only one change per version wins', async () => {
    const results = await Promise.all(
      ['Cohort A', 'Cohort B', 'Cohort C'].map((suffix) => call('admin', 'PUT', `/courses/${draftCourse.id}`, { version: draftCourse.version, title: `ITIL 4 Foundation (${suffix})` })),
    );
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409, 409]);
    assert.ok(results.filter((r) => r.statusCode === 409).every((r) => r.json().code === 'COURSE_VERSION_CONFLICT'));
    draftCourse = await ok<Course>('admin', 'GET', `/courses/${draftCourse.id}`);
    assert.equal(draftCourse.version, 4);
  });

  it('publishes a draft explicitly without exposing unapproved content or hidden sections', async () => {
    const [first, second, , hidden] = await sectionsOf(draftCourse.id);
    const create = (sectionId: string, title: string) => ok<{ id: string }>('instructor', 'POST', `/courses/${draftCourse.id}/sections/${sectionId}/activities`, { type: 'page', title, body: `${title} body text.` }, 201);
    const approved = await create(first!.id, 'Approved welcome');
    await ok('instructor', 'POST', `/courses/${draftCourse.id}/activities/${approved.id}/submit`);
    await ok('reviewer', 'POST', `/courses/${draftCourse.id}/activities/${approved.id}/review`, { decision: 'approve' });
    const draftLesson = await create(first!.id, 'Unreviewed draft');
    const submitted = await create(second!.id, 'Waiting for review');
    await ok('instructor', 'POST', `/courses/${draftCourse.id}/activities/${submitted.id}/submit`);
    const inHidden = await create(hidden!.id, 'Approved but in a hidden section');
    await ok('instructor', 'POST', `/courses/${draftCourse.id}/activities/${inHidden.id}/submit`);
    await ok('reviewer', 'POST', `/courses/${draftCourse.id}/activities/${inHidden.id}/review`, { decision: 'approve' });
    assert.equal(hidden!.isVisible, false, 'the template hides the instructor notes section');

    const overview = await ok<{ studentVisibleActivityCount: number; unapprovedActivityCount: number; awaitingReviewCount: number; allowedTransitions: string[] }>(
      'admin',
      'GET',
      `/courses/${draftCourse.id}/lifecycle`,
    );
    assert.deepEqual(
      [overview.studentVisibleActivityCount, overview.unapprovedActivityCount, overview.awaitingReviewCount, overview.allowedTransitions],
      [1, 2, 1, ['publish']],
    );
    expectProblem(await call('admin', 'POST', `/courses/${draftCourse.id}/unpublish`, { version: draftCourse.version }), 409, 'INVALID_COURSE_TRANSITION');
    expectProblem(await call('admin', 'POST', `/courses/${draftCourse.id}/publish`, { version: draftCourse.version - 1 }), 409, 'COURSE_VERSION_CONFLICT');
    expectProblem(await call('admin', 'POST', `/courses/${draftCourse.id}/publish`, {}), 400, 'VALIDATION_ERROR');

    const published = await ok<Course>('admin', 'POST', `/courses/${draftCourse.id}/publish`, { version: draftCourse.version });
    assert.deepEqual([published.status, published.version], ['published', draftCourse.version + 1]);
    draftCourse = published;
    expectProblem(await call('admin', 'POST', `/courses/${draftCourse.id}/publish`, { version: draftCourse.version }), 409, 'INVALID_COURSE_TRANSITION');

    assert.equal((await call('student', 'GET', `/courses/${draftCourse.id}`)).statusCode, 200, 'enrolled students can open the published course');
    assert.deepEqual(await visibleTitles('student', draftCourse.id), [`${first!.title} / Approved welcome`]);
    for (const hiddenActivity of [draftLesson, submitted, inHidden]) {
      expectProblem(await call('student', 'GET', `/courses/${draftCourse.id}/activities/${hiddenActivity.id}`), 404, 'NOT_FOUND');
    }
    expectProblem(await call('student', 'GET', `/courses/${draftCourse.id}/sections/${hidden!.id}/activities`), 404, 'NOT_FOUND');
  });

  it('unpublishes a published course for students without deleting anything; republishing restores the same view', async () => {
    const itil = await course('ITIL4-F-2026-2-A');
    const recordsBefore = await recordCounts(itil.id);
    const studentView = await visibleTitles('student', itil.id);
    const gradesA = await myGrades('learnerA', itil.id);
    const gradesB = await myGrades('learnerB', itil.id);
    assert.deepEqual([gradesA, gradesB], [{ quiz: 20, assignment: 16 }, { quiz: null, assignment: null }]);
    const overview = await ok<{ studentVisibleActivityCount: number }>('admin', 'GET', `/courses/${itil.id}/lifecycle`);
    assert.equal(overview.studentVisibleActivityCount, studentView.length, 'the overview counts exactly what students can open');

    const unpublished = await ok<Course>('admin', 'POST', `/courses/${itil.id}/unpublish`, { version: itil.version });
    assert.equal(unpublished.status, 'draft');
    for (const persona of ['student', 'learnerA', 'learnerB'] as const) expectProblem(await call(persona, 'GET', `/courses/${itil.id}`), 404, 'NOT_FOUND');
    assert.equal(await myGrades('learnerA', itil.id), 404);
    for (const persona of ['instructor', 'reviewer', 'ta'] as const) assert.equal((await call(persona, 'GET', `/courses/${itil.id}`)).statusCode, 200, `${persona} keeps access`);
    assert.deepEqual(await recordCounts(itil.id), recordsBefore, 'no content, enrollment, attempt, submission or grade was deleted');

    await ok('admin', 'POST', `/courses/${itil.id}/publish`, { version: unpublished.version });
    assert.deepEqual(await visibleTitles('student', itil.id), studentView);
    assert.deepEqual([await myGrades('learnerA', itil.id), await myGrades('learnerB', itil.id)], [gradesA, gradesB], 'released grades back, unreleased still hidden');
    assert.deepEqual(await recordCounts(itil.id), recordsBefore);
  });

  it('shows, hides, adds and reorders sections on the offering only', async () => {
    const templateBefore = await templateSnapshot();
    const siblingBefore = JSON.stringify(await sectionsOf(id('ITIL4-F-2026-2-B')));
    const pm = id('PMF-2026-2-A');
    const before = await sectionsOf(pm);
    const unit1 = before[0]!;
    const studentBefore = await visibleTitles('student', pm);
    const lessonInUnit1 = (await listAll<{ id: string }>('student', `/courses/${pm}/sections/${unit1.id}/activities`))[0]!;

    const hiddenSection = await ok<Section>('admin', 'PUT', `/courses/${pm}/sections/${unit1.id}`, { isVisible: false });
    assert.equal(hiddenSection.isVisible, false);
    expectProblem(await call('student', 'GET', `/courses/${pm}/sections/${unit1.id}/activities`), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', `/courses/${pm}/activities/${lessonInUnit1.id}`), 404, 'NOT_FOUND');
    assert.ok((await visibleTitles('student', pm)).every((t) => !t.startsWith(unit1.title)));
    await ok('admin', 'PUT', `/courses/${pm}/sections/${unit1.id}`, { isVisible: true });
    assert.deepEqual(await visibleTitles('student', pm), studentBefore, 'showing it again restores exactly the approved content');

    const reversed = [...before].reverse().map((s) => s.id);
    const reordered = await ok<{ items: Section[] }>('admin', 'PUT', `/courses/${pm}/sections/order`, { sectionIds: reversed });
    assert.deepEqual(reordered.items.map((s) => [s.id, s.position]), reversed.map((sectionId, index) => [sectionId, index]));
    assert.deepEqual((await sectionsOf(pm)).map((s) => s.id), reversed, 'the order persists');
    assert.deepEqual((await sectionsOf(pm, 'student')).map((s) => s.id), reversed.filter((sectionId) => before.find((s) => s.id === sectionId)!.isVisible));
    expectProblem(await call('admin', 'PUT', `/courses/${pm}/sections/order`, { sectionIds: reversed.slice(1) }), 409, 'SECTION_ORDER_STALE');
    expectProblem(await call('admin', 'PUT', `/courses/${pm}/sections/order`, { sectionIds: [...reversed.slice(1), (await sectionsOf(id('ITIL4-F-2026-2-A')))[0]!.id] }), 409, 'SECTION_ORDER_STALE');
    expectProblem(await call('admin', 'PUT', `/courses/${pm}/sections/order`, { sectionIds: [reversed[0], ...reversed.slice(0, -1)] }), 422, 'INVALID_SECTION_ORDER');
    await ok('admin', 'PUT', `/courses/${pm}/sections/order`, { sectionIds: before.map((s) => s.id) });

    const added = await ok<Section>('admin', 'POST', `/courses/${pm}/sections`, { title: '  Unit 4 - Review week ', summary: 'Synthetic revision unit.' }, 201);
    assert.deepEqual([added.title, added.position, added.isVisible], ['Unit 4 - Review week', before.length, true]);
    const renamed = await ok<Section>('admin', 'PUT', `/courses/${pm}/sections/${added.id}`, { title: 'Unit 4 - Revision week', summary: null });
    assert.equal(renamed.title, 'Unit 4 - Revision week');
    expectProblem(await call('admin', 'PUT', `/courses/${pm}/sections/${(await sectionsOf(id('ITIL4-F-2026-2-A')))[0]!.id}`, { isVisible: false }), 404, 'NOT_FOUND');
    expectProblem(await call('admin', 'PUT', `/courses/${pm}/sections/${added.id}`, { courseId: id('ITIL4-F-2026-2-A') }), 400, 'VALIDATION_ERROR');

    assert.equal(await templateSnapshot(), templateBefore, 'subject template versions are never modified');
    assert.equal(JSON.stringify(await sectionsOf(id('ITIL4-F-2026-2-B'))), siblingBefore, 'another offering of the same subject is unchanged');
  });

  it('keeps concurrent structure changes consistent', async () => {
    const pm = id('PMF-2026-2-A');
    await Promise.all(['A', 'B', 'C', 'D'].map((x) => ok('admin', 'POST', `/courses/${pm}/sections`, { title: `Parallel ${x}`, isVisible: false }, 201)));
    const positions = (await sectionsOf(pm)).map((s) => s.position);
    assert.deepEqual(positions, positions.map((_, index) => index), 'unique, gap-free positions');
    const ids = (await sectionsOf(pm)).map((s) => s.id);
    const results = await Promise.all([
      call('admin', 'PUT', `/courses/${pm}/sections/order`, { sectionIds: [...ids].reverse() }),
      call('admin', 'PUT', `/courses/${pm}/sections/order`, { sectionIds: ids }),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode), [200, 200]);
    const final = (await sectionsOf(pm)).map((s) => [s.id, s.position]);
    assert.ok(JSON.stringify(final.map((f) => f[0])) === JSON.stringify(ids) || JSON.stringify(final.map((f) => f[0])) === JSON.stringify([...ids].reverse()), 'one complete order wins');
    assert.deepEqual(final.map((f) => f[1]), final.map((_, index) => index));
    await ok('admin', 'PUT', `/courses/${pm}/sections/order`, { sectionIds: ids });

    const fresh = await ok<Course>('admin', 'POST', '/courses', { programId: draftCourse.programId, termId: draftCourse.termId, templateId: draftCourse.templateId, code: 'ITIL4-F-2026-2-D', status: 'draft' }, 201);
    const publishes = await Promise.all([1, 2].map(() => call('admin', 'POST', `/courses/${fresh.id}/publish`, { version: fresh.version })));
    assert.deepEqual(publishes.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal((await ok<Course>('admin', 'GET', `/courses/${fresh.id}`)).version, 2, 'exactly one transition happened');
  });

  it('deactivates or removes enrollments safely; re-enrollment keeps the student history', async () => {
    const pm = id('PMF-2026-2-A');
    const enrollment = await enrollmentOf(pm, 'student');
    const gradesBefore = await myGrades('student', pm);
    assert.deepEqual(gradesBefore, { quiz: 15, assignment: 18 });
    const historyBefore = await count('SELECT count(*)::int AS n FROM grades WHERE enrollment_id = $1', [enrollment.id]);
    const attemptsBefore = await count('SELECT count(*)::int AS n FROM quiz_attempts WHERE enrollment_id = $1', [enrollment.id]);
    assert.ok(historyBefore > 0 && attemptsBefore > 0);

    expectProblem(await call('admin', 'DELETE', `/courses/${pm}/enrollments/${enrollment.id}`), 409, 'ENROLLMENT_HAS_HISTORY');
    await ok('admin', 'PUT', `/courses/${pm}/enrollments/${enrollment.id}`, { status: 'inactive' });
    expectProblem(await call('student', 'GET', `/courses/${pm}`), 404, 'NOT_FOUND');
    assert.equal(await myGrades('student', pm), 404);
    assert.equal(await count('SELECT count(*)::int AS n FROM grades WHERE enrollment_id = $1', [enrollment.id]), historyBefore, 'historical grades stay stored');
    expectProblem(await call('admin', 'POST', `/courses/${pm}/enrollments`, { email: ACCOUNTS.student, role: 'student' }), 409, 'ENROLLMENT_EXISTS');

    await ok('admin', 'PUT', `/courses/${pm}/enrollments/${enrollment.id}`, { status: 'active' });
    assert.deepEqual(await myGrades('student', pm), gradesBefore, 'reactivation restores the same released grades');
    assert.equal(await count('SELECT count(*)::int AS n FROM quiz_attempts WHERE enrollment_id = $1', [enrollment.id]), attemptsBefore);
    assert.equal((await enrollmentOf(pm, 'student')).id, enrollment.id, 'the same enrollment, not a new one');

    const mistaken = await ok<{ id: string }>('admin', 'POST', `/courses/${pm}/enrollments`, { email: ACCOUNTS.learnerB, role: 'student' }, 201);
    assert.equal((await call('learnerB', 'GET', `/courses/${pm}`)).statusCode, 200);
    await ok('admin', 'DELETE', `/courses/${pm}/enrollments/${mistaken.id}`, undefined, 204);
    expectProblem(await call('learnerB', 'GET', `/courses/${pm}`), 404, 'NOT_FOUND');
    expectProblem(await call('admin', 'DELETE', `/courses/${pm}/enrollments/${mistaken.id}`), 404, 'NOT_FOUND');
    const itilEnrollment = await enrollmentOf(id('ITIL4-F-2026-2-A'), 'learnerB');
    expectProblem(await call('admin', 'DELETE', `/courses/${pm}/enrollments/${itilEnrollment.id}`), 404, 'NOT_FOUND');
  });

  it('refuses every lifecycle operation to design team, instructors, non-editing instructors and students', async () => {
    const itil = await course('ITIL4-F-2026-2-A');
    const [section] = await sectionsOf(itil.id);
    const enrollment = await enrollmentOf(itil.id, 'learnerA');
    const before = JSON.stringify([await course('ITIL4-F-2026-2-A'), await sectionsOf(itil.id), await enrollmentOf(itil.id, 'learnerA')]);
    for (const persona of ['reviewer', 'instructor', 'ta', 'student'] as const) {
      for (const [method, url, body] of [
        ['GET', `/courses/${itil.id}/lifecycle`, undefined],
        ['PUT', `/courses/${itil.id}`, { version: itil.version, title: 'Hijacked' }],
        ['POST', `/courses/${itil.id}/unpublish`, { version: itil.version }],
        ['POST', `/courses/${draftCourse.id}/publish`, { version: draftCourse.version }],
        ['POST', `/courses/${itil.id}/sections`, { title: 'Injected' }],
        ['PUT', `/courses/${itil.id}/sections/order`, { sectionIds: [section!.id] }],
        ['PUT', `/courses/${itil.id}/sections/${section!.id}`, { isVisible: false }],
        ['DELETE', `/courses/${itil.id}/enrollments/${enrollment.id}`, undefined],
        ['PUT', `/courses/${itil.id}/enrollments/${enrollment.id}`, { status: 'inactive' }],
      ] as Array<[Method, string, unknown]>) {
        expectProblem(await call(persona, method, url, body), 403, 'FORBIDDEN');
      }
    }
    expectProblem(await request('GET', `/courses/${itil.id}/lifecycle`), 401, 'UNAUTHENTICATED');
    assert.equal(JSON.stringify([await course('ITIL4-F-2026-2-A'), await sectionsOf(itil.id), await enrollmentOf(itil.id, 'learnerA')]), before, 'nothing changed');

    // Instructors keep editing their content through review: a new lesson stays hidden until approved.
    const lesson = await ok<{ id: string }>('instructor', 'POST', `/courses/${itil.id}/sections/${section!.id}/activities`, { type: 'page', title: 'Instructor draft', body: 'Draft text.' }, 201);
    expectProblem(await call('instructor', 'POST', `/courses/${itil.id}/activities/${lesson.id}/review`, { decision: 'approve' }), 403, 'FORBIDDEN');
    expectProblem(await call('student', 'GET', `/courses/${itil.id}/activities/${lesson.id}`), 404, 'NOT_FOUND');
  });

  it('applies normal CSRF and Origin protections', async () => {
    const pm = await course('PMF-2026-2-A');
    expectProblem(await request('PUT', `/courses/${pm.id}`, { session: as.admin, csrf: null, body: { version: pm.version, title: 'No CSRF' } }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await request('POST', `/courses/${pm.id}/unpublish`, { session: as.admin, origin: 'https://evil.example', body: { version: pm.version } }), 403, 'ORIGIN_NOT_ALLOWED');
    const [section] = await sectionsOf(pm.id);
    expectProblem(await request('PUT', `/courses/${pm.id}/sections/${section!.id}`, { session: as.admin, csrf: 'forged', body: { isVisible: false } }), 403, 'CSRF_TOKEN_INVALID');
    const enrollment = await enrollmentOf(pm.id, 'learnerA');
    expectProblem(await request('DELETE', `/courses/${pm.id}/enrollments/${enrollment.id}`, { session: as.admin, csrf: null }), 403, 'CSRF_TOKEN_INVALID');
    const after = await course('PMF-2026-2-A');
    assert.deepEqual([after.title, after.status, after.version], [pm.title, 'published', pm.version]);
    assert.equal((await sectionsOf(pm.id))[0]!.isVisible, section!.isVisible);
  });

  it('audits every lifecycle action with the administrator as actor', async () => {
    const { rows } = await database.pool.query<{ action: string; actor_user_id: string; metadata: { before: unknown; after: unknown } }>(
      `SELECT action, actor_user_id, metadata FROM audit_log WHERE action IN ('course.updated', 'course.published', 'course.unpublished', 'section.created', 'section.updated', 'sections.reordered', 'enrollment.deleted', 'enrollment.updated')`,
    );
    const actions = new Set(rows.map((r) => r.action));
    for (const action of ['course.updated', 'course.published', 'course.unpublished', 'section.created', 'section.updated', 'sections.reordered', 'enrollment.deleted', 'enrollment.updated']) {
      assert.ok(actions.has(action), `missing ${action}`);
    }
    assert.ok(rows.every((r) => r.actor_user_id === as.admin.userId), 'only the administrator changed courses');
    const unpublish = rows.find((r) => r.action === 'course.unpublished')!;
    assert.deepEqual([(unpublish.metadata.before as { status: string }).status, (unpublish.metadata.after as { status: string }).status], ['published', 'draft']);
  });

  it('keeps the three seeded demo courses working: re-seeding finds everything and creates nothing', async () => {
    const again = await seedDemo(database.db, { password: PASSWORD, env, uploadFilesDir: null });
    for (const [kind, counter] of Object.entries(again.counts)) assert.equal(counter.created, 0, `${kind} created again`);
    assert.deepEqual(
      again.courses.filter((c) => c.code !== 'ITIL4-F-2026-2-B').map((c) => [c.code, c.status]),
      [
        ['ITIL4-F-2026-2-A', 'published'],
        ['PMF-2026-2-A', 'published'],
        ['IAI-2026-2-A', 'published'],
      ],
    );
    const tutor = await ok<{ citations: unknown[] }>('student', 'POST', `/courses/${id('ITIL4-F-2026-2-A')}/tutor/messages`, { question: 'What are the four dimensions of service management?', language: 'en' });
    assert.ok(tutor.citations.length > 0, 'the tutor still answers from approved lessons');
  });
});
