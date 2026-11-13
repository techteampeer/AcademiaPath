/**
 * AP-029 release checks, on a fresh synthetic demo dataset in a temporary PostgreSQL database (skipped unless
 * TEST_DATABASE_URL is set):
 *
 * 1. Activity limit — a course report is either complete or explicitly refused (QUALITY_REPORT_TOO_LARGE); never a
 *    partial report that could read as "no issues". Submit and approve always validate their activity in full,
 *    whatever the course size.
 * 2. Approval compatibility — the seeded demo courses (published and draft) go through the unchanged workflow:
 *    instructor submission, design-team approval and return with comments; warnings and empty optional sections never
 *    block; genuinely invalid content is blocked; nobody can bypass the guards.
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
import { QUALITY_ACTIVITY_LIMIT } from '../../src/quality/report.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const PUBLISHED = ['ITIL4-F-2026-2-A', 'PMF-2026-2-A', 'IAI-2026-2-A'];
const DRAFT = 'ITIL4-F-2026-2-B';

type App = ReturnType<typeof buildApp>;
type Session = { token: string; csrf: string; userId: string };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Finding = { code: string; severity: string; target: string; sectionId: string | null; activityId: string | null };
type Report = { scope: string; summary: { blocking: number; warnings: number; sections: number; activities: number }; findings: Finding[] };
type ActivityRow = { id: string; course_id: string; type: string; title: string; review_status: string; submitted_by_user_id: string | null };

describe('AP-029 release checks (PostgreSQL, demo dataset)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let report: DemoReport;
  let app: App;
  const as = {} as Record<Persona, Session>;
  const ids = {} as Record<string, string>;

  const courseId = (code: string) => report.courses.find((c) => c.code === code)!.id;
  const request = (method: Method, url: string, options: { session?: Session; body?: unknown; csrf?: string | null; origin?: string } = {}) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: options.session ? { ap_session: options.session.token } : {},
      headers: {
        origin: options.origin ?? ORIGIN,
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
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };
  const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[];
  const count = async (sql: string, params: unknown[] = []) => Number((await query<{ n: number }>(sql, params))[0]!.n);
  const activitiesOf = (code: string) =>
    query<ActivityRow>(
      `SELECT a.id, s.course_id, a.type, a.title, a.review_status, a.submitted_by_user_id FROM activities a JOIN sections s ON s.id = a.section_id
       WHERE s.course_id = $1 AND a.type IN ('page','link','quiz','assignment','file') ORDER BY s.position, a.position`,
      [courseId(code)],
    );
  const courseReport = (code: string, who: Persona = 'instructor') => call(who, 'GET', `/courses/${courseId(code)}/quality`);
  const activityReport = (code: string, activityId: string, who: Persona = 'instructor') => ok<Report>(who, 'GET', `/courses/${courseId(code)}/activities/${activityId}/quality`);
  const submit = (code: string, activityId: string, who: Persona = 'instructor') => call(who, 'POST', `/courses/${courseId(code)}/activities/${activityId}/submit`);
  const review = (code: string, activityId: string, body: Record<string, unknown>, who: Persona = 'reviewer') =>
    call(who, 'POST', `/courses/${courseId(code)}/activities/${activityId}/review`, body);
  const status = async (activityId: string) => (await query<{ review_status: string }>('SELECT review_status FROM activities WHERE id = $1', [activityId]))[0]!.review_status;
  /** Approves as the design team, or as an administrator when the design team submitted it (no self-approval). */
  const approve = async (code: string, row: { id: string; submitted_by_user_id: string | null }) => {
    const reviewer = row.submitted_by_user_id === as.reviewer.userId ? 'admin' : 'reviewer';
    return review(code, row.id, { decision: 'approve' }, reviewer);
  };
  /** Many valid lessons in one section, written in one statement (the API would take minutes for a thousand). */
  const bulkLessons = (sectionId: string, from: number, count: number) =>
    query(
      `INSERT INTO activities (section_id, type, title, position, config)
       SELECT $1, 'page', 'Bulk lesson ' || g, g, '{"body": "Synthetic lesson text."}'::jsonb FROM generate_series($2::int, $3::int) g`,
      [sectionId, from, from + count - 1],
    );

  before(async () => {
    database = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'ap-quality-release-'));
    const env = { NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: join(root, 'store') };
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

  // ------------------------------------------------------------------------------------------------ 2. compatibility

  it('2a. every seeded demo course (published and draft) has no blocking finding, course-wide and per activity', async () => {
    for (const code of [...PUBLISHED, DRAFT]) {
      const res = await courseReport(code, 'reviewer');
      assert.equal(res.statusCode, 200, `${code}: ${res.body}`);
      const course = res.json() as Report;
      assert.equal(course.summary.blocking, 0, `${code}: ${JSON.stringify(course.findings)}`);
      for (const activity of await activitiesOf(code)) {
        assert.equal((await activityReport(code, activity.id)).summary.blocking, 0, `${code} ${activity.title}`);
      }
    }
    // The draft course only has empty optional sections: warnings, never blocking.
    const draft = (await courseReport(DRAFT)).json() as Report;
    assert.ok(draft.findings.length > 0 && draft.findings.every((finding) => finding.code === 'SECTION_EMPTY' && finding.severity === 'warning'), JSON.stringify(draft.findings));
  });

  it('2b. the seeded published content goes through the unchanged workflow: return with comments, resubmit, submit, approve', async () => {
    // Return with comments, then the instructor resubmits and the design team approves.
    const waiting = (await activitiesOf(PUBLISHED[0]!)).find((row) => row.review_status === 'submitted' && row.submitted_by_user_id !== as.reviewer.userId);
    assert.ok(waiting, 'the demo has content waiting for review');
    const returned = await review(PUBLISHED[0]!, waiting.id, { decision: 'return', comment: 'Please add one example from your organization.' });
    assert.equal(returned.statusCode, 200, returned.body);
    assert.deepEqual([returned.json().review.status, returned.json().review.comment], ['returned', 'Please add one example from your organization.']);
    assert.equal((await submit(PUBLISHED[0]!, waiting.id)).statusCode, 200);
    assert.equal((await approve(PUBLISHED[0]!, { id: waiting.id, submitted_by_user_id: as.instructor.userId })).statusCode, 200);
    assert.equal(await status(waiting.id), 'approved');

    // Every other draft or returned demo activity can be submitted, and everything waiting can be approved.
    const counts = { submitted: 0, approved: 0, refusedByExistingQuizRules: 0 };
    for (const code of PUBLISHED) {
      for (const row of await activitiesOf(code)) {
        if (row.review_status === 'draft' || row.review_status === 'returned') {
          const res = await submit(code, row.id);
          // The only acceptable refusals are the pre-existing quiz rules, never the new quality guard.
          if (res.statusCode !== 200) {
            assert.notEqual(res.json().code, 'QUALITY_CHECK_BLOCKED', `${code} ${row.title}: ${res.body}`);
            assert.ok(['QUIZ_HAS_NO_QUESTIONS', 'QUIZ_POOL_TOO_SMALL', 'QUIZ_POOL_POINTS_MIXED'].includes(res.json().code), res.body);
            counts.refusedByExistingQuizRules += 1;
            continue;
          }
          counts.submitted += 1;
          row.submitted_by_user_id = as.instructor.userId;
          row.review_status = 'submitted';
        }
        if (row.review_status === 'submitted') {
          const res = await approve(code, row);
          assert.equal(res.statusCode, 200, `${code} ${row.title}: ${res.body}`);
          counts.approved += 1;
        }
      }
    }
    // The seeded courses contain drafts, returned and waiting content, and all of it went through the workflow.
    assert.ok(counts.submitted >= 1 && counts.approved >= 2, JSON.stringify(counts));
    for (const code of PUBLISHED) {
      const left = (await activitiesOf(code)).filter((row) => row.review_status !== 'approved');
      assert.equal(left.length, counts.refusedByExistingQuizRules ? left.length : 0, `${code}: ${JSON.stringify(left.map((row) => [row.title, row.review_status]))}`);
    }
    assert.equal(await count("SELECT count(*)::int AS n FROM audit_log WHERE action IN ('activity.approved', 'activity.returned') AND entity_id = $1", [waiting.id]), 2);
  });

  it('2c. the draft demo course: empty optional sections (visible or hidden) and warnings never block submission or approval', async () => {
    const draftSections = await query<{ id: string }>('SELECT id FROM sections WHERE course_id = $1 ORDER BY position', [courseId(DRAFT)]);
    const hidden = await ok<{ id: string }>('admin', 'POST', `/courses/${courseId(DRAFT)}/sections`, { title: 'Optional extension', isVisible: false }, 201);
    // Content with several warnings: placeholder text, an insecure link, an unsafe address in text, a video without a description.
    const lesson = await ok<{ id: string }>('instructor', 'POST', `/courses/${courseId(DRAFT)}/sections/${draftSections[0]!.id}/activities`, {
      type: 'page',
      title: 'Welcome [insertar nombre del docente]',
      body: 'TODO: add the syllabus. See http://example.edu/syllabus and javascript:openSyllabus.',
    }, 201);
    const video = await ok<{ id: string }>('instructor', 'POST', `/courses/${courseId(DRAFT)}/sections/${draftSections[0]!.id}/activities`, {
      type: 'link', title: 'Welcome video', url: 'https://www.youtube.com/watch?v=welcome', kind: 'video',
    }, 201);
    const course = (await courseReport(DRAFT)).json() as Report;
    assert.equal(course.summary.blocking, 0);
    const emptySections = course.findings.filter((finding) => finding.code === 'SECTION_EMPTY').map((finding) => finding.sectionId);
    assert.ok(emptySections.includes(hidden.id) && emptySections.includes(draftSections[1]!.id), JSON.stringify(course.findings));
    assert.ok(course.findings.filter((finding) => finding.activityId === lesson.id).length >= 3);
    for (const activity of [lesson, video]) {
      assert.equal((await submit(DRAFT, activity.id)).statusCode, 200);
      const approved = await review(DRAFT, activity.id, { decision: 'approve' });
      assert.equal(approved.statusCode, 200, approved.body);
      assert.equal(approved.json().review.status, 'approved');
    }
  });

  it('2d. genuinely invalid content is blocked at submission and at approval (even when it became invalid during review)', async () => {
    const [section] = await query<{ id: string }>('SELECT id FROM sections WHERE course_id = $1 ORDER BY position LIMIT 1', [courseId(DRAFT)]);
    // Valid when submitted; the stored answer key is then broken (imported data, a manual database change).
    const quiz = await ok<{ id: string }>('instructor', 'POST', `/courses/${courseId(DRAFT)}/sections/${section!.id}/activities`, { type: 'quiz', title: 'Welcome check', attemptLimit: 1 }, 201);
    const question = await ok<{ id: string }>('instructor', 'POST', `/courses/${courseId(DRAFT)}/activities/${quiz.id}/questions`, {
      type: 'single_choice', prompt: 'Where is the syllabus?', points: 1, options: [{ text: 'Week 1', isCorrect: true }, { text: 'Week 2', isCorrect: false }],
    }, 201);
    assert.equal((await submit(DRAFT, quiz.id)).statusCode, 200);
    // Questions cannot be changed through the API while the quiz is under review…
    problem(await call('instructor', 'PUT', `/courses/${courseId(DRAFT)}/activities/${quiz.id}/questions/${question.id}`, {
      type: 'single_choice', prompt: 'Changed', points: 1, options: [{ text: 'A', isCorrect: true }, { text: 'B', isCorrect: false }],
    }), 409, 'ACTIVITY_UNDER_REVIEW');
    // …but if the stored data is broken anyway, approval re-validates and refuses it.
    await query(`UPDATE quiz_questions SET correct_answer = '{"optionIds": []}'::jsonb WHERE id = $1`, [question.id]);
    problem(await review(DRAFT, quiz.id, { decision: 'approve' }), 422, 'QUALITY_CHECK_BLOCKED');
    assert.equal(await status(quiz.id), 'submitted');
    assert.equal(await count("SELECT count(*)::int AS n FROM activities WHERE id = $1 AND approved_config IS NOT NULL", [quiz.id]), 0);
    // Returning works; after the correction the quiz is submitted and approved normally.
    assert.equal((await review(DRAFT, quiz.id, { decision: 'return', comment: 'Mark the correct option.' })).statusCode, 200);
    await ok('instructor', 'PUT', `/courses/${courseId(DRAFT)}/activities/${quiz.id}/questions/${question.id}`, {
      type: 'single_choice', prompt: 'Where is the syllabus?', points: 1, options: [{ text: 'Week 1', isCorrect: true }, { text: 'Week 2', isCorrect: false }],
    });
    assert.equal((await submit(DRAFT, quiz.id)).statusCode, 200);
    assert.equal((await review(DRAFT, quiz.id, { decision: 'approve' })).statusCode, 200);
    // A lesson stored without text is refused at submission.
    const lesson = await ok<{ id: string }>('instructor', 'POST', `/courses/${courseId(DRAFT)}/sections/${section!.id}/activities`, { type: 'page', title: 'Imported', body: 'x' }, 201);
    await query(`UPDATE activities SET config = '{"body": ""}'::jsonb WHERE id = $1`, [lesson.id]);
    problem(await submit(DRAFT, lesson.id), 422, 'QUALITY_CHECK_BLOCKED');
    assert.equal(await status(lesson.id), 'draft');
    ids.blockedLesson = lesson.id;
  });

  it('2e. nobody can bypass the submission and approval guards', async () => {
    const code = DRAFT;
    const blocked = ids.blockedLesson!;
    const before = await count("SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action IN ('activity.submitted','activity.approved')", [blocked]);
    // Administrators get no exemption.
    problem(await submit(code, blocked, 'admin'), 422, 'QUALITY_CHECK_BLOCKED');
    // The design team may also submit content: the guard applies to it as well.
    problem(await submit(code, blocked, 'reviewer'), 422, 'QUALITY_CHECK_BLOCKED');
    // Put the invalid lesson into review directly (legacy data) and try every way to approve it.
    await query("UPDATE activities SET review_status = 'submitted', submitted_at = now(), submitted_by_user_id = $2 WHERE id = $1", [blocked, as.instructor.userId]);
    problem(await review(code, blocked, { decision: 'approve' }), 422, 'QUALITY_CHECK_BLOCKED');
    problem(await review(code, blocked, { decision: 'approve' }, 'admin'), 422, 'QUALITY_CHECK_BLOCKED');
    problem(await review(code, blocked, { decision: 'approve' }, 'instructor'), 403, 'FORBIDDEN');
    // Unknown fields such as a "force" flag are rejected by the schema, and only approve/return exist.
    assert.equal((await review(code, blocked, { decision: 'approve', force: true })).statusCode, 400);
    assert.equal((await review(code, blocked, { decision: 'publish' })).statusCode, 400);
    // CSRF and Origin protection still apply to the guarded endpoints.
    problem(await request('POST', `/courses/${courseId(code)}/activities/${blocked}/review`, { session: as.reviewer, body: { decision: 'approve' }, csrf: null }), 403, 'CSRF_TOKEN_INVALID');
    problem(await request('POST', `/courses/${courseId(code)}/activities/${blocked}/review`, { session: as.reviewer, body: { decision: 'approve' }, origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
    // Students cannot see a draft course at all; non-editing instructors and students of a published course have no
    // submit or review permission; outsiders do not learn that the course exists.
    const published = PUBLISHED[0]!;
    const draftInPublished = (await activitiesOf(published))[0]!;
    problem(await submit(code, blocked, 'student'), 404, 'NOT_FOUND');
    for (const who of ['ta', 'student', 'learnerA'] as const) {
      problem(await submit(published, draftInPublished.id, who), 403, 'FORBIDDEN');
      problem(await review(published, draftInPublished.id, { decision: 'approve' }, who), 403, 'FORBIDDEN');
    }
    problem(await review('PMF-2026-2-A', draftInPublished.id, { decision: 'approve' }, 'learnerB'), 404, 'NOT_FOUND');
    // Nothing above changed the blocked lesson or published it.
    const row = (await query<{ review_status: string; approved_config: unknown }>('SELECT review_status, approved_config FROM activities WHERE id = $1', [blocked]))[0]!;
    assert.deepEqual([row.review_status, row.approved_config], ['submitted', null]);
    assert.equal(await count("SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action IN ('activity.submitted','activity.approved')", [blocked]), before);
    // The reviewer can still return it.
    assert.equal((await review(code, blocked, { decision: 'return', comment: 'The lesson has no text.' })).statusCode, 200);
  });

  // ------------------------------------------------------------------------------------------------ 1. activity limit

  it(`1a. a course with exactly ${QUALITY_ACTIVITY_LIMIT} activities gets a complete report, including its blocking finding`, async () => {
    const section = await ok<{ id: string }>('admin', 'POST', `/courses/${courseId(DRAFT)}/sections`, { title: 'Bulk content', isVisible: true }, 201);
    ids.bulkSection = section.id;
    const existing = (await activitiesOf(DRAFT)).length;
    await bulkLessons(section.id, 0, QUALITY_ACTIVITY_LIMIT - existing);
    assert.equal((await activitiesOf(DRAFT)).length, QUALITY_ACTIVITY_LIMIT);
    const res = await courseReport(DRAFT);
    assert.equal(res.statusCode, 200, res.body);
    const course = res.json() as Report;
    assert.equal(course.summary.activities, QUALITY_ACTIVITY_LIMIT);
    assert.ok(!('limited' in course));
    // The earlier invalid lesson (returned, still without text) is reported: the report is complete, not "all clear".
    assert.ok(course.findings.some((finding) => finding.activityId === ids.blockedLesson && finding.code === 'PAGE_BODY_EMPTY'));
    assert.ok(course.summary.blocking >= 1);
    // The last lesson of the course was inspected too.
    const [last] = await query<{ id: string }>("SELECT id FROM activities WHERE section_id = $1 ORDER BY position DESC LIMIT 1", [section.id]);
    ids.lastLesson = last!.id;
  });

  it(`1b. one activity more (${QUALITY_ACTIVITY_LIMIT + 1}): an explicit, actionable refusal, never a partial report`, async () => {
    await bulkLessons(ids.bulkSection!, 5000, 1);
    assert.equal((await activitiesOf(DRAFT)).length, QUALITY_ACTIVITY_LIMIT + 1);
    for (const who of ['instructor', 'reviewer', 'admin'] as const) {
      const res = await courseReport(DRAFT, who);
      problem(res, 422, 'QUALITY_REPORT_TOO_LARGE');
      const body = res.json();
      assert.ok(!('findings' in body) && !('summary' in body), 'no partial report');
      assert.match(body.detail, new RegExp(`more than ${QUALITY_ACTIVITY_LIMIT} activities`));
      assert.match(body.detail, /one at a time/);
    }
    // Permissions are still checked first: no size information leaks to people without access.
    problem(await courseReport(DRAFT, 'student'), 404, 'NOT_FOUND');
    problem(await courseReport(DRAFT, 'ta'), 404, 'NOT_FOUND');
  });

  it('1c. above the limit, activity reports and the submit/approve guards still validate each activity in full', async () => {
    // The blocked lesson is still found and still blocked.
    const blocked = await activityReport(DRAFT, ids.blockedLesson!);
    assert.deepEqual(blocked.findings.map((finding) => finding.code), ['PAGE_BODY_EMPTY']);
    problem(await submit(DRAFT, ids.blockedLesson!), 422, 'QUALITY_CHECK_BLOCKED');
    // In-app links are checked against the whole course: the last activity (beyond the first thousand) exists.
    const linking = await ok<{ id: string }>('instructor', 'POST', `/courses/${courseId(DRAFT)}/sections/${ids.bulkSection}/activities`, {
      type: 'page',
      title: 'Index',
      body: `Start with /courses/${courseId(DRAFT)}/activities/${ids.lastLesson}, then /courses/${courseId(DRAFT)}/activities/${randomUUID()}.`,
    }, 201);
    const links = await activityReport(DRAFT, linking.id);
    assert.deepEqual(links.findings.map((finding) => finding.code), ['INTERNAL_LINK_BROKEN']);
    // A valid activity in the large course is submitted and approved normally.
    assert.equal((await submit(DRAFT, ids.lastLesson!)).statusCode, 200);
    assert.equal((await review(DRAFT, ids.lastLesson!, { decision: 'approve' })).statusCode, 200);
    // A legacy invalid activity in review cannot be approved in the large course either.
    await query("UPDATE activities SET review_status = 'submitted', submitted_at = now(), submitted_by_user_id = $2 WHERE id = $1", [ids.blockedLesson, as.instructor.userId]);
    problem(await review(DRAFT, ids.blockedLesson!, { decision: 'approve' }), 422, 'QUALITY_CHECK_BLOCKED');
    await review(DRAFT, ids.blockedLesson!, { decision: 'return', comment: 'Add the text.' });
  });

  it('1d. back within the limit, the course report works normally again', async () => {
    // Two activities were added in 1c (the index lesson) and 1b; remove the extra drafts that were never published.
    await query("DELETE FROM activities WHERE section_id = $1 AND approved_config IS NULL AND title IN ('Bulk lesson 5000', 'Index')", [ids.bulkSection]);
    assert.equal((await activitiesOf(DRAFT)).length, QUALITY_ACTIVITY_LIMIT);
    const res = await courseReport(DRAFT);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as Report).summary.activities, QUALITY_ACTIVITY_LIMIT);
    // Published demo courses are unaffected by another course's size.
    for (const code of PUBLISHED) assert.equal((await courseReport(code)).statusCode, 200);
  });
});
