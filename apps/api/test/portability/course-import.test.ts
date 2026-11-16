/**
 * AP-038B course package import against a temporary PostgreSQL database (skipped unless TEST_DATABASE_URL is set).
 * A source course with every content type, a folder, a prerequisite, a document and student work is exported with
 * AP-038A, previewed and imported as a new course, then exported again and compared semantically with the original.
 * Also covered: answer-key remapping, ordering, version choice, code conflicts and repeated confirmations, versions,
 * hashes, permissions, cross-course isolation, documents without files, malformed packages, size limits, rollback,
 * the draft and review workflow, and that no person or student work is ever imported. All data is synthetic.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { asc, count, eq, inArray } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { activities, activityCompletions, assignmentSubmissions, courseDocuments, courses, enrollments, quizAttempts, quizQuestions, resourceFolders, sectionPrerequisites, sections, users } from '../../src/db/schema/index.js';
import { analyzePackage, type ImportPreview } from '../../src/portability/course-import.js';
import { packageContentHash, type CoursePackage, type PackageActivity } from '../../src/portability/course-package.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { makePdf, multipartBody } from '../helpers/documents.js';

const PASSWORD = randomBytes(18).toString('base64url');
const COOKIE = 'ap_session';
const ORIGIN = 'http://localhost:3000';
const DUE = '2027-04-30T23:59:00.000Z';
const EMAILS = {
  admin: 'admin@academiapath.example',
  instructor: 'instructor@academiapath.example',
  reviewer: 'reviewer@academiapath.example',
  ta: 'ta@academiapath.example',
  student: 'student@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type ImportResult = { course: { id: string; code: string; title: string; status: string }; created: Record<string, number>; skipped: ImportPreview['skipped']; contentHash: string };

/** A package with `change` applied and its hash recomputed, as a well-formed (but different) export would be. */
function resealed(pkg: CoursePackage, change: (copy: CoursePackage) => void): CoursePackage {
  const copy = structuredClone(pkg);
  change(copy);
  copy.contentHash = packageContentHash(copy.course, copy.assets);
  return copy;
}

describe('course package analysis (no database)', () => {
  it('refuses non-packages, unknown formats and other versions without reading further', () => {
    for (const input of [null, [], 'text', 42]) assert.equal(analyzePackage(input).fatal, 'format');
    assert.equal(analyzePackage({ format: 'imscc' }).preview.errors[0]!.code, 'UNSUPPORTED_FORMAT');
    const v2 = analyzePackage({ format: 'academiapath.course-package', formatVersion: 2 });
    assert.deepEqual([v2.fatal, v2.preview.formatVersion, v2.preview.errors[0]!.code], ['version', 2, 'UNSUPPORTED_VERSION']);
  });
});

describe('course import API (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let storageDir: string;
  let source: CoursePackage;
  let codeSeq = 0;
  const sessions = new Map<Person, { token: string; csrf: string; userId: string }>();
  const ids = {} as Record<'program' | 'inactiveProgram' | 'term' | 'courseA' | 'courseB' | 'unit1' | 'unit2' | 'unit3' | 'folder' | 'welcome' | 'quiz' | 'document' | 'assignment', string>;

  const call = (who: Person | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const current = who ? sessions.get(who)! : null;
    return app.inject({
      method,
      url: `/api/v1${url}`,
      ...(payload !== undefined ? { payload: payload as object } : {}),
      cookies: current ? { [COOKIE]: current.token } : {},
      headers: { ...(method !== 'GET' && current ? { 'x-csrf-token': current.csrf, origin: ORIGIN } : {}), ...headers },
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
  const exportOf = async (who: Person, courseId: string) => ok(await call(who, 'GET', `/courses/${courseId}/export`)) as CoursePackage;
  const preview = async (pkg: unknown, who: Person = 'admin') => ok(await call(who, 'POST', '/course-imports/preview', pkg)) as ImportPreview;
  const nextCode = () => `IMP-${++codeSeq}`;
  const confirm = (pkg: unknown, extra: Record<string, unknown> = {}, who: Person = 'admin') =>
    call(who, 'POST', '/course-imports', { package: pkg, programId: ids.program, termId: ids.term, code: nextCode(), acknowledgeSkipped: true, assignmentDueAt: DUE, ...extra });
  const imported = async (pkg: unknown, extra: Record<string, unknown> = {}) => ok(await confirm(pkg, extra), 201) as ImportResult;
  const activityIn = (pkg: CoursePackage, title: string): PackageActivity => {
    const found = pkg.course.units.flatMap((unit) => unit.activities).find((activity) => activity.working.title === title || activity.approved?.title === title);
    assert.ok(found, `activity ${title}`);
    return found;
  };
  const tableCounts = async () => {
    const tables = ['courses', 'sections', 'section_prerequisites', 'resource_folders', 'activities', 'quiz_questions', 'course_documents', 'enrollments', 'users', 'quiz_attempts', 'assignment_submissions', 'activity_completions'];
    const { rows } = await database.pool.query<{ t: string; n: number }>(tables.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(' UNION ALL '));
    return Object.fromEntries(rows.map((row) => [row.t, row.n]));
  };
  const upload = async (courseId: string, sectionId: string, filename: string, title: string) => {
    const current = sessions.get('instructor')!;
    const { payload, contentType } = multipartBody([{ name: 'title', value: title }, { name: 'file', filename, data: makePdf([['Service value chain', 'Value streams combine activities to create value.']]) }]);
    const res = await app.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/sections/${sectionId}/documents`, payload, cookies: { [COOKIE]: current.token }, headers: { 'content-type': contentType, 'x-csrf-token': current.csrf, origin: ORIGIN } });
    return ok(res, 201).activityId as string;
  };

  before(async () => {
    storageDir = join(await mkdtemp(join(tmpdir(), 'ap-import-test-')), 'store');
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir, DOCUMENT_MAX_UPLOAD_MB: '5' }), database: database.db });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAILS[person], password: PASSWORD }, headers: { origin: ORIGIN } });
      const body = ok(res);
      sessions.set(person, { token: res.cookies.find((c) => c.name === COOKIE)!.value, csrf: body.csrfToken, userId: body.user.id });
    }
    ids.program = ok(await call('admin', 'POST', '/programs', { code: 'ING-SIS', name: 'Ingeniería de Sistemas' }), 201).id;
    ids.inactiveProgram = ok(await call('admin', 'POST', '/programs', { code: 'OLD', name: 'Closed program' }), 201).id;
    ok(await call('admin', 'PUT', `/programs/${ids.inactiveProgram}`, { name: 'Closed program', isActive: false }));
    ids.term = ok(await call('admin', 'POST', '/terms', { code: '2027-1', name: '2027-I', startsOn: '2027-03-15', endsOn: '2027-07-10' }), 201).id;
    const template = ok(await call('admin', 'POST', '/course-templates', { code: 'ITIL-F', programId: ids.program, title: 'ITIL Fundamentals', sections: [{ title: 'Unit 1 · Foundations' }, { title: 'Unit 2 · Notes', isVisible: false }, { title: 'Unit 3 · Assessment' }] }), 201).templateId;
    const course = async (code: string) => ok(await call('admin', 'POST', '/courses', { programId: ids.program, termId: ids.term, templateId: template, code, status: 'published' }), 201).id as string;
    ids.courseA = await course('ITIL-A');
    ids.courseB = await course('ITIL-B');
    for (const [person, role] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['ta', 'non_editing_instructor'], ['student', 'student']] as const) {
      ok(await call('admin', 'POST', `/courses/${ids.courseA}/enrollments`, { email: EMAILS[person], role }), 201);
    }
    [ids.unit1, ids.unit2, ids.unit3] = ok(await call('admin', 'GET', `/courses/${ids.courseA}/sections`)).items.map((s: { id: string }) => s.id);
    const create = async (sectionId: string, body: object) => ok(await call('instructor', 'POST', `/courses/${ids.courseA}/sections/${sectionId}/activities`, body), 201).id as string;
    const approve = async (activityId: string) => {
      ok(await call('instructor', 'POST', `/courses/${ids.courseA}/activities/${activityId}/submit`));
      ok(await call('reviewer', 'POST', `/courses/${ids.courseA}/activities/${activityId}/review`, { decision: 'approve' }));
    };
    ids.welcome = await create(ids.unit1, { type: 'page', title: 'Welcome', body: 'Approved welcome text.' });
    await approve(ids.welcome);
    ok(await call('instructor', 'PUT', `/courses/${ids.courseA}/activities/${ids.welcome}`, { title: 'Welcome (revised)', body: 'Revised welcome text.' }));
    await create(ids.unit1, { type: 'page', title: 'Draft only', body: 'Never submitted.' });
    ids.folder = ok(await call('instructor', 'POST', `/courses/${ids.courseA}/sections/${ids.unit1}/resource-folders`, { title: 'Readings' }), 201).id;
    await approve(await create(ids.unit1, { type: 'link', title: 'ITIL video', url: 'https://www.example.org/itil-video', description: 'Short overview.', kind: 'video', folderId: ids.folder }));
    ids.document = await upload(ids.courseA, ids.unit1, 'value-chain.pdf', 'Service value chain overview');
    await approve(ids.document);
    await create(ids.unit2, { type: 'page', title: 'Facilitator notes', body: 'For the teaching team.' });
    ids.quiz = await create(ids.unit3, { type: 'quiz', title: 'Checkpoint quiz', instructions: 'Answer all questions.', attemptLimit: 2, timeLimitMinutes: 20, passingScorePercent: 60, showFeedback: true });
    for (const body of [
      { type: 'single_choice', prompt: 'Which practice restores service?', points: 2, options: [{ text: 'Change enablement', isCorrect: false }, { text: 'Incident management', isCorrect: true }, { text: 'Service desk', isCorrect: false }] },
      { type: 'multiple_choice', prompt: 'Which are guiding principles?', points: 2, options: [{ text: 'Focus on value', isCorrect: true }, { text: 'Work in silos', isCorrect: false }, { text: 'Keep it simple and practical', isCorrect: true }] },
      { type: 'true_false', prompt: 'The service value chain has six activities.', points: 2, correctAnswer: true },
    ]) {
      ok(await call('instructor', 'POST', `/courses/${ids.courseA}/activities/${ids.quiz}/questions`, body), 201);
    }
    await approve(ids.quiz);
    ids.assignment = await create(ids.unit3, { type: 'assignment', title: 'Service map', instructions: 'Map one service.', dueAt: '2026-12-04T23:59:00.000Z', lateUntil: '2026-12-06T23:59:00.000Z', rubric: [{ title: 'Accuracy', description: 'Correct activities.', maxPoints: 12 }, { title: 'Clarity', maxPoints: 8 }] });
    await approve(ids.assignment);
    // Student work in the source course, which an import must never carry.
    ok(await call('student', 'PUT', `/courses/${ids.courseA}/activities/${ids.welcome}/completion`));
    const attempt = ok(await call('student', 'POST', `/courses/${ids.courseA}/activities/${ids.quiz}/attempts`), 201);
    ok(await call('student', 'POST', `/courses/${ids.courseA}/attempts/${attempt.id}/submit`, {}));
    ok(await call('student', 'POST', `/courses/${ids.courseA}/activities/${ids.assignment}/submissions`, { body: 'STUDENT-ESSAY-PRIVATE' }), 201);
    ok(await call('admin', 'PUT', `/courses/${ids.courseA}/sections/${ids.unit3}/prerequisites`, { requiredSectionIds: [ids.unit1] }));
    source = await exportOf('instructor', ids.courseA);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (storageDir) await rm(join(storageDir, '..'), { recursive: true, force: true });
  });

  it('previews a package without writing anything: counts, documents, what is skipped and what is required', async () => {
    const before = await tableCounts();
    const result = await preview(source);
    assert.deepEqual(await tableCounts(), before, 'a preview creates nothing');
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual([result.format, result.formatVersion, result.hashVerified, result.contentHash], ['academiapath.course-package', 1, true, source.contentHash]);
    assert.deepEqual([result.source.title, result.source.courseCode], ['ITIL Fundamentals', 'ITIL-A']);
    assert.deepEqual(result.counts, { units: 3, folders: 1, activities: 7, activitiesByType: { page: 3, link: 1, file: 1, quiz: 1, assignment: 1 }, questions: 3, importableActivities: 6, skippedActivities: 1, assignments: 1 });
    assert.deepEqual(result.documents.map((d) => [d.assetKey, d.fileName, d.availability, d.activityKeys]), [['asset-1', 'value-chain.pdf', 'not_bundled', [activityIn(source, 'Service value chain overview').key]]]);
    assert.deepEqual(result.skipped, [{ key: activityIn(source, 'Service value chain overview').key, unitKey: 'unit-1', type: 'file', title: 'Service value chain overview', reason: 'DOCUMENT_NOT_BUNDLED' }]);
    assert.deepEqual([result.requiresAcknowledgement, result.requiresDueDate, result.errors, result.unsupportedFields], [true, true, [], []]);
  });

  it('round trip: the imported course matches the export, as new draft content with fresh identifiers', async () => {
    const result = await imported(source);
    assert.deepEqual(result.created, { units: 3, folders: 1, prerequisites: 1, activities: 6, questions: 3 });
    assert.equal(result.course.status, 'draft');
    const copy = await exportOf('admin', result.course.id);
    assert.deepEqual(copy.source, { courseCode: result.course.code, courseStatus: 'draft' });
    assert.deepEqual([copy.course.title, copy.course.description], [source.course.title, source.course.description]);
    // Units, order, visibility, prerequisites and folders are preserved.
    assert.deepEqual(
      copy.course.units.map((u) => [u.key, u.title, u.summary, u.visible, u.requiresUnitKeys, u.folders.map((f) => f.title)]),
      source.course.units.map((u) => [u.key, u.title, u.summary, u.visible, u.requiresUnitKeys, u.folders.map((f) => f.title)]),
    );
    const folderTitle = (pkg: CoursePackage, key: string | null) => (key ? pkg.course.units.flatMap((u) => u.folders).find((f) => f.key === key)!.title : null);
    for (const [index, unit] of source.course.units.entries()) {
      const expected = unit.activities.filter((a) => a.type !== 'file');
      const actual = copy.course.units[index]!.activities;
      assert.deepEqual(actual.map((a) => a.working.title), expected.map((a) => (a.approved ?? a.working).title), `${unit.key}: order and titles`);
      for (const [n, original] of expected.entries()) {
        const copied = actual[n]!;
        const chosen = original.approved ?? original.working;
        assert.deepEqual([copied.type, copied.visible, folderTitle(copy, copied.folderKey)], [original.type, original.visible, folderTitle(source, original.folderKey)]);
        // Every imported activity is a draft for this institution's review: no approval travels with it.
        assert.deepEqual([copied.reviewStatus, copied.approved], ['draft', null]);
        if (original.type === 'assignment') {
          assert.deepEqual(copied.working.content, { ...(chosen.content as object), dueAt: DUE, lateUntil: null }, 'dates are reset, nothing else changes');
        } else {
          assert.deepEqual(copied.working.content, chosen.content, `${original.key} content`);
        }
      }
    }
  });

  it('remaps quiz answer keys to fresh option ids that still mark the same answers', async () => {
    const result = await imported(source);
    const [quiz] = (await database.db.select({ activity: activities }).from(activities).innerJoin(sections, eq(sections.id, activities.sectionId)).where(eq(sections.courseId, result.course.id)))
      .map((row) => row.activity)
      .filter((activity) => activity.type === 'quiz');
    const original = await database.db.select().from(quizQuestions).where(eq(quizQuestions.activityId, ids.quiz)).orderBy(asc(quizQuestions.position));
    const copied = await database.db.select().from(quizQuestions).where(eq(quizQuestions.activityId, quiz!.id)).orderBy(asc(quizQuestions.position));
    assert.equal(copied.length, original.length);
    const correctTexts = (q: (typeof original)[number]) => q.options.filter((o) => q.correctAnswer.optionIds.includes(o.id)).map((o) => o.text);
    for (const [index, question] of copied.entries()) {
      const from = original[index]!;
      assert.deepEqual([question.type, question.prompt, question.points, question.options.map((o) => o.text)], [from.type, from.prompt, from.points, from.options.map((o) => o.text)]);
      assert.deepEqual(correctTexts(question), correctTexts(from), 'the same options are correct');
      assert.notEqual(question.id, from.id);
      if (question.type !== 'true_false') {
        for (const option of question.options) assert.ok(!from.options.some((o) => o.id === option.id), 'option ids are fresh');
      }
    }
    assert.equal(quiz!.reviewStatus, 'draft');
    assert.equal(quiz!.approvedConfig, null);
  });

  it('imports the approved version by default, or the authors\' working copy when asked', async () => {
    const approved = await exportOf('admin', (await imported(source)).course.id);
    const working = await exportOf('admin', (await imported(source, { versionPreference: 'working' })).course.id);
    assert.deepEqual(activityIn(approved, 'Welcome').working.content, { body: 'Approved welcome text.' });
    assert.deepEqual(activityIn(working, 'Welcome (revised)').working.content, { body: 'Revised welcome text.' });
    assert.equal(activityIn(approved, 'Draft only').working.title, 'Draft only', 'never-approved content comes from its working copy');
  });

  it('never overwrites a course: a taken code is refused and repeated or concurrent confirmations create one course', async () => {
    const counts = await tableCounts();
    problem(await call('admin', 'POST', '/course-imports', { package: source, programId: ids.program, termId: ids.term, code: 'ITIL-A', acknowledgeSkipped: true, assignmentDueAt: DUE }), 409, 'COURSE_CODE_TAKEN');
    assert.deepEqual(await tableCounts(), counts, 'nothing was written');
    const body = { package: source, programId: ids.program, termId: ids.term, code: 'IMP-TWICE', acknowledgeSkipped: true, assignmentDueAt: DUE };
    const results = await Promise.all([call('admin', 'POST', '/course-imports', body), call('admin', 'POST', '/course-imports', body)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
    problem(await call('admin', 'POST', '/course-imports', body), 409, 'COURSE_CODE_TAKEN');
    assert.equal((await database.db.select().from(courses).where(eq(courses.code, 'IMP-TWICE'))).length, 1);
    const [{ total } = { total: 0 }] = await database.db.select({ total: count() }).from(courses).where(eq(courses.id, ids.courseA));
    assert.equal(total, 1, 'the source course is untouched');
  });

  it('checks the format, version and content hash (with the export\'s canonical form, whatever the key order in the file)', async () => {
    const v2 = { ...source, formatVersion: 2 };
    assert.deepEqual((await preview(v2)).errors.map((e) => e.code), ['UNSUPPORTED_VERSION']);
    problem(await confirm(v2), 422, 'IMPORT_VERSION_UNSUPPORTED');
    problem(await confirm({ ...source, format: 'imscc' }), 422, 'IMPORT_PACKAGE_INVALID');

    const tampered = structuredClone(source);
    (activityIn(tampered, 'Draft only').working.content as { body: string }).body = 'Changed after export.';
    const result = await preview(tampered);
    assert.deepEqual([result.valid, result.hashVerified, result.errors.map((e) => e.code)], [false, false, ['HASH_MISMATCH']]);
    problem(await confirm(tampered), 422, 'IMPORT_HASH_MISMATCH');

    // The same content with every object's keys in reverse order still matches: the hash covers content, not layout.
    const reverse = (value: unknown): unknown =>
      Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverse(v)])) : value;
    const reordered = reverse(source);
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(source));
    assert.equal((await preview(reordered)).hashVerified, true);
  });

  it('allows administrators only: authors, non-editing instructors, students and anonymous callers are refused', async () => {
    const counts = await tableCounts();
    for (const who of ['instructor', 'reviewer', 'ta', 'student'] as const) {
      problem(await call(who, 'POST', '/course-imports/preview', source), 403, 'FORBIDDEN');
      problem(await confirm(source, {}, who), 403, 'FORBIDDEN');
    }
    problem(await call(null, 'POST', '/course-imports/preview', source), 401, 'UNAUTHENTICATED');
    problem(await call(null, 'POST', '/course-imports', { package: source }), 401, 'UNAUTHENTICATED');
    const admin = sessions.get('admin')!;
    const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/course-imports', payload: { package: source, programId: ids.program, termId: ids.term, code: 'NO-CSRF', acknowledgeSkipped: true, assignmentDueAt: DUE }, cookies: { [COOKIE]: admin.token }, headers: { origin: ORIGIN } });
    problem(noCsrf, 403, 'CSRF_TOKEN_INVALID');
    problem(await call('admin', 'POST', '/course-imports/preview', source, { origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
    assert.deepEqual(await tableCounts(), counts, 'refused requests write nothing');
  });

  it('keeps courses isolated: keys are never database ids, and references outside the package are refused', async () => {
    const [folderB] = await database.db.insert(resourceFolders).values({ courseId: ids.courseB, sectionId: (await database.db.select().from(sections).where(eq(sections.courseId, ids.courseB)))[0]!.id, title: 'Course B folder', position: 0 }).returning();
    const bBefore = await database.pool.query('SELECT count(*)::int AS n FROM sections WHERE course_id = $1', [ids.courseB]);
    // A package whose keys are real database ids of course A: they are labels only, and new rows get new ids.
    const unitIds = [ids.unit1, ids.unit2, ids.unit3];
    const disguised = resealed(source, (copy) => {
      copy.course.units.forEach((unit, index) => {
        unit.key = unitIds[index]!;
        unit.requiresUnitKeys = unit.requiresUnitKeys.map((key) => unitIds[Number(key.slice(5)) - 1]!);
      });
      const unit1 = copy.course.units[0]!;
      unit1.folders[0]!.key = ids.folder;
      for (const activity of unit1.activities) if (activity.folderKey) activity.folderKey = ids.folder;
    });
    const result = await imported(disguised);
    const newUnits = await database.db.select().from(sections).where(eq(sections.courseId, result.course.id));
    assert.equal(newUnits.length, 3);
    for (const unit of newUnits) assert.ok(!unitIds.includes(unit.id), 'fresh unit ids');
    const [newFolder] = await database.db.select().from(resourceFolders).where(eq(resourceFolders.courseId, result.course.id));
    assert.notEqual(newFolder!.id, ids.folder);
    const prerequisites = await database.db.select().from(sectionPrerequisites).where(eq(sectionPrerequisites.courseId, result.course.id));
    assert.ok(prerequisites.every((p) => newUnits.some((u) => u.id === p.sectionId) && newUnits.some((u) => u.id === p.requiredSectionId)), 'prerequisites stay inside the new course');

    // A reference to another course's folder is not a key of the package: refused.
    const foreign = resealed(source, (copy) => {
      for (const activity of copy.course.units[0]!.activities) if (activity.folderKey) activity.folderKey = folderB!.id;
    });
    const refused = await preview(foreign);
    assert.equal(refused.valid, false);
    assert.ok(refused.errors.some((e) => e.code === 'UNKNOWN_REFERENCE' && e.path.endsWith('.folderKey')));
    problem(await confirm(foreign), 422, 'IMPORT_PACKAGE_INVALID');
    const crossUnit = resealed(source, (copy) => {
      copy.course.units[2]!.activities[0]!.folderKey = 'folder-1';
    });
    assert.ok((await preview(crossUnit)).errors.some((e) => e.code === 'UNKNOWN_REFERENCE'), 'a folder of another unit is refused too');
    assert.deepEqual((await database.pool.query('SELECT count(*)::int AS n FROM sections WHERE course_id = $1', [ids.courseB])).rows, bBefore.rows);
  });

  it('never invents documents: without acknowledgement the import is refused; with it, exactly the document activities are skipped', async () => {
    const counts = await tableCounts();
    problem(await confirm(source, { acknowledgeSkipped: false }), 422, 'IMPORT_ACKNOWLEDGEMENT_REQUIRED');
    assert.deepEqual(await tableCounts(), counts);
    const missing = resealed(source, (copy) => void copy.warnings.push({ code: 'ASSET_MISSING', target: 'asset-1', detail: 'not found' }));
    assert.equal((await preview(missing)).documents[0]!.availability, 'missing_at_source');
    const result = await imported(source);
    assert.deepEqual(result.skipped.map((s) => [s.title, s.reason]), [['Service value chain overview', 'DOCUMENT_NOT_BUNDLED']]);
    const rows = await database.db.select({ type: activities.type }).from(activities).innerJoin(sections, eq(sections.id, activities.sectionId)).where(eq(sections.courseId, result.course.id));
    assert.ok(!rows.some((row) => row.type === 'file'), 'no document activity without its file');
    assert.equal((await tableCounts()).course_documents, counts.course_documents, 'no document record is created');
    // Activity types that are not portable yet are skipped the same way, and named.
    const withTool = resealed(source, (copy) => {
      copy.course.units[2]!.activities.push({ key: 'activity-99', type: 'lti', position: 9, visible: true, folderKey: null, reviewStatus: 'draft', working: { title: 'External tool', content: null }, approved: null });
    });
    assert.deepEqual((await preview(withTool)).skipped.map((s) => [s.key, s.reason]).at(-1), ['activity-99', 'UNSUPPORTED_ACTIVITY_TYPE']);
  });

  it('refuses malformed packages with a precise reason, and ignores (but reports) fields it does not know', async () => {
    const raw = await app.inject({ method: 'POST', url: '/api/v1/course-imports/preview', payload: '{"format": "academiapath.course-package", ', cookies: { [COOKIE]: sessions.get('admin')!.token }, headers: { 'content-type': 'application/json', 'x-csrf-token': sessions.get('admin')!.csrf, origin: ORIGIN } });
    problem(raw, 400, 'BAD_REQUEST');
    const cases: Array<[string, (copy: CoursePackage) => void, string]> = [
      ['javascript link', (c) => ((activityIn(c, 'ITIL video').approved!.content as { url: string }).url = 'javascript:alert(1)'), 'UNSAFE_URL'],
      ['plain http link', (c) => ((activityIn(c, 'ITIL video').working.content as { url: string }).url = 'http://www.example.org/x'), 'UNSAFE_URL'],
      ['unknown answer option', (c) => ((activityIn(c, 'Checkpoint quiz').approved!.content as { questions: Array<{ correctOptionKeys: string[] }> }).questions[0]!.correctOptionKeys = ['o9']), 'INVALID_ANSWER_KEY'],
      ['two answers to a single-choice question', (c) => ((activityIn(c, 'Checkpoint quiz').working.content as { questions: Array<{ correctOptionKeys: string[] }> }).questions[0]!.correctOptionKeys = ['o1', 'o2']), 'INVALID_ANSWER_KEY'],
      ['true/false without an answer', (c) => ((activityIn(c, 'Checkpoint quiz').working.content as { questions: Array<{ correctOptionKeys: string[] }> }).questions[2]!.correctOptionKeys = []), 'INVALID_ANSWER_KEY'],
      ['quiz attempt limit', (c) => ((activityIn(c, 'Checkpoint quiz').working.content as { attemptLimit: number }).attemptLimit = 99), 'OUT_OF_RANGE'],
      ['empty lesson', (c) => ((activityIn(c, 'Draft only').working.content as { body: string }).body = '  '), 'REQUIRED'],
      ['duplicate unit keys', (c) => (c.course.units[1]!.key = 'unit-1'), 'DUPLICATE_KEY'],
      ['prerequisite cycle', (c) => (c.course.units[0]!.requiresUnitKeys = ['unit-3']), 'PREREQUISITE_CYCLE'],
      ['unknown prerequisite', (c) => (c.course.units[1]!.requiresUnitKeys = ['unit-9']), 'UNKNOWN_REFERENCE'],
      ['unknown activity type', (c) => ((c.course.units[0]!.activities[0] as { type: string }).type = 'video'), 'INVALID_VALUE'],
      ['bundled asset claim', (c) => ((c.assets[0] as { bundled: boolean }).bundled = true), 'UNSUPPORTED_VALUE'],
      ['rubric points', (c) => ((activityIn(c, 'Service map').working.content as { rubric: Array<{ maxPoints: number }> }).rubric[0]!.maxPoints = 1000), 'OUT_OF_RANGE'],
    ];
    for (const [name, change, code] of cases) {
      const result = await preview(resealed(source, change));
      assert.equal(result.valid, false, name);
      assert.ok(result.errors.some((e) => e.code === code), `${name}: ${JSON.stringify(result.errors)}`);
    }
    // Unknown fields (for example people or grades smuggled into a package) are reported and never imported.
    const extra = { ...structuredClone(source), enrollments: [{ email: EMAILS.student, role: 'student' }], grades: [{ score: 20 }] };
    (extra.course.units[0]!.activities[0] as unknown as Record<string, unknown>).submissions = ['STUDENT-ESSAY-PRIVATE'];
    const result = await preview(extra);
    assert.equal(result.valid, true, 'unknown fields outside the hashed content do not invalidate a package');
    assert.deepEqual(result.unsupportedFields, ['$.enrollments', '$.grades', '$.course.units[0].activities[0].submissions']);
  });

  it('enforces size limits: the largest supported package imports, larger ones are refused', async () => {
    const big = resealed(source, (copy) => {
      const unit = copy.course.units[0]!;
      unit.activities = Array.from({ length: 1000 }, (_, n) => ({
        key: `activity-${n + 1}`,
        type: 'page' as const,
        position: n,
        visible: true,
        folderKey: null,
        reviewStatus: 'draft' as const,
        working: { title: `Lesson ${n + 1}`, content: { body: `Lesson ${n + 1}. ${'Synthetic material. '.repeat(40)}` } },
        approved: null,
      }));
      for (const other of copy.course.units.slice(1)) other.activities = [];
      copy.assets = [];
    });
    const started = Date.now();
    const result = await imported(big);
    assert.equal(result.created.activities, 1000);
    assert.ok(Date.now() - started < 30_000, `imported 1000 activities in ${Date.now() - started} ms`);
    const tooMany = resealed(big, (copy) => {
      copy.course.units[1]!.activities = [{ key: 'activity-1001', type: 'page', position: 0, visible: true, folderKey: null, reviewStatus: 'draft', working: { title: 'One too many', content: { body: 'x' } }, approved: null }];
    });
    assert.ok((await preview(tooMany)).errors.some((e) => e.code === 'TOO_MANY_ITEMS'));
    const oversized = { ...source, padding: 'x'.repeat(21 * 1024 * 1024) };
    problem(await call('admin', 'POST', '/course-imports/preview', oversized), 413, 'PAYLOAD_TOO_LARGE');
  });

  it('rolls back completely when the import fails part-way', async () => {
    const counts = await tableCounts();
    await database.pool.query(`CREATE FUNCTION fail_import_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.prompt = 'ROLLBACK-PROBE' THEN RAISE EXCEPTION 'probe'; END IF; RETURN NEW; END $$`);
    await database.pool.query('CREATE TRIGGER fail_import_probe BEFORE INSERT ON quiz_questions FOR EACH ROW EXECUTE FUNCTION fail_import_probe()');
    try {
      const probe = resealed(source, (copy) => {
        (activityIn(copy, 'Checkpoint quiz').approved!.content as { questions: Array<{ prompt: string }> }).questions[2]!.prompt = 'ROLLBACK-PROBE';
      });
      const res = await call('admin', 'POST', '/course-imports', { package: probe, programId: ids.program, termId: ids.term, code: 'ROLLBACK-1', acknowledgeSkipped: true, assignmentDueAt: DUE });
      problem(res, 500, 'INTERNAL_ERROR');
    } finally {
      await database.pool.query('DROP TRIGGER fail_import_probe ON quiz_questions; DROP FUNCTION fail_import_probe()');
    }
    assert.deepEqual(await tableCounts(), counts, 'no course, unit, folder, activity or question was left behind');
    assert.equal((await database.db.select().from(courses).where(eq(courses.code, 'ROLLBACK-1'))).length, 0);
    // Other refusals happen before anything is written.
    problem(await confirm(source, { programId: ids.inactiveProgram }), 422, 'PROGRAM_INACTIVE');
    problem(await confirm(source, { assignmentDueAt: undefined }), 422, 'IMPORT_DUE_DATE_REQUIRED');
    assert.deepEqual(await tableCounts(), counts);
  });

  it('creates a draft course whose content must go through review; nothing reaches students until then', async () => {
    const result = await imported(source);
    const [course] = await database.db.select().from(courses).where(eq(courses.id, result.course.id));
    assert.deepEqual([course!.status, course!.templateId], ['draft', null]);
    const rows = await database.db.select().from(activities).innerJoin(sections, eq(sections.id, activities.sectionId)).where(eq(sections.courseId, result.course.id));
    for (const { activities: row } of rows) assert.deepEqual([row.reviewStatus, row.approvedConfig, row.approvedAt, row.submittedAt, row.reviewedByUserId], ['draft', null, null, null, null]);
    for (const [person, role] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['student', 'student']] as const) {
      ok(await call('admin', 'POST', `/courses/${result.course.id}/enrollments`, { email: EMAILS[person], role }), 201);
    }
    problem(await call('student', 'GET', `/courses/${result.course.id}`), 404, 'NOT_FOUND');
    const page = rows.find(({ activities: row }) => row.type === 'page')!.activities;
    ok(await call('instructor', 'POST', `/courses/${result.course.id}/activities/${page.id}/submit`));
    ok(await call('reviewer', 'POST', `/courses/${result.course.id}/activities/${page.id}/review`, { decision: 'approve' }));
  });

  it('never imports people or their work, whatever the package contains', async () => {
    const before = await tableCounts();
    const result = await imported({ ...structuredClone(source), enrollments: [{ email: 'smuggled@academiapath.example', role: 'instructor' }], users: [{ email: 'smuggled@academiapath.example', password: 'Secret-123456' }] });
    const after = await tableCounts();
    assert.equal(after.users, before.users, 'no account created');
    for (const table of ['enrollments', 'quiz_attempts', 'assignment_submissions', 'activity_completions'] as const) assert.equal(after[table], before[table], table);
    assert.equal((await database.db.select().from(enrollments).where(eq(enrollments.courseId, result.course.id))).length, 0);
    assert.equal((await database.db.select().from(users).where(eq(users.email, 'smuggled@academiapath.example'))).length, 0);
    const copy = JSON.stringify(await exportOf('admin', result.course.id));
    assert.ok(!copy.includes('STUDENT-ESSAY-PRIVATE'));
    for (const email of Object.values(EMAILS)) assert.ok(!copy.includes(email));
    assert.equal((await database.db.select().from(quizAttempts).where(eq(quizAttempts.courseId, result.course.id))).length, 0);
    assert.equal((await database.db.select().from(activityCompletions).where(eq(activityCompletions.courseId, result.course.id))).length, 0);
    const importedActivities = (await database.db.select({ id: activities.id }).from(activities).innerJoin(sections, eq(sections.id, activities.sectionId)).where(eq(sections.courseId, result.course.id))).map((row) => row.id);
    assert.equal((await database.db.select().from(assignmentSubmissions).where(inArray(assignmentSubmissions.activityId, importedActivities))).length, 0);
    assert.equal((await database.db.select().from(courseDocuments).where(inArray(courseDocuments.activityId, importedActivities))).length, 0);
  });
});
