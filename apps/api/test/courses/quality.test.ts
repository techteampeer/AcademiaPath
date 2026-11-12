/**
 * AP-029 content quality checks on the synthetic demo dataset, against a temporary PostgreSQL database (skipped
 * unless TEST_DATABASE_URL is set): course and activity reports, blocking findings versus warnings, the server-side
 * submit and approve guard, rechecking after a correction, role permissions, privacy of reports and answer keys,
 * read-only behaviour, duplicate submissions and the unchanged review workflow.
 *
 * Invalid states the editors refuse to save (whitespace bodies, empty rubrics, broken answer keys, dangling document
 * references) can only come from legacy or imported data, so the tests create them directly in the database.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { ACCOUNTS, type Persona } from '../../scripts/demo/content.js';
import { seedDemo, type DemoReport } from '../../scripts/seed-demo.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { QUALITY_CODES, severityOf } from '../../src/quality/rules.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { makePdf, multipartBody } from '../helpers/documents.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const ITIL = 'ITIL4-F-2026-2-A';
const PMF = 'PMF-2026-2-A';
const FUTURE = '2030-06-01T17:00:00.000Z';

type App = ReturnType<typeof buildApp>;
type Session = { token: string; csrf: string };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Finding = { code: string; severity: string; target: string; sectionId: string | null; activityId: string | null; field: string | null; itemId: string | null; itemNumber: number | null; value: string | null };
type Report = {
  courseId: string;
  scope: string;
  activityId: string | null;
  checkedAt: string;
  limited: boolean;
  summary: { blocking: number; warnings: number; sections: number; activities: number; questions: number };
  sections: Array<{ id: string; title: string }>;
  activities: Array<{ id: string; title: string; reviewStatus: string }>;
  findings: Finding[];
};

describe('content quality checks (PostgreSQL, demo dataset)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let report: DemoReport;
  let app: App;
  const as = {} as Record<Persona, Session>;
  const ids = {} as Record<string, string>;

  const courseId = (code: string) => report.courses.find((c) => c.code === code)!.id;
  const C = () => courseId(ITIL);
  const request = (method: Method, url: string, options: { session?: Session; body?: unknown; csrf?: string | null } = {}) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: options.session ? { ap_session: options.session.token } : {},
      headers: { origin: ORIGIN, ...(options.session && method !== 'GET' && options.csrf !== null ? { 'x-csrf-token': options.csrf ?? options.session.csrf } : {}) },
      ...(options.body !== undefined ? { payload: options.body as object } : {}),
    });
  const call = (who: Persona, method: Method, url: string, body?: unknown) => request(method, url, { session: as[who], body });
  const ok = async <T = unknown>(who: Persona, method: Method, url: string, body?: unknown, status = 200): Promise<T> => {
    const res = await call(who, method, url, body);
    assert.equal(res.statusCode, status, `${method} ${url} as ${who}: ${res.body}`);
    return (res.body ? res.json() : null) as T;
  };
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };
  const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[];
  const count = async (sql: string, params: unknown[] = []) => Number((await query<{ n: number }>(sql, params))[0]!.n);

  const courseReport = (who: Persona = 'instructor', code = ITIL) => ok<Report>(who, 'GET', `/courses/${courseId(code)}/quality`);
  const activityReport = (activityId: string, who: Persona = 'instructor') => ok<Report>(who, 'GET', `/courses/${C()}/activities/${activityId}/quality`);
  const codes = (findings: Finding[], activityId?: string) => findings.filter((f) => !activityId || f.activityId === activityId).map((f) => f.code).sort();
  const create = (body: Record<string, unknown>, section = ids.section!) => ok<{ id: string }>('instructor', 'POST', `/courses/${C()}/sections/${section}/activities`, body, 201);
  const submit = (activityId: string, who: Persona = 'instructor') => call(who, 'POST', `/courses/${C()}/activities/${activityId}/submit`);
  const review = (activityId: string, decision: 'approve' | 'return', comment?: string) =>
    call('reviewer', 'POST', `/courses/${C()}/activities/${activityId}/review`, { decision, ...(comment ? { comment } : {}) });
  const question = (quizId: string, body: Record<string, unknown>) => ok<{ id: string }>('instructor', 'POST', `/courses/${C()}/activities/${quizId}/questions`, body, 201);
  const choice = (prompt: string, texts: string[], points = 2) => ({ type: 'single_choice', prompt, points, options: texts.map((text, index) => ({ text, isCorrect: index === 0 })) });
  /** Legacy or imported data the editors would refuse: written straight to the database. */
  const setConfig = (activityId: string, config: Record<string, unknown>) => query("UPDATE activities SET config = $2::jsonb WHERE id = $1", [activityId, JSON.stringify(config)]);
  const upload = (title: string, data: Buffer) => {
    const { payload, contentType } = multipartBody([{ name: 'title', value: title }, { name: 'file', filename: `${title}.pdf`, data }]);
    return app.inject({
      method: 'POST',
      url: `/api/v1/courses/${C()}/sections/${ids.section}/documents`,
      payload,
      cookies: { ap_session: as.instructor.token },
      headers: { 'content-type': contentType, 'x-csrf-token': as.instructor.csrf, origin: ORIGIN },
    });
  };

  before(async () => {
    database = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'ap-quality-'));
    const env = { NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: join(root, 'store') };
    report = await seedDemo(database.db, { password: PASSWORD, env, uploadFilesDir: null });
    app = buildApp({ config: { ...loadConfig(env), loginRateLimit: { max: 1000, windowMs: 60_000 } }, database: database.db });
    await app.ready();
    for (const persona of Object.keys(ACCOUNTS) as Persona[]) {
      const res = await request('POST', '/auth/login', { body: { email: ACCOUNTS[persona], password: PASSWORD } });
      assert.equal(res.statusCode, 200, res.body);
      as[persona] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken };
    }
    // A section of its own for the test content (sections are administrator-managed).
    ids.section = (await ok<{ id: string }>('admin', 'POST', `/courses/${C()}/sections`, { title: 'Quality checks', isVisible: true }, 201)).id;
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('1. valid content passes: clean lessons, links, quizzes and assignments have no findings', async () => {
    const lesson = await create({ type: 'page', title: 'Service value chain', body: 'The service value chain has six activities. See https://www.axelos.com/itil for the official glossary.' });
    const link = await create({ type: 'link', title: 'ITIL overview video', url: 'https://www.youtube.com/watch?v=itil-overview', kind: 'video', description: 'A ten-minute introduction with captions.' });
    const quiz = await create({ type: 'quiz', title: 'Check your understanding', attemptLimit: 2, instructions: 'Answer both questions.' });
    await question(quiz.id, choice('Which practice restores normal service operation?', ['Incident management', 'Change enablement', 'Problem management']));
    await question(quiz.id, { type: 'true_false', prompt: 'A service is a means of enabling value co-creation.', points: 2, correctAnswer: true });
    const assignment = await create({ type: 'assignment', title: 'Service map', instructions: 'Map one service of your organization.', dueAt: FUTURE, rubric: [{ title: 'Accuracy', maxPoints: 10 }] });
    for (const activity of [lesson, link, quiz, assignment]) {
      const result = await activityReport(activity.id);
      assert.deepEqual(result.findings, [], `${activity.id}: ${JSON.stringify(result.findings)}`);
      assert.deepEqual([result.scope, result.activityId, result.summary.blocking, result.summary.warnings], ['activity', activity.id, 0, 0]);
    }
    Object.assign(ids, { lesson: lesson.id, link: link.id, quiz: quiz.id, assignment: assignment.id });
    // The seeded demo content has no blocking finding: the live demo can be reviewed and approved as before.
    for (const code of [ITIL, PMF]) assert.equal((await courseReport('reviewer', code)).summary.blocking, 0, code);
    // Every reported code is a known code with the documented severity.
    const full = await courseReport();
    for (const finding of full.findings) {
      assert.ok((QUALITY_CODES as readonly string[]).includes(finding.code));
      assert.equal(finding.severity, severityOf(finding.code as (typeof QUALITY_CODES)[number]));
    }
    assert.deepEqual([full.scope, full.courseId, full.limited], ['course', C(), false]);
    assert.ok(full.activities.some((activity) => activity.id === lesson.id) && full.sections.some((section) => section.id === ids.section));
  });

  it('2. missing course information and structure are reported as warnings', async () => {
    const { version } = (await query<{ version: number }>('SELECT version FROM courses WHERE id = $1', [C()]))[0]!;
    await ok('admin', 'PUT', `/courses/${C()}`, { version, description: null });
    const emptySection = await ok<{ id: string }>('admin', 'POST', `/courses/${C()}/sections`, { title: 'Week 9 [insertar título]', isVisible: true }, 201);
    const result = await courseReport();
    const course = result.findings.filter((f) => f.target === 'course').map((f) => f.code);
    assert.ok(course.includes('COURSE_DESCRIPTION_MISSING'), JSON.stringify(result.findings));
    const sectionFindings = result.findings.filter((f) => f.sectionId === emptySection.id && f.target === 'section');
    assert.deepEqual(sectionFindings.map((f) => [f.code, f.severity, f.field]).sort(), [
      ['PLACEHOLDER_TEXT', 'warning', 'title'],
      ['SECTION_EMPTY', 'warning', 'activities'],
    ]);
    assert.equal(sectionFindings.find((f) => f.code === 'PLACEHOLDER_TEXT')!.value, '[insertar título]');
    // Prerequisites that hold nothing back: an empty required section counts as complete for students.
    await ok('admin', 'PUT', `/courses/${C()}/sections/${ids.section}/prerequisites`, { requiredSectionIds: [emptySection.id] });
    const withPrerequisite = await courseReport();
    const prerequisite = withPrerequisite.findings.find((f) => f.code === 'PREREQUISITE_SECTION_EMPTY');
    assert.deepEqual([prerequisite?.sectionId, prerequisite?.value, prerequisite?.severity], [ids.section, emptySection.id, 'warning']);
    await ok('admin', 'PUT', `/courses/${C()}/sections/${ids.section}/prerequisites`, { requiredSectionIds: [] });
    // None of these course-level warnings blocks the existing content workflow (checked in test 7).
    assert.ok(withPrerequisite.findings.filter((f) => f.target !== 'activity').every((f) => f.severity === 'warning'));
    const { version: v2 } = (await query<{ version: number }>('SELECT version FROM courses WHERE id = $1', [C()]))[0]!;
    await ok('admin', 'PUT', `/courses/${C()}`, { version: v2, description: 'Foundations of IT service management.' });
    assert.ok(!codes((await courseReport()).findings).includes('COURSE_DESCRIPTION_MISSING'));
    ids.emptySection = emptySection.id;
  });

  it('3. empty required content is detected as blocking (whitespace-only lesson, title and link URL)', async () => {
    const page = await create({ type: 'page', title: 'Legacy lesson', body: 'Imported text.' });
    await setConfig(page.id, { body: '   \n\t ' });
    await query("UPDATE activities SET title = '   ' WHERE id = $1", [page.id]);
    const link = await create({ type: 'link', title: 'Legacy link', url: 'https://example.edu/ok' });
    await setConfig(link.id, { url: 'javascript:alert(1)', description: null, kind: 'website' });
    const pageReport = await activityReport(page.id);
    assert.deepEqual(codes(pageReport.findings), ['ACTIVITY_TITLE_EMPTY', 'PAGE_BODY_EMPTY']);
    assert.ok(pageReport.findings.every((f) => f.severity === 'blocking' && f.target === 'activity' && f.sectionId === ids.section));
    assert.deepEqual(pageReport.findings.map((f) => f.field).sort(), ['body', 'title']);
    const linkFinding = (await activityReport(link.id)).findings;
    assert.deepEqual(linkFinding.map((f) => [f.code, f.severity, f.field, f.value]), [['LINK_URL_INVALID', 'blocking', 'url', 'javascript:alert(1)']]);
    Object.assign(ids, { emptyPage: page.id, badLink: link.id });
  });

  it('4. invalid quiz configuration is detected (no questions, pool, answer key, options, duplicates)', async () => {
    const empty = await create({ type: 'quiz', title: 'Empty quiz', attemptLimit: 1 });
    assert.deepEqual(codes((await activityReport(empty.id)).findings), ['QUIZ_NO_QUESTIONS']);
    // The existing submit rule keeps its own problem code.
    problem(await submit(empty.id), 422, 'QUIZ_HAS_NO_QUESTIONS');

    const pool = await create({ type: 'quiz', title: 'Pool quiz', attemptLimit: 1, questionsPerAttempt: 3 });
    await question(pool.id, choice('One?', ['A', 'B']));
    await question(pool.id, choice('Two?', ['A', 'B'], 5));
    const poolReport = await activityReport(pool.id);
    assert.deepEqual(codes(poolReport.findings), ['QUIZ_POOL_POINTS_MIXED', 'QUIZ_POOL_TOO_SMALL']);
    assert.equal(poolReport.findings.find((f) => f.code === 'QUIZ_POOL_TOO_SMALL')!.value, '3');
    problem(await submit(pool.id), 422, 'QUIZ_POOL_TOO_SMALL');

    const broken = await create({ type: 'quiz', title: 'Imported quiz', attemptLimit: 1 });
    const q1 = await question(broken.id, choice('First?', ['Yes', 'No']));
    const q2 = await question(broken.id, choice('Second?', ['Same', 'same', 'Other']));
    // An imported answer key pointing at an option that does not exist, and an option without text.
    await query(`UPDATE quiz_questions SET correct_answer = '{"optionIds": ["missing-option"]}'::jsonb WHERE id = $1`, [q1.id]);
    await query(`UPDATE quiz_questions SET options = jsonb_set(options, '{2,text}', '"  "') WHERE id = $1`, [q2.id]);
    const brokenReport = await activityReport(broken.id);
    assert.deepEqual(
      brokenReport.findings.map((f) => [f.code, f.severity, f.itemId, f.itemNumber]).sort(),
      [
        ['QUIZ_DUPLICATE_OPTIONS', 'warning', q2.id, 2],
        ['QUIZ_QUESTION_ANSWER_INVALID', 'blocking', q1.id, 1],
        ['QUIZ_QUESTION_OPTIONS_INCOMPLETE', 'blocking', q2.id, 2],
      ].sort(),
    );
    // Answer keys and option texts never appear in a report.
    const raw = JSON.stringify(brokenReport);
    assert.ok(!raw.includes('missing-option') && !raw.includes('correctAnswer') && !raw.includes('First?'));
    problem(await submit(broken.id), 422, 'QUALITY_CHECK_BLOCKED');
    ids.brokenQuiz = broken.id;
  });

  it('5. invalid assignment configuration is detected (instructions, rubric, dates) and a passed deadline is a warning', async () => {
    const legacy = await create({ type: 'assignment', title: 'Imported assignment', instructions: 'x', dueAt: FUTURE, rubric: [{ title: 'Quality', maxPoints: 10 }] });
    await setConfig(legacy.id, { instructions: ' ', dueAt: '2030-06-01T00:00:00.000Z', lateUntil: '2030-05-01T00:00:00.000Z', rubric: [] });
    assert.deepEqual(codes((await activityReport(legacy.id)).findings), ['ASSIGNMENT_DATES_INVALID', 'ASSIGNMENT_INSTRUCTIONS_EMPTY', 'ASSIGNMENT_RUBRIC_EMPTY']);
    const criterion = await create({ type: 'assignment', title: 'Imported rubric', instructions: 'Write.', dueAt: FUTURE, rubric: [{ title: 'A', maxPoints: 10 }, { title: 'B', maxPoints: 5 }] });
    const stored = (await query<{ config: { rubric: Array<Record<string, unknown>> } }>('SELECT config FROM activities WHERE id = $1', [criterion.id]))[0]!.config;
    stored.rubric[1]!.maxPoints = 0;
    await setConfig(criterion.id, stored);
    const rubricFinding = (await activityReport(criterion.id)).findings;
    assert.deepEqual(rubricFinding.map((f) => [f.code, f.severity, f.itemNumber]), [['ASSIGNMENT_RUBRIC_CRITERION_INVALID', 'blocking', 2]]);
    // A valid assignment whose submission window has already closed: a warning only.
    const past = await create({ type: 'assignment', title: 'Past assignment', instructions: 'Write.', dueAt: '2020-01-10T12:00:00.000Z', rubric: [{ title: 'A', maxPoints: 10 }] });
    const pastReport = await activityReport(past.id);
    assert.deepEqual(pastReport.findings.map((f) => [f.code, f.severity, f.value]), [['ASSIGNMENT_DEADLINE_PASSED', 'warning', '2020-01-10T12:00:00.000Z']]);
    Object.assign(ids, { legacyAssignment: legacy.id, pastAssignment: past.id });
  });

  it('6. document problems: a scan without text is a warning; a broken document reference is blocking', async () => {
    const scanned = await upload('Scanned handout', makePdf([[], []]));
    assert.equal(scanned.statusCode, 201, scanned.body);
    const scanId = scanned.json().activityId as string;
    assert.deepEqual((await activityReport(scanId)).findings.map((f) => [f.code, f.severity, f.value]), [['DOCUMENT_NO_TEXT', 'warning', 'Scanned handout.pdf']]);
    const good = await upload('Reading', makePdf([['Service management creates value for customers.']]));
    assert.equal(good.statusCode, 201, good.body);
    const goodId = good.json().activityId as string;
    assert.deepEqual((await activityReport(goodId)).findings, []);
    // A reference to a document of another activity (or one that does not exist) is blocking.
    const config = (await query<{ config: Record<string, unknown> }>('SELECT config FROM activities WHERE id = $1', [goodId]))[0]!.config;
    await setConfig(goodId, { ...config, documentId: randomUUID() });
    assert.deepEqual(codes((await activityReport(goodId)).findings), ['DOCUMENT_REFERENCE_INVALID']);
    await setConfig(goodId, config);
    assert.deepEqual((await activityReport(goodId)).findings, []);
    Object.assign(ids, { scan: scanId, document: goodId });
  });

  it('7. warnings never block: content with placeholders and insecure links is submitted and approved', async () => {
    const page = await create({
      type: 'page',
      title: 'Draft notes TODO',
      body: `Lorem ipsum dolor sit amet. Read http://example.edu/notes and javascript:openLesson first. Also see /courses/${C()}/activities/${randomUUID()}. Big data: an overview.`,
    });
    const link = await create({ type: 'link', title: 'Interactive model', url: 'https://phet.colorado.edu/sim', kind: 'interactive' });
    const result = await activityReport(page.id);
    assert.deepEqual(codes(result.findings), ['INTERNAL_LINK_BROKEN', 'PLACEHOLDER_TEXT', 'PLACEHOLDER_TEXT', 'TEXT_LINK_INSECURE', 'TEXT_LINK_UNSAFE_SCHEME']);
    assert.ok(result.findings.every((f) => f.severity === 'warning'));
    assert.deepEqual(
      result.findings.filter((f) => f.code === 'PLACEHOLDER_TEXT').map((f) => [f.field, f.value]).sort(),
      [['body', 'Lorem ipsum'], ['title', 'TODO']],
    );
    assert.equal(result.findings.find((f) => f.code === 'TEXT_LINK_UNSAFE_SCHEME')!.value, 'javascript:openLesson');
    assert.deepEqual(codes((await activityReport(link.id)).findings), ['LINK_MEDIA_DESCRIPTION_MISSING']);
    // Ordinary words are not placeholders ("todo" is Spanish for "everything"), and "data:" in prose is not a URL.
    const spanish = await create({ type: 'page', title: 'Resumen', body: 'Todo el módulo en una página. Big data: conceptos básicos.' });
    assert.deepEqual((await activityReport(spanish.id)).findings, []);
    for (const activity of [page, link]) {
      assert.equal((await submit(activity.id)).statusCode, 200);
      assert.equal((await review(activity.id, 'approve')).statusCode, 200);
    }
    // Saving drafts never runs the guard: invalid-looking warnings and even blocking drafts can still be edited.
    assert.equal((await call('instructor', 'PUT', `/courses/${C()}/activities/${ids.lesson}`, { title: 'Service value chain', body: 'TBD: rewrite this lesson.' })).statusCode, 200);
  });

  it('8. blocking findings cannot be bypassed: submit and approve are refused on the server; returning still works', async () => {
    problem(await submit(ids.emptyPage!), 422, 'QUALITY_CHECK_BLOCKED');
    problem(await submit(ids.badLink!), 422, 'QUALITY_CHECK_BLOCKED');
    problem(await submit(ids.legacyAssignment!), 422, 'QUALITY_CHECK_BLOCKED');
    // Administrators get no exemption.
    problem(await submit(ids.emptyPage!, 'admin'), 422, 'QUALITY_CHECK_BLOCKED');
    assert.equal((await query<{ review_status: string }>('SELECT review_status FROM activities WHERE id = $1', [ids.emptyPage]))[0]!.review_status, 'draft');
    // Content that reached review before it became invalid (or legacy submitted rows) cannot be approved…
    await query("UPDATE activities SET review_status = 'submitted', submitted_at = now(), submitted_by_user_id = (SELECT id FROM users WHERE email = $2) WHERE id = $1", [ids.badLink, ACCOUNTS.instructor]);
    problem(await review(ids.badLink!, 'approve'), 422, 'QUALITY_CHECK_BLOCKED');
    problem(await call('admin', 'POST', `/courses/${C()}/activities/${ids.badLink}/review`, { decision: 'approve' }), 422, 'QUALITY_CHECK_BLOCKED');
    const row = (await query<{ review_status: string; approved_config: unknown }>('SELECT review_status, approved_config FROM activities WHERE id = $1', [ids.badLink]))[0]!;
    assert.deepEqual([row.review_status, row.approved_config], ['submitted', null]);
    // …but the reviewer can still return it with a comment, through the unchanged workflow.
    const returned = await review(ids.badLink!, 'return', 'Use an https address for this resource.');
    assert.equal(returned.statusCode, 200, returned.body);
    assert.equal(returned.json().review.status, 'returned');
    assert.equal(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'activity.approved' AND entity_id = $1", [ids.badLink]), 0);
  });

  it('9. rechecking after a correction updates the result, and the corrected content can be submitted', async () => {
    assert.equal((await activityReport(ids.badLink!)).summary.blocking, 1);
    await ok('instructor', 'PUT', `/courses/${C()}/activities/${ids.badLink}`, { title: 'Legacy link', url: 'https://www.axelos.com/itil', kind: 'website' });
    const after = await activityReport(ids.badLink!);
    assert.deepEqual([after.summary.blocking, after.findings], [0, []]);
    assert.ok(Date.parse(after.checkedAt) > 0);
    assert.equal((await submit(ids.badLink!)).statusCode, 200);
    assert.equal((await review(ids.badLink!, 'approve')).statusCode, 200);
    // The course report no longer lists it either.
    assert.ok(!(await courseReport()).findings.some((f) => f.activityId === ids.badLink));
    // Fixing a quiz answer key the same way.
    const [first] = await query<{ id: string }>('SELECT id FROM quiz_questions WHERE activity_id = $1 ORDER BY position LIMIT 1', [ids.brokenQuiz]);
    await ok('instructor', 'PUT', `/courses/${C()}/activities/${ids.brokenQuiz}/questions/${first!.id}`, choice('First?', ['Yes', 'No']));
    assert.ok(!codes((await activityReport(ids.brokenQuiz!)).findings).includes('QUIZ_QUESTION_ANSWER_INVALID'));
  });

  it('10. role permissions: authors and reviewers only; enforced by the API', async () => {
    for (const who of ['instructor', 'reviewer', 'admin'] as const) {
      assert.equal((await call(who, 'GET', `/courses/${C()}/quality`)).statusCode, 200, who);
      assert.equal((await call(who, 'GET', `/courses/${C()}/activities/${ids.lesson}/quality`)).statusCode, 200, who);
    }
    // Non-editing instructors gain no authoring or review powers.
    problem(await call('ta', 'GET', `/courses/${C()}/quality`), 403, 'FORBIDDEN');
    problem(await call('ta', 'GET', `/courses/${C()}/activities/${ids.lesson}/quality`), 403, 'FORBIDDEN');
    // Outside the course: the course's existence is not revealed.
    const pmfOutsider = (await query<{ email: string }>("SELECT u.email FROM users u WHERE u.email = $1 AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.user_id = u.id AND e.course_id = $2 AND e.status = 'active')", [ACCOUNTS.learnerB, courseId(PMF)]))[0];
    assert.ok(pmfOutsider, 'learnerB is not enrolled in PMF');
    problem(await call('learnerB', 'GET', `/courses/${courseId(PMF)}/quality`), 404, 'NOT_FOUND');
    // An activity of another course is not found through this course.
    const { id: otherActivity } = (await query<{ id: string }>("SELECT a.id FROM activities a JOIN sections s ON s.id = a.section_id WHERE s.course_id = $1 LIMIT 1", [courseId(PMF)]))[0]!;
    problem(await call('instructor', 'GET', `/courses/${C()}/activities/${otherActivity}/quality`), 404, 'NOT_FOUND');
    problem(await call('instructor', 'GET', `/courses/${randomUUID()}/quality`), 404, 'NOT_FOUND');
    assert.equal((await call('instructor', 'GET', `/courses/not-a-uuid/quality`)).statusCode, 400);
    // Signed out.
    problem(await request('GET', `/courses/${C()}/quality`), 401, 'UNAUTHENTICATED');
    // Reports are never cached by the browser or a proxy.
    assert.equal((await call('instructor', 'GET', `/courses/${C()}/quality`)).headers['cache-control'], 'no-store');
  });

  it('11. students cannot read reports (draft titles, review states and findings stay private)', async () => {
    for (const who of ['student', 'learnerA'] as const) {
      problem(await call(who, 'GET', `/courses/${C()}/quality`), 403, 'FORBIDDEN');
      problem(await call(who, 'GET', `/courses/${C()}/activities/${ids.lesson}/quality`), 403, 'FORBIDDEN');
      problem(await call(who, 'GET', `/courses/${C()}/activities/${ids.emptyPage}/quality`), 403, 'FORBIDDEN');
    }
  });

  it('14. checking is read-only and repeated submissions create one submission', async () => {
    const before = await query('SELECT id, review_status, updated_at, config FROM activities ORDER BY id');
    const audits = await count('SELECT count(*)::int AS n FROM audit_log');
    await Promise.all([courseReport(), courseReport('reviewer'), activityReport(ids.lesson!), activityReport(ids.emptyPage!)]);
    assert.deepEqual(await query('SELECT id, review_status, updated_at, config FROM activities ORDER BY id'), before);
    assert.equal(await count('SELECT count(*)::int AS n FROM audit_log'), audits);
    // Two submit clicks at once: exactly one submission (the second sees the new state).
    const fresh = await create({ type: 'page', title: 'Double click', body: 'Clean text.' });
    const statuses = (await Promise.all([submit(fresh.id), submit(fresh.id)])).map((res) => res.statusCode).sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'activity.submitted' AND entity_id = $1", [fresh.id]), 1);
    ids.fresh = fresh.id;
  });

  it('15. the existing review workflow is unchanged (self-approval, return comment, states, publication)', async () => {
    problem(await call('instructor', 'POST', `/courses/${C()}/activities/${ids.fresh}/review`, { decision: 'approve' }), 403, 'FORBIDDEN');
    problem(await review(ids.fresh!, 'return'), 422, 'REVIEW_COMMENT_REQUIRED');
    problem(await call('instructor', 'PUT', `/courses/${C()}/activities/${ids.fresh}`, { title: 'Double click', body: 'Changed.' }), 409, 'ACTIVITY_UNDER_REVIEW');
    const approved = await review(ids.fresh!, 'approve');
    assert.equal(approved.statusCode, 200, approved.body);
    assert.deepEqual([approved.json().review.status, approved.json().liveVersion.title], ['approved', 'Double click']);
    problem(await review(ids.fresh!, 'approve'), 409, 'INVALID_REVIEW_STATE');
    // The design team cannot approve what it submitted itself.
    const own = await ok<{ id: string }>('reviewer', 'POST', `/courses/${C()}/sections/${ids.section}/activities`, { type: 'page', title: 'Own', body: 'Text.' }, 201);
    assert.equal((await submit(own.id, 'reviewer')).statusCode, 200);
    problem(await review(own.id, 'approve'), 403, 'SELF_REVIEW_NOT_ALLOWED');
    // Students see only approved content, never the blocked drafts.
    const visible = await ok<{ items: Array<{ id: string }> }>('student', 'GET', `/courses/${C()}/sections/${ids.section}/activities?limit=100`);
    const visibleIds = visible.items.map((item) => item.id);
    assert.ok(visibleIds.includes(ids.fresh!) && !visibleIds.includes(ids.emptyPage!) && !visibleIds.includes(ids.legacyAssignment!));
  });
});
