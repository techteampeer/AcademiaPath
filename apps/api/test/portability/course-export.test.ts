/**
 * AP-038A course content export (package format v1). Unit tests of the size guard, then API tests against a temporary
 * PostgreSQL database (skipped unless TEST_DATABASE_URL is set): authorized and refused callers, course boundaries,
 * completeness (units, prerequisites, folders, every activity type with working and approved versions, quiz answer
 * keys, rubrics, document references), stable serialization, empty and large courses, the activity limit, missing
 * files and invalid references, no personal or cross-course data, and no change to the source course. All accounts and
 * content are synthetic; every password is random per run.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
import { DOCUMENT_MEDIA_TYPES } from '../../src/documents/formats.js';
import { LocalDocumentStorage } from '../../src/documents/storage.js';
import { buildCourseArchive, CourseArchiveError, type ArchiveManifest } from '../../src/portability/course-archive.js';
import { scanArchive } from '../../src/scorm/archive.js';
import {
  buildCoursePackage,
  buildCoursePackageWithSources,
  EXPORT_ACTIVITY_LIMIT,
  EXPORT_MAX_BYTES,
  serializePackage,
  type CoursePackage,
  type PackageActivity,
} from '../../src/portability/course-package.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { makeDocx, makePdf, makePptx, multipartBody } from '../helpers/documents.js';
import { zipEntries } from '../helpers/zip.js';

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
  /** Used only by the archive rate-limit test, so no other request counts against its limit. */
  archiveUser: 'archive.user@academiapath.example',
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
  /** Runs before every storage read of the app under test: lets a test pause reads or make them fail. */
  let beforeRead: ((key: string) => Promise<void>) | null = null;
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
  const upload = async (courseId: string, sectionId: string, who: Person, filename: string, title: string, data?: Buffer, fileType?: string) => {
    const current = sessions.get(who)!;
    const file = data ?? makePdf([['Service value chain overview', 'Value streams combine activities to create value for customers.']]);
    const { payload, contentType } = multipartBody([{ name: 'title', value: title }, { name: 'file', filename, data: file, ...(fileType ? { contentType: fileType } : {}) }]);
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
    for (const email of [EMAILS.otherInstructor, EMAILS.archiveUser]) {
      const [other] = await database.db.insert(users).values({ email, givenName: 'Other', familyName: 'Instructor' }).returning();
      await database.db.insert(userCredentials).values({ userId: other!.id, passwordHash: await hashPassword(PASSWORD) });
    }
    const local = new LocalDocumentStorage(storageDir);
    const storage = {
      put: (bytes: Uint8Array) => local.put(bytes),
      remove: (key: string) => local.remove(key),
      exists: (key: string) => local.exists(key),
      read: async (key: string) => {
        if (beforeRead) await beforeRead(key);
        return local.read(key);
      },
    };
    app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir, DOCUMENT_MAX_UPLOAD_MB: '5' }), database: database.db, documents: { storage } });
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

  describe('document sources for the archive export (AP-038C1A)', () => {
    const NOW = new Date('2026-11-18T12:00:00.000Z');
    const storage = () => new LocalDocumentStorage(storageDir);
    /** Every stored document of a course's own activities, from the database (the expected mapping). */
    const documentsOf = async (courseId: string) =>
      database.db
        .select({ storageKey: courseDocuments.storageKey, fileName: courseDocuments.fileName, byteSize: courseDocuments.byteSize, sha256: courseDocuments.sha256 })
        .from(courseDocuments)
        .innerJoin(activities, eq(activities.id, courseDocuments.activityId))
        .innerJoin(sections, eq(sections.id, activities.sectionId))
        .where(eq(sections.courseId, courseId));
    const courseBStorageKey = async () => (await database.db.select({ key: courseDocuments.storageKey }).from(courseDocuments).where(eq(courseDocuments.id, ids.courseBDocument)))[0]!.key;

    it('leaves the JSON export byte-identical: same bytes and content hash as the builder and the export API', async () => {
      const plain = await buildCoursePackage(database.db, ids.courseA, storage(), NOW);
      const { packaged } = await buildCoursePackageWithSources(database.db, ids.courseA, storage(), NOW);
      assert.equal(serializePackage(packaged), serializePackage(plain));
      assert.equal(packaged.contentHash, plain.contentHash);
      // The API response is exactly the serialized package (built at the same export time).
      const { res, pkg } = await exportOf('instructor', ids.courseA);
      const atApiTime = await buildCoursePackageWithSources(database.db, ids.courseA, storage(), new Date(pkg.exportedAt));
      assert.equal(res.body, serializePackage(atApiTime.packaged));
    });

    it("maps exactly the package's assets to this course's own stored documents", async () => {
      const { packaged, sources } = await buildCoursePackageWithSources(database.db, ids.courseA, storage(), NOW);
      assert.deepEqual([...sources.keys()], packaged.assets.map((asset) => asset.key));
      const rows = await documentsOf(ids.courseA);
      assert.ok(packaged.assets.length > 0, 'course A has a document');
      for (const asset of packaged.assets) {
        const row = rows.find((candidate) => candidate.storageKey === sources.get(asset.key));
        assert.ok(row, `${asset.key} maps to a document of course A`);
        assert.deepEqual([row.fileName, row.byteSize, row.sha256], [asset.fileName, asset.byteSize, asset.sha256]);
      }
      assert.ok(![...sources.values()].includes(await courseBStorageKey()), "course B's document is never mapped");
    });

    it("never maps another course's document, keeps missing files mapped and reported as before, and never reveals a storage key", async () => {
      const template = ok(await call('admin', 'POST', '/course-templates', { code: 'SRC-T', programId: ids.program, title: 'Sources', sections: [{ title: 'Only unit' }] }), 201).templateId;
      const courseId = ok(await call('admin', 'POST', '/courses', { programId: ids.program, termId: ids.term, templateId: template, code: 'SRC-1', status: 'draft' }), 201).id as string;
      ok(await call('admin', 'POST', `/courses/${courseId}/enrollments`, { email: EMAILS.instructor, role: 'instructor' }), 201);
      const [unit] = (await database.db.select().from(sections).where(eq(sections.courseId, courseId))).map((row) => row.id);
      const kept = await upload(courseId, unit!, 'instructor', 'kept.pdf', 'Kept source');
      const lost = await upload(courseId, unit!, 'instructor', 'lost.pdf', 'Lost source');
      const storageKeyOf = async (activityId: string) => (await database.db.select().from(courseDocuments).where(eq(courseDocuments.activityId, activityId)))[0]!.storageKey;
      await rm(join(storageDir, await storageKeyOf(lost)));
      // A document activity pointing at course B's document (only possible through a damaged row).
      const foreign = await upload(courseId, unit!, 'instructor', 'foreign.pdf', 'Foreign source');
      const [foreignRow] = await database.db.select().from(activities).where(eq(activities.id, foreign));
      await database.db.update(activities).set({ config: { ...foreignRow!.config, documentId: ids.courseBDocument } }).where(eq(activities.id, foreign));

      const { packaged, sources } = await buildCoursePackageWithSources(database.db, courseId, storage(), NOW);
      assert.deepEqual(Object.fromEntries(sources), { 'asset-1': await storageKeyOf(kept), 'asset-2': await storageKeyOf(lost) });
      assert.ok(![...sources.values()].includes(await courseBStorageKey()), "the other course's document is not mapped");
      assert.deepEqual(activityIn(packaged, 'Foreign source').working.content, { assetKey: null, fileName: 'foreign.pdf', format: 'pdf' });

      // Missing files: same warnings as the JSON export (still described, reported missing); the export API agrees.
      const { res, pkg } = await exportOf('instructor', courseId);
      assert.deepEqual(
        pkg.warnings.map((w) => [w.code, w.target]),
        [
          ['ASSET_NOT_BUNDLED', 'assets'],
          ['INVALID_REFERENCE', `${activityIn(pkg, 'Foreign source').key}/working`],
          ['ASSET_MISSING', 'asset-2'],
        ],
      );
      assert.deepEqual(packaged.warnings, pkg.warnings);

      // Storage keys stay server-side: not in the export, its audit record, or the result if serialized by mistake.
      const secrets = [...sources.values(), await courseBStorageKey()];
      const audit = await database.db.select().from(auditLog).where(eq(auditLog.entityId, courseId));
      const result = await buildCoursePackageWithSources(database.db, courseId, storage(), NOW);
      for (const [where, text] of [
        ['export', res.body],
        ['audit', JSON.stringify(audit.map((row) => row.metadata))],
        ['serialized result', JSON.stringify(result)],
      ] as const) {
        for (const key of secrets) assert.ok(!text.includes(key), `${where} contains no storage key`);
      }
      assert.ok(!UUID.test(res.body), 'the export contains no database or storage identifier');
    });
  });

  describe('course archive from real courses (AP-038C1C)', () => {
    const NOW = new Date('2026-11-19T12:00:00.000Z');
    /** Local storage that records which files were read. */
    const recording = () => {
      const local = new LocalDocumentStorage(storageDir);
      const reads: string[] = [];
      return { reads, exists: (key: string) => local.exists(key), read: (key: string) => (reads.push(key), local.read(key)) };
    };
    const newCourse = async (code: string) => {
      const template = ok(await call('admin', 'POST', '/course-templates', { code: `${code}-T`, programId: ids.program, title: `Archive ${code}`, sections: [{ title: 'Only unit' }] }), 201).templateId;
      const courseId = ok(await call('admin', 'POST', '/courses', { programId: ids.program, termId: ids.term, templateId: template, code, status: 'draft' }), 201).id as string;
      ok(await call('admin', 'POST', `/courses/${courseId}/enrollments`, { email: EMAILS.instructor, role: 'instructor' }), 201);
      const [unit] = (await database.db.select().from(sections).where(eq(sections.courseId, courseId))).map((row) => row.id);
      return { courseId, unit: unit! };
    };
    const storedRow = async (activityId: string) => (await database.db.select().from(courseDocuments).where(eq(courseDocuments.activityId, activityId)))[0]!;

    it("course A: course.json is the export API's exact bytes; only course A's file is read and included; no keys, ids or learners", async () => {
      const { res, pkg } = await exportOf('instructor', ids.courseA);
      const storage = recording();
      const { archive, manifest } = await buildCourseArchive(database.db, ids.courseA, storage, new Date(pkg.exportedAt));
      const read = await zipEntries(archive);
      assert.deepEqual(read.map((entry) => entry.name), ['academiapath-archive.json', 'course.json', 'assets/asset-1.pdf']);
      assert.equal(read[1]!.data.toString('utf8'), res.body, 'course.json is byte-identical to the JSON export');
      const [documentA] = await database.db.select().from(courseDocuments).where(eq(courseDocuments.activityId, ids.document));
      assert.deepEqual(manifest.assets, [{ key: 'asset-1', path: 'assets/asset-1.pdf', format: 'pdf', byteSize: documentA!.byteSize, sha256: documentA!.sha256 }]);
      assert.deepEqual(storage.reads, [documentA!.storageKey], "only course A's own document is read");
      const [documentB] = await database.db.select().from(courseDocuments).where(eq(courseDocuments.id, ids.courseBDocument));
      const allKeys = (await database.db.select({ key: courseDocuments.storageKey }).from(courseDocuments)).map((row) => row.key);
      const people = (await database.db.select({ email: users.email }).from(users)).map((row) => row.email);
      for (const entry of read) {
        if (entry.name.startsWith('assets/')) continue;
        const text = entry.data.toString('utf8');
        assert.ok(!UUID.test(text), `${entry.name}: no database or storage identifier`);
        for (const value of [...allKeys, ...people, storageDir]) assert.ok(!text.includes(value), `${entry.name}: no storage key, account or path`);
      }
      // (The fixture uploads identical PDF bytes everywhere, so isolation is proven by what is read, not by hashes.)
      assert.ok(!storage.reads.includes(documentB!.storageKey), "course B's document is never read");
      assert.equal((await scanArchive(archive, { error: () => undefined })).safe, true);
      assert.ok(archive.equals((await buildCourseArchive(database.db, ids.courseA, recording(), new Date(pkg.exportedAt))).archive), 'deterministic');
    });

    it('PDF, DOCX and PPTX documents of a real course are archived with their stored bytes', async () => {
      const { courseId, unit } = await newCourse('ARC-1');
      const files = [
        { name: 'handout.pdf', data: makePdf([['Archive handout', 'Synthetic page.']]), type: DOCUMENT_MEDIA_TYPES.pdf },
        { name: 'notes.docx', data: makeDocx(['Synthetic notes for the archive.']), type: DOCUMENT_MEDIA_TYPES.docx },
        { name: 'slides.pptx', data: makePptx([['Synthetic archive slide']]), type: DOCUMENT_MEDIA_TYPES.pptx },
      ];
      for (const file of files) await upload(courseId, unit, 'instructor', file.name, `Archive ${file.name}`, file.data, file.type);
      const { archive, manifest } = await buildCourseArchive(database.db, courseId, recording(), NOW);
      assert.deepEqual(manifest.assets.map((asset) => asset.path), ['assets/asset-1.pdf', 'assets/asset-2.docx', 'assets/asset-3.pptx']);
      const read = await zipEntries(archive);
      for (const [index, file] of files.entries()) {
        const entry = read.find((candidate) => candidate.name === manifest.assets[index]!.path)!;
        assert.ok(entry.data.equals(file.data), `${file.name}: the stored bytes`);
      }
      assert.deepEqual((JSON.parse(read[0]!.data.toString('utf8')) as ArchiveManifest).totals, { assets: 3, assetBytes: files.reduce((sum, file) => sum + file.data.length, 0) });
    });

    it("an invalid reference is never read; a missing file fails the archive while the JSON export still reports it", async () => {
      const { courseId, unit } = await newCourse('ARC-2');
      const kept = await upload(courseId, unit, 'instructor', 'kept.pdf', 'Archive kept');
      const foreign = await upload(courseId, unit, 'instructor', 'foreign.pdf', 'Archive foreign');
      const [foreignRow] = await database.db.select().from(activities).where(eq(activities.id, foreign));
      await database.db.update(activities).set({ config: { ...foreignRow!.config, documentId: ids.courseBDocument } }).where(eq(activities.id, foreign));
      const [documentB] = await database.db.select().from(courseDocuments).where(eq(courseDocuments.id, ids.courseBDocument));

      const storage = recording();
      const { archive, manifest } = await buildCourseArchive(database.db, courseId, storage, NOW);
      assert.deepEqual(storage.reads, [(await storedRow(kept)).storageKey], "course B's document is never read");
      assert.deepEqual(manifest.assets.map((asset) => asset.key), ['asset-1']);
      const json = JSON.parse((await zipEntries(archive))[1]!.data.toString('utf8')) as CoursePackage;
      assert.ok(json.warnings.some((warning) => warning.code === 'INVALID_REFERENCE'), 'the invalid reference is reported in course.json, as in the JSON export');
      assert.ok(!storage.reads.includes(documentB!.storageKey));

      await rm(join(storageDir, (await storedRow(kept)).storageKey));
      await assert.rejects(buildCourseArchive(database.db, courseId, recording(), NOW), (error: unknown) => error instanceof CourseArchiveError && error.problem === 'ASSET_MISSING' && error.assetKey === 'asset-1');
      const { pkg } = await exportOf('instructor', courseId);
      assert.ok(pkg.warnings.some((warning) => warning.code === 'ASSET_MISSING' && warning.target === 'asset-1'), 'the JSON export is unchanged: it reports the missing file');
    });
  });

  describe('archive export API (AP-038C1D)', () => {
    const archiveUrl = (courseId: string) => `/courses/${courseId}/export/archive`;
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const archiveAudits = async (courseId: string) =>
      (await database.db.select().from(auditLog).where(eq(auditLog.action, 'course.archive_exported'))).filter((row) => row.entityId === courseId);
    const dedicatedCourse = async (code: string) => {
      const template = ok(await call('admin', 'POST', '/course-templates', { code: `${code}-T`, programId: ids.program, title: `Archive API ${code}`, sections: [{ title: 'Only unit' }] }), 201).templateId;
      const courseId = ok(await call('admin', 'POST', '/courses', { programId: ids.program, termId: ids.term, templateId: template, code, status: 'draft' }), 201).id as string;
      ok(await call('admin', 'POST', `/courses/${courseId}/enrollments`, { email: EMAILS.instructor, role: 'instructor' }), 201);
      const [unit] = (await database.db.select().from(sections).where(eq(sections.courseId, courseId))).map((row) => row.id);
      const activityId = await upload(courseId, unit!, 'instructor', 'archive-api.pdf', `Archive API ${code} handout`);
      const [document] = await database.db.select().from(courseDocuments).where(eq(courseDocuments.activityId, activityId));
      return { courseId, document: document! };
    };
    /** A problem response that reveals no storage key, path or file. */
    const safeProblem = (res: LightMyRequestResponse, status: number, code: string, secrets: string[]) => {
      problem(res, status, code);
      assert.match(String(res.headers['content-type']), /application\/problem\+json/);
      for (const secret of [...secrets, storageDir]) assert.ok(!res.body.includes(secret), `${code}: nothing internal in the response`);
    };

    it('returns a valid ZIP with the attachment headers; course.json equals the JSON export and every file matches the manifest', async () => {
      const res = await call('instructor', 'GET', archiveUrl(ids.courseA));
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.headers['content-type'], 'application/zip');
      assert.equal(res.headers['content-disposition'], 'attachment; filename="course-ITIL-A.academiapath.zip"');
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      const archive = res.rawPayload;
      const read = await zipEntries(archive);
      assert.deepEqual(read.map((entry) => entry.name), ['academiapath-archive.json', 'course.json', 'assets/asset-1.pdf']);
      const manifest = JSON.parse(read[0]!.data.toString('utf8')) as ArchiveManifest;
      const courseJson = read[1]!.data.toString('utf8');
      assert.equal(manifest.package.sha256, sha(read[1]!.data));
      for (const asset of manifest.assets) assert.equal(sha(read.find((entry) => entry.name === asset.path)!.data), asset.sha256, asset.path);
      // The JSON export at another moment differs only in exportedAt.
      const { res: json, pkg } = await exportOf('instructor', ids.courseA);
      const archivedAt = (JSON.parse(courseJson) as CoursePackage).exportedAt;
      assert.equal(courseJson.replace(`"exportedAt":"${archivedAt}"`, `"exportedAt":"${pkg.exportedAt}"`), json.body, 'course.json is the JSON export');
      const problems: string[] = [];
      assert.equal((await scanArchive(archive, { error: (p) => problems.push(p) })).safe, true);
      assert.deepEqual(problems, []);
    });

    it('authorizes the design team, instructors and administrators only; other courses stay invisible', async () => {
      for (const who of ['instructor', 'reviewer', 'admin'] as const) assert.equal((await call(who, 'GET', archiveUrl(ids.courseA))).statusCode, 200, who);
      for (const who of ['ta', 'student'] as const) problem(await call(who, 'GET', archiveUrl(ids.courseA)), 403, 'FORBIDDEN');
      problem(await call('otherInstructor', 'GET', archiveUrl(ids.courseA)), 404, 'NOT_FOUND');
      problem(await call('instructor', 'GET', archiveUrl(ids.courseB)), 404, 'NOT_FOUND');
      problem(await call(null, 'GET', archiveUrl(ids.courseA)), 401, 'UNAUTHENTICATED');
    });

    it('exports an empty course as the manifest and course.json only', async () => {
      const res = await call('admin', 'GET', archiveUrl(ids.empty));
      assert.equal(res.statusCode, 200, res.body);
      const read = await zipEntries(res.rawPayload);
      assert.deepEqual(read.map((entry) => entry.name), ['academiapath-archive.json', 'course.json']);
      assert.deepEqual((JSON.parse(read[0]!.data.toString('utf8')) as ArchiveManifest).totals, { assets: 0, assetBytes: 0 });
    });

    it('fails closed with safe errors: unreadable storage, a changed file, a missing file; nothing is sent or audited', async () => {
      const { courseId, document } = await dedicatedCourse('ARC-API-1');
      const secrets = [document.storageKey, document.fileName];
      beforeRead = async () => Promise.reject(Object.assign(new Error(`EIO: i/o error, read ${storageDir}/${document.storageKey}`), { code: 'EIO' }));
      try {
        safeProblem(await call('instructor', 'GET', archiveUrl(courseId)), 503, 'DOCUMENT_STORAGE_UNAVAILABLE', secrets);
      } finally {
        beforeRead = null;
      }
      const path = join(storageDir, document.storageKey);
      await writeFile(path, Buffer.alloc(document.byteSize, 0x41));
      safeProblem(await call('instructor', 'GET', archiveUrl(courseId)), 500, 'COURSE_ARCHIVE_DOCUMENT_CORRUPT', secrets);
      await rm(path);
      safeProblem(await call('instructor', 'GET', archiveUrl(courseId)), 500, 'COURSE_ARCHIVE_DOCUMENT_MISSING', secrets);
      assert.deepEqual(await archiveAudits(courseId), [], 'a failed archive is not recorded as an export');
    });

    it('refuses a course above the 25 MB archive limit before reading any file; the JSON export stays available', async () => {
      const { courseId, document } = await dedicatedCourse('ARC-API-2');
      // Documents are immutable (database trigger), so the oversized document is a new row: a copy of the uploaded one
      // with a 26 MB recorded size and a storage key that has no file, which the activity then points to.
      const client = await database.pool.connect();
      try {
        await client.query('CREATE TEMP TABLE oversized AS SELECT * FROM course_documents WHERE id = $1', [document.id]);
        const { rows } = await client.query<{ id: string }>('UPDATE oversized SET id = gen_random_uuid(), storage_key = gen_random_uuid(), byte_size = $1 RETURNING id', [26 * 1024 * 1024]);
        await client.query('INSERT INTO course_documents SELECT * FROM oversized');
        await client.query('DROP TABLE oversized');
        const [activity] = await database.db.select().from(activities).where(eq(activities.id, document.activityId));
        await database.db.update(activities).set({ config: { ...activity!.config, documentId: rows[0]!.id } }).where(eq(activities.id, document.activityId));
      } finally {
        client.release();
      }
      const reads: string[] = [];
      beforeRead = async (key) => void reads.push(key);
      try {
        safeProblem(await call('instructor', 'GET', archiveUrl(courseId)), 422, 'COURSE_ARCHIVE_TOO_LARGE', [document.storageKey]);
      } finally {
        beforeRead = null;
      }
      assert.deepEqual(reads, [], 'no file was read');
      assert.equal((await call('instructor', 'GET', `/courses/${courseId}/export`)).statusCode, 200);
    });

    it('limits concurrent archives per instance: a third request while two are prepared gets 503 with Retry-After', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let waiting = 0;
      beforeRead = async () => {
        waiting += 1;
        await gate;
      };
      try {
        const first = call('instructor', 'GET', archiveUrl(ids.courseA));
        const second = call('admin', 'GET', archiveUrl(ids.courseA));
        for (let i = 0; i < 200 && waiting < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(waiting, 2, 'two archives are being prepared');
        const third = await call('reviewer', 'GET', archiveUrl(ids.courseA));
        problem(third, 503, 'COURSE_ARCHIVE_BUSY');
        assert.equal(third.headers['retry-after'], '30');
        release();
        assert.deepEqual([(await first).statusCode, (await second).statusCode], [200, 200]);
      } finally {
        release();
        beforeRead = null;
      }
      assert.equal((await call('reviewer', 'GET', archiveUrl(ids.courseA))).statusCode, 200, 'slots are released afterwards');
    });

    it('rate limits each user: the 11th archive request within 10 minutes gets 429', async () => {
      ok(await call('admin', 'POST', `/courses/${ids.courseB}/enrollments`, { email: EMAILS.archiveUser, role: 'instructor' }), 201);
      for (let n = 1; n <= 10; n += 1) assert.equal((await call('archiveUser', 'GET', archiveUrl(ids.courseB))).statusCode, 200, `request ${n}`);
      problem(await call('archiveUser', 'GET', archiveUrl(ids.courseB)), 429, 'RATE_LIMITED');
      assert.equal((await call('otherInstructor', 'GET', archiveUrl(ids.courseB))).statusCode, 200, 'the limit is per user');
    });

    it('audits each archive with counts and sizes only: no storage keys, file names, identifiers or content', async () => {
      const audits = await archiveAudits(ids.courseA);
      assert.ok(audits.length >= 1);
      const [documentA] = await database.db.select().from(courseDocuments).where(eq(courseDocuments.activityId, ids.document));
      for (const row of audits) {
        const after = (row.metadata as { after: Record<string, unknown> }).after;
        assert.deepEqual(Object.keys(after).sort(), ['activities', 'approvedActivities', 'archiveBytes', 'archiveFormatVersion', 'assetBytes', 'assets', 'contentHash', 'folders', 'formatVersion', 'questions', 'units', 'warnings']);
        const text = JSON.stringify(row.metadata);
        for (const secret of [documentA!.storageKey, documentA!.fileName, storageDir, 'Service value chain']) assert.ok(!text.includes(secret));
        assert.ok(!UUID.test(text), 'no identifier in the metadata');
      }
    });
  });
});
