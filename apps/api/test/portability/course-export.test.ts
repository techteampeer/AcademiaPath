/**
 * AP-038A course content export (package format v1). Unit tests of the size guard, then API tests against a temporary
 * PostgreSQL database (skipped unless TEST_DATABASE_URL is set): authorized and refused callers, course boundaries,
 * completeness (units, prerequisites, folders, every activity type with working and approved versions, quiz answer
 * keys, rubrics, document references), stable serialization, empty and large courses, the activity limit, missing
 * files and invalid references, no personal or cross-course data, and no change to the source course. All accounts and
 * content are synthetic; every password is random per run.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { activities, auditLog, courseDocuments, quizQuestions, sections, userCredentials, users } from '../../src/db/schema/index.js';
import { EXPORT_ACTIVITY_LIMIT, EXPORT_MAX_BYTES, serializePackage, type CoursePackage, type PackageActivity } from '../../src/portability/course-package.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { makePdf, multipartBody } from '../helpers/documents.js';

const PASSWORD = randomBytes(18).toString('base64url');
const COOKIE = 'ap_session';
const ORIGIN = 'http://localhost:3000';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAILS = {
  admin: 'admin@academiapath.example',
  instructor: 'instructor@academiapath.example',
  reviewer: 'reviewer@academiapath.example',
  ta: 'ta@academiapath.example',
  student: 'student@academiapath.example',
  otherInstructor: 'other.instructor@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;

describe('course package serialization limits', () => {
  it('refuses a package above the size limit instead of sending a partial one', () => {
    const huge = { course: { title: 'Big', description: 'x'.repeat(EXPORT_MAX_BYTES) } } as unknown as CoursePackage;
    assert.throws(() => serializePackage(huge), (error: { status?: number; code?: string }) => error.status === 422 && error.code === 'COURSE_EXPORT_TOO_LARGE');
    const small = { course: { title: 'Small', description: null } } as unknown as CoursePackage;
    assert.equal(serializePackage(small), JSON.stringify(small));
  });
});

describe('course export API (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let storageDir: string;
  const sessions = new Map<Person, { token: string; csrf: string; userId: string }>();
  const ids = {} as Record<
    'program' | 'term' | 'courseA' | 'courseB' | 'empty' | 'unit1' | 'unit2' | 'unit3' | 'welcome' | 'draftOnly' | 'link' | 'quiz' | 'assignment' | 'document' | 'returned' | 'folder' | 'courseBDocument',
    string
  >;

  const call = (who: Person | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
    const current = who ? sessions.get(who)! : null;
    return app.inject({
      method,
      url: `/api/v1${url}`,
      ...(payload ? { payload } : {}),
      cookies: current ? { [COOKIE]: current.token } : {},
      headers: method !== 'GET' && current ? { 'x-csrf-token': current.csrf, origin: ORIGIN } : {},
    });
  };
  const ok = (res: LightMyRequestResponse, status = 200) => {
    assert.equal(res.statusCode, status, res.body);
    return res.json();
  };
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };
  const exportOf = async (who: Person, courseId: string) => {
    const res = await call(who, 'GET', `/courses/${courseId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    return { res, pkg: res.json() as CoursePackage };
  };
  const activityIn = (pkg: CoursePackage, title: string): PackageActivity => {
    const found = pkg.course.units.flatMap((unit) => unit.activities).find((activity) => activity.working.title === title || activity.approved?.title === title);
    assert.ok(found, `activity ${title}`);
    return found;
  };
  const create = async (courseId: string, sectionId: string, body: object) => ok(await call('instructor', 'POST', `/courses/${courseId}/sections/${sectionId}/activities`, body), 201).id as string;
  const approve = async (courseId: string, activityId: string) => {
    ok(await call('instructor', 'POST', `/courses/${courseId}/activities/${activityId}/submit`));
    ok(await call('reviewer', 'POST', `/courses/${courseId}/activities/${activityId}/review`, { decision: 'approve' }));
  };
  const upload = async (courseId: string, sectionId: string, who: Person, filename: string, title: string) => {
    const current = sessions.get(who)!;
    const { payload, contentType } = multipartBody([{ name: 'title', value: title }, { name: 'file', filename, data: makePdf([['Service value chain overview', 'Value streams combine activities to create value for customers.']]) }]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/${courseId}/sections/${sectionId}/documents`,
      payload,
      cookies: { [COOKIE]: current.token },
      headers: { 'content-type': contentType, 'x-csrf-token': current.csrf, origin: ORIGIN },
    });
    return ok(res, 201).activityId as string;
  };
  /** Every table's row count and content digest, except the audit log (which records the export itself). */
  const fingerprint = async () => {
    const { rows } = await database.pool.query<{ table_name: string; h: string }>(
      `SELECT t.table_name, (xpath('/row/h/text()', query_to_xml(format('SELECT count(*) || '':'' || md5(coalesce(string_agg(x::text, ''|'' ORDER BY x::text), '''')) AS h FROM %I x', t.table_name), false, true, '')))[1]::text AS h
       FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND t.table_name <> 'audit_log' ORDER BY t.table_name`,
    );
    return Object.fromEntries(rows.map((row) => [row.table_name, row.h]));
  };

  before(async () => {
    storageDir = join(await mkdtemp(join(tmpdir(), 'ap-export-test-')), 'store');
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const [other] = await database.db.insert(users).values({ email: EMAILS.otherInstructor, givenName: 'Other', familyName: 'Instructor' }).returning();
    await database.db.insert(userCredentials).values({ userId: other!.id, passwordHash: await hashPassword(PASSWORD) });
    app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir, DOCUMENT_MAX_UPLOAD_MB: '5' }), database: database.db });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAILS[person], password: PASSWORD }, headers: { origin: ORIGIN } });
      const body = ok(res);
      sessions.set(person, { token: res.cookies.find((c) => c.name === COOKIE)!.value, csrf: body.csrfToken, userId: body.user.id });
    }
    ids.program = ok(await call('admin', 'POST', '/programs', { code: 'ING-SIS', name: 'Ingeniería de Sistemas' }), 201).id;
    ids.term = ok(await call('admin', 'POST', '/terms', { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' }), 201).id;
    const template = async (code: string, unitTitles: Array<{ title: string; isVisible?: boolean }>) =>
      ok(await call('admin', 'POST', '/course-templates', { code, programId: ids.program, title: `Template ${code}`, sections: unitTitles }), 201).templateId as string;
    const course = async (templateId: string, code: string, status: string) =>
      ok(await call('admin', 'POST', '/courses', { programId: ids.program, termId: ids.term, templateId, code, status }), 201).id as string;
    const full = await template('ITIL-F', [{ title: 'Unit 1 · Foundations' }, { title: 'Unit 2 · Instructor notes', isVisible: false }, { title: 'Unit 3 · Assessment' }]);
    ids.courseA = await course(full, 'ITIL-A', 'published');
    ids.courseB = await course(full, 'ITIL-B', 'published');
    ids.empty = await course(await template('EMPTY-T', []), 'EMPTY-1', 'draft');
    const enroll = async (courseId: string, person: Person, role: string) => ok(await call('admin', 'POST', `/courses/${courseId}/enrollments`, { email: EMAILS[person], role }), 201);
    for (const [person, role] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['ta', 'non_editing_instructor'], ['student', 'student']] as const) await enroll(ids.courseA, person, role);
    await enroll(ids.courseB, 'otherInstructor', 'instructor');
    await enroll(ids.courseB, 'reviewer', 'design_team');
    await enroll(ids.empty, 'instructor', 'instructor');
    await enroll(ids.empty, 'student', 'student');
    [ids.unit1, ids.unit2, ids.unit3] = ok(await call('admin', 'GET', `/courses/${ids.courseA}/sections`)).items.map((s: { id: string }) => s.id);

    // Course A: every supported activity type, working and approved versions, a folder and a prerequisite.
    ids.welcome = await create(ids.courseA, ids.unit1, { type: 'page', title: 'Welcome', body: 'Approved welcome text.' });
    await approve(ids.courseA, ids.welcome);
    ok(await call('instructor', 'PUT', `/courses/${ids.courseA}/activities/${ids.welcome}`, { title: 'Welcome (revised)', body: 'Revised welcome text, not reviewed yet.' }));
    ids.draftOnly = await create(ids.courseA, ids.unit1, { type: 'page', title: 'Draft only', body: 'Never submitted.' });
    ids.folder = ok(await call('instructor', 'POST', `/courses/${ids.courseA}/sections/${ids.unit1}/resource-folders`, { title: 'Readings' }), 201).id;
    ids.link = await create(ids.courseA, ids.unit1, { type: 'link', title: 'ITIL video', url: 'https://www.example.org/itil-video', description: 'Short overview.', kind: 'video', folderId: ids.folder });
    await approve(ids.courseA, ids.link);
    ids.document = await upload(ids.courseA, ids.unit1, 'instructor', 'value-chain.pdf', 'Service value chain overview');
    await approve(ids.courseA, ids.document);
    ok(await call('instructor', 'PUT', `/courses/${ids.courseA}/activities/${ids.document}/organization`, { folderId: ids.folder }));
    ids.quiz = await create(ids.courseA, ids.unit3, { type: 'quiz', title: 'Checkpoint quiz', instructions: 'Answer all questions.', attemptLimit: 2, timeLimitMinutes: 20, passingScorePercent: 60, showFeedback: true });
    const question = async (body: object) => ok(await call('instructor', 'POST', `/courses/${ids.courseA}/activities/${ids.quiz}/questions`, body), 201);
    for (const body of [
      { type: 'single_choice', prompt: 'Which practice restores service?', points: 2, options: [{ text: 'Change enablement', isCorrect: false }, { text: 'Incident management', isCorrect: true }, { text: 'Service desk', isCorrect: false }] },
      { type: 'multiple_choice', prompt: 'Which are guiding principles?', points: 2, options: [{ text: 'Focus on value', isCorrect: true }, { text: 'Work in silos', isCorrect: false }, { text: 'Keep it simple and practical', isCorrect: true }] },
      { type: 'true_false', prompt: 'The service value chain has six activities.', points: 2, correctAnswer: true },
    ]) {
      await question(body);
    }
    await approve(ids.courseA, ids.quiz);
    ids.assignment = await create(ids.courseA, ids.unit3, {
      type: 'assignment',
      title: 'Service map',
      instructions: 'Map one university service to the value chain.',
      dueAt: '2026-12-04T23:59:00.000Z',
      lateUntil: null,
      rubric: [{ title: 'Accuracy', description: 'Correct value-chain activities.', maxPoints: 12 }, { title: 'Clarity', maxPoints: 8 }],
    });
    await approve(ids.courseA, ids.assignment);
    ids.returned = await create(ids.courseA, ids.unit2, { type: 'page', title: 'Facilitator notes', body: 'Notes for the teaching team.' });
    ok(await call('instructor', 'POST', `/courses/${ids.courseA}/activities/${ids.returned}/submit`));
    ok(await call('reviewer', 'POST', `/courses/${ids.courseA}/activities/${ids.returned}/review`, { decision: 'return', comment: 'REVIEW-COMMENT-PRIVATE: add the timing.' }));

    // Student work in course A, which must never appear in a package.
    ok(await call('student', 'PUT', `/courses/${ids.courseA}/activities/${ids.welcome}/completion`));
    const attempt = ok(await call('student', 'POST', `/courses/${ids.courseA}/activities/${ids.quiz}/attempts`), 201);
    ok(await call('student', 'POST', `/courses/${ids.courseA}/attempts/${attempt.id}/submit`, {}));
    ok(await call('student', 'POST', `/courses/${ids.courseA}/activities/${ids.assignment}/submissions`, { body: 'STUDENT-ESSAY-PRIVATE: my service map.' }), 201);
    // Unit 3 opens once unit 1 is complete (set after the student's work so the student could reach unit 3).
    ok(await call('admin', 'PUT', `/courses/${ids.courseA}/sections/${ids.unit3}/prerequisites`, { requiredSectionIds: [ids.unit1] }));

    // Course B: its own content, including a document, that must never leak into course A's package.
    const [unitB] = ok(await call('admin', 'GET', `/courses/${ids.courseB}/sections`)).items.map((s: { id: string }) => s.id);
    const otherPage = ok(await call('otherInstructor', 'POST', `/courses/${ids.courseB}/sections/${unitB}/activities`, { type: 'page', title: 'COURSE-B-ONLY page', body: 'COURSE-B-ONLY body.' }), 201).id;
    assert.ok(otherPage);
    const docB = await upload(ids.courseB, unitB, 'otherInstructor', 'course-b.pdf', 'COURSE-B-ONLY document');
    ids.courseBDocument = (await database.db.select({ id: courseDocuments.id }).from(courseDocuments).where(eq(courseDocuments.activityId, docB)))[0]!.id;
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (storageDir) await rm(join(storageDir, '..'), { recursive: true, force: true });
  });

  it('exports the whole course in order: units, prerequisites, folders, and every activity with its working and approved versions', async () => {
    const { res, pkg } = await exportOf('instructor', ids.courseA);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['content-disposition'], 'attachment; filename="course-ITIL-A.academiapath.json"');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual([pkg.format, pkg.formatVersion], ['academiapath.course-package', 1]);
    assert.match(pkg.contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(pkg.source, { courseCode: 'ITIL-A', courseStatus: 'published' });
    assert.equal(pkg.course.title, 'Template ITIL-F');

    const [u1, u2, u3] = pkg.course.units;
    assert.deepEqual(
      pkg.course.units.map((unit) => [unit.key, unit.title, unit.position, unit.visible, unit.requiresUnitKeys]),
      [
        ['unit-1', 'Unit 1 · Foundations', 0, true, []],
        ['unit-2', 'Unit 2 · Instructor notes', 1, false, []],
        ['unit-3', 'Unit 3 · Assessment', 2, true, ['unit-1']],
      ],
    );
    assert.deepEqual(u1!.folders, [{ key: 'folder-1', title: 'Readings', position: 0 }]);
    assert.deepEqual(u1!.activities.map((a) => [a.key, a.type, a.working.title, a.folderKey]), [
      ['activity-1', 'page', 'Welcome (revised)', null],
      ['activity-2', 'page', 'Draft only', null],
      ['activity-3', 'link', 'ITIL video', 'folder-1'],
      ['activity-4', 'file', 'Service value chain overview', 'folder-1'],
    ]);
    assert.deepEqual(u2!.activities.map((a) => [a.key, a.working.title, a.reviewStatus]), [['activity-5', 'Facilitator notes', 'returned']]);
    assert.deepEqual(u3!.activities.map((a) => [a.key, a.type]), [['activity-6', 'quiz'], ['activity-7', 'assignment']]);

    // Draft and approved content stay distinguishable.
    const welcome = activityIn(pkg, 'Welcome (revised)');
    assert.equal(welcome.reviewStatus, 'draft');
    assert.deepEqual(welcome.working, { title: 'Welcome (revised)', content: { body: 'Revised welcome text, not reviewed yet.' } });
    assert.deepEqual(welcome.approved, { title: 'Welcome', content: { body: 'Approved welcome text.' } });
    assert.equal(activityIn(pkg, 'Draft only').approved, null);
    assert.deepEqual(activityIn(pkg, 'ITIL video').approved!.content, { url: 'https://www.example.org/itil-video', description: 'Short overview.', kind: 'video' });

    const quiz = activityIn(pkg, 'Checkpoint quiz');
    const quizContent = quiz.approved!.content as Extract<NonNullable<PackageActivity['working']['content']>, { questions: unknown }>;
    assert.deepEqual(
      { ...quizContent, questions: undefined },
      { instructions: 'Answer all questions.', attemptLimit: 2, timeLimitMinutes: 20, shuffleQuestions: false, shuffleOptions: false, passingScorePercent: 60, showFeedback: true, questionsPerAttempt: null, questions: undefined },
    );
    assert.deepEqual(quizContent.questions, [
      { key: 'q1', type: 'single_choice', prompt: 'Which practice restores service?', points: 2, options: [{ key: 'o1', text: 'Change enablement' }, { key: 'o2', text: 'Incident management' }, { key: 'o3', text: 'Service desk' }], correctOptionKeys: ['o2'] },
      { key: 'q2', type: 'multiple_choice', prompt: 'Which are guiding principles?', points: 2, options: [{ key: 'o1', text: 'Focus on value' }, { key: 'o2', text: 'Work in silos' }, { key: 'o3', text: 'Keep it simple and practical' }], correctOptionKeys: ['o1', 'o3'] },
      { key: 'q3', type: 'true_false', prompt: 'The service value chain has six activities.', points: 2, options: [{ key: 'true', text: 'True' }, { key: 'false', text: 'False' }], correctOptionKeys: ['true'] },
    ]);
    assert.deepEqual(quiz.working.content, quiz.approved!.content, 'the working question bank matches the approved quiz');

    assert.deepEqual(activityIn(pkg, 'Service map').approved!.content, {
      instructions: 'Map one university service to the value chain.',
      dueAt: '2026-12-04T23:59:00.000Z',
      lateUntil: null,
      rubric: [
        { key: 'c1', title: 'Accuracy', description: 'Correct value-chain activities.', maxPoints: 12 },
        { key: 'c2', title: 'Clarity', description: null, maxPoints: 8 },
      ],
    });

    const [stored] = await database.db.select().from(courseDocuments).where(eq(courseDocuments.activityId, ids.document));
    assert.deepEqual(activityIn(pkg, 'Service value chain overview').approved!.content, { assetKey: 'asset-1', fileName: 'value-chain.pdf', format: 'pdf' });
    assert.deepEqual(pkg.assets, [{ key: 'asset-1', kind: 'document', fileName: 'value-chain.pdf', format: 'pdf', byteSize: stored!.byteSize, sha256: stored!.sha256, bundled: false }]);
    assert.deepEqual(pkg.warnings.map((w) => [w.code, w.target]), [['ASSET_NOT_BUNDLED', 'assets']]);
    assert.deepEqual(pkg.counts, { units: 3, folders: 1, activities: 7, approvedActivities: 5, questions: 3, assets: 1 });
    assert.ok(pkg.excludedData.includes('people') && pkg.excludedData.includes('grades') && pkg.excludedData.includes('file_bytes'));
  });

  it('authorizes the design team, instructors and administrators; refuses everyone else without revealing other courses', async () => {
    for (const who of ['reviewer', 'admin'] as const) assert.equal((await exportOf(who, ids.courseA)).pkg.counts.activities, 7, who);
    problem(await call('ta', 'GET', `/courses/${ids.courseA}/export`), 403, 'FORBIDDEN');
    problem(await call('student', 'GET', `/courses/${ids.courseA}/export`), 403, 'FORBIDDEN');
    problem(await call('otherInstructor', 'GET', `/courses/${ids.courseA}/export`), 404, 'NOT_FOUND');
    problem(await call('instructor', 'GET', `/courses/${ids.courseB}/export`), 404, 'NOT_FOUND');
    problem(await call('student', 'GET', `/courses/${ids.empty}/export`), 404, 'NOT_FOUND');
    problem(await call(null, 'GET', `/courses/${ids.courseA}/export`), 401, 'UNAUTHENTICATED');
    problem(await call('instructor', 'GET', '/courses/not-a-uuid/export'), 400, 'VALIDATION_ERROR');
    problem(await call('admin', 'GET', '/courses/00000000-0000-4000-8000-000000000000/export'), 404, 'NOT_FOUND');
    // Only reads are offered: there is no way to write through the export path.
    assert.equal((await call('instructor', 'POST', `/courses/${ids.courseA}/export`, {})).statusCode, 404);
  });

  it('never contains people, their work, review comments, database identifiers or another course', async () => {
    const { res, pkg } = await exportOf('admin', ids.courseA);
    const text = res.body;
    const people = await database.db.select({ id: users.id, email: users.email, familyName: users.familyName }).from(users);
    for (const person of people) {
      assert.ok(!text.includes(person.id), 'no user id');
      assert.ok(!text.toLowerCase().includes(person.email.toLowerCase()), `no email ${person.email}`);
    }
    for (const secret of ['STUDENT-ESSAY-PRIVATE', 'REVIEW-COMMENT-PRIVATE', 'COURSE-B-ONLY', PASSWORD, storageDir]) assert.ok(!text.includes(secret), secret);
    const [stored] = await database.db.select().from(courseDocuments).where(eq(courseDocuments.activityId, ids.document));
    assert.ok(!text.includes(stored!.storageKey), 'no storage key');
    assert.doesNotMatch(text, UUID, 'no database identifier of any kind');
    assert.ok(!text.includes('Value streams combine'), 'no extracted document text');
    assert.deepEqual(Object.keys(pkg).sort(), ['assets', 'contentHash', 'counts', 'course', 'excludedData', 'exportedAt', 'format', 'formatVersion', 'source', 'warnings']);
  });

  it('is stable: the same content gives the same package and hash; a content change gives a new hash', async () => {
    const first = await exportOf('instructor', ids.courseA);
    const second = await exportOf('reviewer', ids.courseA);
    const strip = (pkg: CoursePackage) => ({ ...pkg, exportedAt: undefined });
    assert.deepEqual(strip(second.pkg), strip(first.pkg));
    assert.equal(JSON.stringify(strip(second.pkg)), JSON.stringify(strip(first.pkg)), 'byte-identical apart from the export time');
    const page = await create(ids.courseA, ids.unit3, { type: 'page', title: 'Late addition', body: 'Added after the first export.' });
    const third = await exportOf('instructor', ids.courseA);
    assert.notEqual(third.pkg.contentHash, first.pkg.contentHash);
    assert.equal(activityIn(third.pkg, 'Late addition').key, 'activity-8');
    await database.db.delete(activities).where(eq(activities.id, page));
    assert.equal((await exportOf('instructor', ids.courseA)).pkg.contentHash, first.pkg.contentHash, 'removing it restores the original hash');
  });

  it('exports an empty course', async () => {
    const { pkg } = await exportOf('instructor', ids.empty);
    assert.deepEqual(pkg.course.units, []);
    assert.deepEqual(pkg.assets, []);
    assert.deepEqual(pkg.warnings, []);
    assert.deepEqual(pkg.counts, { units: 0, folders: 0, activities: 0, approvedActivities: 0, questions: 0, assets: 0 });
    assert.deepEqual(pkg.source, { courseCode: 'EMPTY-1', courseStatus: 'draft' });
  });

  it('exports a large course up to the activity limit and refuses one above it before reading content', async () => {
    const template = ok(await call('admin', 'POST', '/course-templates', { code: 'BIG-T', programId: ids.program, title: 'Big course', sections: Array.from({ length: 20 }, (_, n) => ({ title: `Unit ${n + 1}` })) }), 201).templateId;
    const big = ok(await call('admin', 'POST', '/courses', { programId: ids.program, termId: ids.term, templateId: template, code: 'BIG-1', status: 'draft' }), 201).id as string;
    ok(await call('admin', 'POST', `/courses/${big}/enrollments`, { email: EMAILS.instructor, role: 'instructor' }), 201);
    const units = (await database.db.select().from(sections).where(eq(sections.courseId, big))).sort((a, b) => a.position - b.position);
    // Seeded directly: the limit, not the authoring API, is under test.
    const rows = Array.from({ length: EXPORT_ACTIVITY_LIMIT }, (_, n) => ({
      sectionId: units[n % units.length]!.id,
      type: 'page' as const,
      title: `Lesson ${String(n + 1).padStart(4, '0')}`,
      position: Math.floor(n / units.length),
      config: { body: `Lesson ${n + 1}: ${'Synthetic course material. '.repeat(40)}` },
    }));
    for (let n = 0; n < rows.length; n += 250) await database.db.insert(activities).values(rows.slice(n, n + 250));
    const started = Date.now();
    const { res, pkg } = await exportOf('instructor', big);
    const elapsed = Date.now() - started;
    assert.equal(pkg.counts.activities, EXPORT_ACTIVITY_LIMIT);
    assert.equal(pkg.course.units[0]!.activities[1]!.working.title, 'Lesson 0021', 'course order: unit by unit, then position');
    assert.ok(Buffer.byteLength(res.body) < EXPORT_MAX_BYTES);
    assert.ok(elapsed < 15_000, `exported ${EXPORT_ACTIVITY_LIMIT} activities in ${elapsed} ms`);

    await database.db.insert(activities).values({ sectionId: units[0]!.id, type: 'page', title: 'One too many', position: 999, config: { body: 'x' } });
    const before = await database.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'course.exported'");
    problem(await call('instructor', 'GET', `/courses/${big}/export`), 422, 'COURSE_EXPORT_TOO_LARGE');
    const after = await database.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'course.exported'");
    assert.equal(after.rows[0]!.n, before.rows[0]!.n, 'a refused export is not recorded as an export');
  });

  it('reports missing files, invalid references and unsupported activities as warnings instead of failing', async () => {
    const template = ok(await call('admin', 'POST', '/course-templates', { code: 'REF-T', programId: ids.program, title: 'References', sections: [{ title: 'Only unit' }] }), 201).templateId;
    const refs = ok(await call('admin', 'POST', '/courses', { programId: ids.program, termId: ids.term, templateId: template, code: 'REF-1', status: 'draft' }), 201).id as string;
    for (const [person, role] of [['instructor', 'instructor'], ['reviewer', 'design_team']] as const) ok(await call('admin', 'POST', `/courses/${refs}/enrollments`, { email: EMAILS[person], role }), 201);
    const [unit] = (await database.db.select().from(sections).where(eq(sections.courseId, refs))).map((row) => row.id);
    const kept = await upload(refs, unit!, 'instructor', 'kept.pdf', 'Kept document');
    const lost = await upload(refs, unit!, 'instructor', 'lost.pdf', 'Lost document');
    const [lostRow] = await database.db.select().from(courseDocuments).where(eq(courseDocuments.activityId, lost));
    await rm(join(storageDir, lostRow!.storageKey));
    assert.ok((await readdir(storageDir)).length > 0);
    // A document activity pointing at another course's document (only possible through a damaged row).
    const foreign = await upload(refs, unit!, 'instructor', 'foreign.pdf', 'Foreign reference');
    const [foreignRow] = await database.db.select().from(activities).where(eq(activities.id, foreign));
    await database.db.update(activities).set({ config: { ...foreignRow!.config, documentId: ids.courseBDocument } }).where(eq(activities.id, foreign));
    // A quiz whose answer key names an option that no longer exists, and an activity type that is not portable yet.
    const quiz = ok(await call('instructor', 'POST', `/courses/${refs}/sections/${unit}/activities`, { type: 'quiz', title: 'Broken key quiz', attemptLimit: 1 }), 201).id;
    ok(await call('instructor', 'POST', `/courses/${refs}/activities/${quiz}/questions`, { type: 'single_choice', prompt: 'Pick one', points: 1, options: [{ text: 'A', isCorrect: true }, { text: 'B', isCorrect: false }] }), 201);
    await database.db.update(quizQuestions).set({ correctAnswer: { optionIds: ['gone'] } }).where(eq(quizQuestions.activityId, quiz));
    await database.db.insert(activities).values({ sectionId: unit!, type: 'lti', title: 'External tool', position: 50, config: { launchUrl: 'https://tool.example.org' } });

    const { pkg } = await exportOf('instructor', refs);
    assert.deepEqual(pkg.assets.map((asset) => asset.fileName), ['kept.pdf', 'lost.pdf'], 'the other course\'s document never becomes an asset');
    assert.deepEqual(activityIn(pkg, 'Kept document').working.content, { assetKey: 'asset-1', fileName: 'kept.pdf', format: 'pdf' });
    assert.deepEqual(activityIn(pkg, 'Foreign reference').working.content, { assetKey: null, fileName: 'foreign.pdf', format: 'pdf' });
    const broken = activityIn(pkg, 'Broken key quiz').working.content as { questions: Array<{ correctOptionKeys: string[] }> };
    assert.deepEqual(broken.questions[0]!.correctOptionKeys, []);
    const tool = activityIn(pkg, 'External tool');
    assert.deepEqual([tool.type, tool.working.content], ['lti', null]);
    assert.ok(!JSON.stringify(pkg).includes('tool.example.org'), 'unsupported configuration is not copied');
    const keyOf = (title: string) => activityIn(pkg, title).key;
    assert.deepEqual(
      pkg.warnings.map((w) => [w.code, w.target]),
      [
        ['ASSET_NOT_BUNDLED', 'assets'],
        ['INVALID_REFERENCE', `${keyOf('Foreign reference')}/working`],
        ['INVALID_REFERENCE', `${keyOf('Broken key quiz')}/working/q1`],
        ['UNSUPPORTED_ACTIVITY_TYPE', `${keyOf('External tool')}/working`],
        ['ASSET_MISSING', 'asset-2'],
      ],
    );
    assert.ok(kept);
  });

  it('changes nothing in the source course and audits each export with counts only', async () => {
    const before = await fingerprint();
    const auditBefore = await database.db.select().from(auditLog).where(eq(auditLog.action, 'course.exported'));
    const { pkg } = await exportOf('instructor', ids.courseA);
    await exportOf('admin', ids.courseA);
    assert.deepEqual(await fingerprint(), before, 'no table other than the audit log changed');
    const audits = await database.db.select().from(auditLog).where(eq(auditLog.action, 'course.exported'));
    assert.equal(audits.length, auditBefore.length + 2);
    const latest = audits.find((row) => row.actorUserId === sessions.get('instructor')!.userId && !auditBefore.some((old) => old.id === row.id))!;
    assert.equal(latest.entityId, ids.courseA);
    assert.deepEqual(latest.metadata, { before: null, after: { formatVersion: 1, contentHash: pkg.contentHash, ...pkg.counts, warnings: 1 } });
  });
});
