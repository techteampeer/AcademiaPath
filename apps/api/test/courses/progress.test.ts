/**
 * Learning progress (AP-020) on the synthetic demo dataset, against a temporary PostgreSQL database
 * (skipped unless TEST_DATABASE_URL is set): reading completions, automatic quiz and assignment
 * completion, eligibility rules, privacy and role boundaries, concurrency, section prerequisites with
 * server-side enforcement on every content route, CSRF/Origin, audit records, and that grades,
 * attempts and submissions are never changed. Passwords are random per run.
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
import { upsertSyntheticUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';

type App = ReturnType<typeof buildApp>;
type Session = { token: string; csrf: string; userId: string };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Summary = { completedCount: number; totalCount: number; percent: number | null; state: string };
type RequiredSection = { sectionId: string; title: string; completed: boolean };
type SectionSummary = Summary & { sectionId: string; title: string; position: number; locked: boolean; requiredSections: RequiredSection[] };
type CourseProgress = Summary & { courseId: string; continueAt: { sectionId: string; activityId: string; type: string; title: string } | null; sections: SectionSummary[] };
type ActivityProgress = { activityId: string; type: string; title: string; completion: 'manual' | 'automatic'; completed: boolean; completedAt: string | null };
type SectionProgress = SectionSummary & { activities: ActivityProgress[] };
type StudentRow = Summary & { student: { id: string; email: string } };

const ITIL = 'ITIL4-F-2026-2-A';
const PMF = 'PMF-2026-2-A';
const IAI = 'IAI-2026-2-A';
const DRAFT = 'ITIL4-F-2026-2-B';
/** Synthetic account that only ever receives a program-management grant (AP-019), never a course role. */
const PROGRAM_MANAGER = { email: 'program.manager@academiapath.example', givenName: 'Demo', familyName: 'Program Manager', systemRole: 'user' as const };

describe('learning progress (PostgreSQL, demo dataset)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let report: DemoReport;
  let app: App;
  const as = {} as Record<Persona, Session>;
  let startedAt: Date;
  let snapshot: { grades: string; attempts: string; submissions: string; audit: string; ids: Record<string, string[]> };
  let emptyCourseId: string;
  let manager: Session;

  const courseId = (code: string) => report.courses.find((c) => c.code === code)!.id;
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
  const login = async (persona: Persona | { email: string }): Promise<Session> => {
    const email = typeof persona === 'string' ? ACCOUNTS[persona] : persona.email;
    const res = await request('POST', '/auth/login', { body: { email, password: PASSWORD } });
    assert.equal(res.statusCode, 200, res.body);
    return { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
  };
  const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[];
  const count = async (sql: string, params: unknown[] = []) => Number((await query<{ n: number }>(sql, params))[0]!.n);
  const activityId = async (code: string, title: string) =>
    (await query<{ id: string }>('SELECT a.id FROM activities a JOIN sections s ON s.id = a.section_id WHERE s.course_id = $1 AND a.title = $2', [courseId(code), title]))[0]!.id;
  const sectionId = async (code: string, title: string) =>
    (await query<{ id: string }>('SELECT id FROM sections WHERE course_id = $1 AND title = $2', [courseId(code), title]))[0]!.id;
  const progress = (who: Persona, code: string) => ok<CourseProgress>(who, 'GET', `/courses/${courseId(code)}/progress`);
  const sectionProgress = (who: Persona, code: string, section: string) => ok<SectionProgress>(who, 'GET', `/courses/${courseId(code)}/sections/${section}/progress`);
  const completion = (who: Persona, method: 'PUT' | 'DELETE', code: string, activity: string) => call(who, method, `/courses/${courseId(code)}/activities/${activity}/completion`);
  const auditCount = async (action: string, entityId: string) => count('SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND entity_id = $2', [action, entityId]);
  const completionRows = async (activity: string, userId: string) =>
    count('SELECT count(*)::int AS n FROM activity_completions WHERE activity_id = $1 AND user_id = $2', [activity, userId]);
  const overview = (who: Persona, code: string) => ok<{ totalCount: number; items: StudentRow[] }>(who, 'GET', `/courses/${courseId(code)}/progress/students?limit=100`);
  const rowOf = (rows: StudentRow[], persona: Persona) => rows.find((row) => row.student.email === ACCOUNTS[persona]);
  /** No progress response may carry scores, points or grades (keys anywhere in the JSON). */
  const assertNoPerformanceData = (value: unknown) => {
    const keys: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) (keys.push(key), walk(child));
    };
    walk(value);
    assert.deepEqual(keys.filter((key) => /score|point|grade|answer|feedback/i.test(key)), [], 'progress never exposes performance data');
  };

  before(async () => {
    database = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'ap-progress-'));
    const env = { NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: join(root, 'store') };
    report = await seedDemo(database.db, { password: PASSWORD, env, uploadFilesDir: null });
    await upsertSyntheticUsers(database.db, PASSWORD, [PROGRAM_MANAGER]);
    app = buildApp({ config: { ...loadConfig(env), loginRateLimit: { max: 1000, windowMs: 60_000 } }, database: database.db });
    await app.ready();
    for (const persona of Object.keys(ACCOUNTS) as Persona[]) as[persona] = await login(persona);
    manager = await login(PROGRAM_MANAGER);
    startedAt = new Date();
    const rowsOf = async (table: string) => JSON.stringify(await query(`SELECT * FROM ${table} ORDER BY id`));
    snapshot = {
      grades: await rowsOf('grades'),
      attempts: await rowsOf('quiz_attempts'),
      submissions: await rowsOf('assignment_submissions'),
      audit: await rowsOf('audit_log'),
      ids: {
        grades: (await query<{ id: string }>('SELECT id FROM grades')).map((r) => r.id),
        quiz_attempts: (await query<{ id: string }>('SELECT id FROM quiz_attempts')).map((r) => r.id),
        assignment_submissions: (await query<{ id: string }>('SELECT id FROM assignment_submissions')).map((r) => r.id),
        audit_log: (await query<{ id: string }>('SELECT id FROM audit_log')).map((r) => r.id),
      },
    };
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('1. starts a student without work at zero, with eligible totals per section and a continue link', async () => {
    const itil = await progress('student', ITIL);
    assert.deepEqual([itil.completedCount, itil.totalCount, itil.percent, itil.state], [0, 8, 0, 'not_started']);
    assert.deepEqual(itil.sections.map((s) => [s.title, s.completedCount, s.totalCount, s.locked]), [
      ['Module 1 - Service management concepts', 0, 2, false],
      ['Module 2 - The service value system', 0, 3, false],
      ['Module 3 - Practices and continual improvement', 0, 3, false],
    ]);
    assert.equal(itil.continueAt?.title, 'Value, outcomes, costs and risks');
    const module1 = await sectionProgress('student', ITIL, itil.sections[0]!.sectionId);
    assert.deepEqual(module1.activities.map((a) => [a.type, a.completion, a.completed]), [['page', 'manual', false], ['link', 'manual', false]]);
    const mine = await ok<{ items: Array<Summary & { courseId: string }> }>('student', 'GET', '/me/progress');
    assert.deepEqual(new Set(mine.items.map((i) => i.courseId)), new Set([courseId(ITIL), courseId(PMF), courseId(IAI)]), 'published student courses only');
    assertNoPerformanceData(itil);
    assertNoPerformanceData(mine);
  });

  it('2-3. marks an approved lesson complete and keeps it across reloads and new sessions', async () => {
    const lesson = await activityId(ITIL, 'Value, outcomes, costs and risks');
    const res = await completion('student', 'PUT', ITIL, lesson);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().completed, true);
    assert.ok(new Date(res.json().completedAt) >= new Date(startedAt.getTime() - 1000), 'completion time comes from the server');
    const after = await progress('student', ITIL);
    assert.deepEqual([after.completedCount, after.percent, after.state], [1, 12, 'in_progress']);
    assert.equal(after.continueAt?.title, 'Reading: ITIL overview');
    // A fresh session (another login) and a reload read the same stored progress.
    const second = await login('student');
    const reloaded = await request('GET', `/courses/${courseId(ITIL)}/progress`, { session: second });
    assert.equal(reloaded.json().completedCount, 1);
    assert.equal((await ok<{ items: Array<Summary & { courseId: string }> }>('student', 'GET', '/me/progress')).items.find((i) => i.courseId === courseId(ITIL))?.completedCount, 1);
    assert.equal(await completionRows(lesson, as.student.userId), 1);
    assert.equal(await auditCount('activity.completion_marked', lesson), 1);
  });

  it('4. unmarks a reading activity (idempotently)', async () => {
    const lesson = await activityId(ITIL, 'Value, outcomes, costs and risks');
    for (let i = 0; i < 2; i++) {
      const res = await completion('student', 'DELETE', ITIL, lesson);
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual([res.json().completed, res.json().completedAt], [false, null]);
    }
    assert.equal((await progress('student', ITIL)).completedCount, 0);
    assert.equal(await auditCount('activity.completion_unmarked', lesson), 1, 'only a real removal is audited');
  });

  it('5. repeated and concurrent marks keep one record and one audit entry', async () => {
    const lesson = await activityId(ITIL, 'Value, outcomes, costs and risks');
    const results = await Promise.all(Array.from({ length: 8 }, () => completion('student', 'PUT', ITIL, lesson)));
    assert.ok(results.every((r) => r.statusCode === 200), results.map((r) => r.body).join('\n'));
    assert.equal(new Set(results.map((r) => r.json().completedAt)).size, 1, 'every call reports the first completion time');
    assert.equal(await completionRows(lesson, as.student.userId), 1);
    assert.equal(await auditCount('activity.completion_marked', lesson), 2, 'one entry for this mark (plus the earlier one)');
    // Other reading activities, marked concurrently: a link and a document of module 2 included.
    const titles = ['Reading: ITIL overview', 'The four dimensions of service management', 'Guiding principles in practice', 'Service value chain overview'];
    const ids = await Promise.all(titles.map((title) => activityId(ITIL, title)));
    const marks = await Promise.all(ids.map((id) => completion('student', 'PUT', ITIL, id)));
    assert.ok(marks.every((r) => r.statusCode === 200), marks.map((r) => r.body).join('\n'));
    const now = await progress('student', ITIL);
    assert.deepEqual([now.completedCount, now.percent], [5, 62]);
    assert.deepEqual(now.sections.map((s) => s.state), ['completed', 'completed', 'not_started']);
  });

  it('6. submitting a quiz attempt completes the quiz, passed or not; an open attempt does not', async () => {
    const quiz = await activityId(ITIL, 'Module check: ITIL 4 foundations');
    const before = await progress('student', ITIL);
    const attempt = await ok<{ id: string }>('student', 'POST', `/courses/${courseId(ITIL)}/activities/${quiz}/attempts`, undefined, 201);
    assert.equal((await progress('student', ITIL)).completedCount, before.completedCount, 'an attempt in progress is not a completion');
    // Submitted without any answers: a score of 0 still completes the quiz (completion is not performance).
    await ok('student', 'POST', `/courses/${courseId(ITIL)}/attempts/${attempt.id}/submit`, {});
    const [stored] = await query<{ score: number; status: string }>('SELECT score, status FROM quiz_attempts WHERE id = $1', [attempt.id]);
    assert.deepEqual([stored!.status, stored!.score], ['submitted', 0]);
    const after = await progress('student', ITIL);
    assert.equal(after.completedCount, before.completedCount + 1);
    const module3 = await sectionProgress('student', ITIL, after.sections[2]!.sectionId);
    const quizItem = module3.activities.find((a) => a.activityId === quiz)!;
    assert.deepEqual([quizItem.completion, quizItem.completed], ['automatic', true]);
    assertNoPerformanceData(module3);
  });

  it('7. submitting an assignment completes it', async () => {
    const assignment = await activityId(ITIL, 'Mapping a service to the value chain');
    const before = (await progress('student', ITIL)).completedCount;
    await ok('student', 'POST', `/courses/${courseId(ITIL)}/activities/${assignment}/submissions`, { body: 'Synthetic submission for the progress test.' }, 201);
    const after = await progress('student', ITIL);
    assert.equal(after.completedCount, before + 1);
    const item = (await sectionProgress('student', ITIL, after.sections[2]!.sectionId)).activities.find((a) => a.activityId === assignment)!;
    assert.deepEqual([item.completion, item.completed], ['automatic', true]);
  });

  it('8-9. quiz and assignment completion cannot be set or removed by hand, through the API or the database', async () => {
    const iaiAssignment = await activityId(IAI, 'Propuesta de uso responsable de IA');
    const iaiQuiz = await activityId(IAI, 'Control de lectura: aprendizaje automático');
    const before = await progress('student', IAI);
    expectProblem(await completion('student', 'PUT', IAI, iaiAssignment), 422, 'COMPLETION_AUTOMATIC');
    expectProblem(await completion('student', 'PUT', IAI, iaiQuiz), 422, 'COMPLETION_AUTOMATIC');
    // A completed quiz (seeded attempt) cannot be "uncompleted" either.
    const pmfQuiz = await activityId(PMF, 'Planning essentials check');
    expectProblem(await completion('student', 'DELETE', PMF, pmfQuiz), 422, 'COMPLETION_AUTOMATIC');
    assert.equal((await sectionProgress('student', PMF, (await progress('student', PMF)).sections[2]!.sectionId)).activities.find((a) => a.activityId === pmfQuiz)?.completed, true);
    // Extra body fields are ignored: the body cannot name another student, time or activity.
    const lesson = await activityId(IAI, 'Inteligencia artificial: definiciones y alcance');
    const forged = await call('student', 'PUT', `/courses/${courseId(IAI)}/activities/${lesson}/completion`, { userId: as.learnerB.userId, completedAt: '2020-01-01T00:00:00Z', activityId: iaiQuiz });
    assert.equal(forged.statusCode, 200, forged.body);
    assert.equal(forged.json().activityId, lesson);
    assert.ok(new Date(forged.json().completedAt).getFullYear() >= 2026);
    assert.equal(await completionRows(lesson, as.learnerB.userId), 0);
    await completion('student', 'DELETE', IAI, lesson);
    assert.equal((await progress('student', IAI)).completedCount, before.completedCount);
    // Database backstop: rows for quizzes and assignments are refused by a trigger.
    const [enrollment] = await query<{ id: string }>('SELECT id FROM enrollments WHERE course_id = $1 AND user_id = $2', [courseId(IAI), as.student.userId]);
    for (const activity of [iaiQuiz, iaiAssignment]) {
      await assert.rejects(
        query('INSERT INTO activity_completions (activity_id, course_id, enrollment_id, user_id) VALUES ($1, $2, $3, $4)', [activity, courseId(IAI), enrollment!.id, as.student.userId]),
        /only reading activities/,
      );
    }
  });

  it('10. percentages use the eligible totals and round down', async () => {
    const itil = await progress('student', ITIL);
    const eligible = await count(
      `SELECT count(*)::int AS n FROM activities a JOIN sections s ON s.id = a.section_id
       WHERE s.course_id = $1 AND s.is_visible AND a.is_visible AND a.approved_config IS NOT NULL AND a.type IN ('page','link','file','quiz','assignment')`,
      [courseId(ITIL)],
    );
    assert.equal(itil.totalCount, eligible);
    assert.equal(itil.sections.reduce((total, s) => total + s.totalCount, 0), itil.totalCount);
    assert.equal(itil.sections.reduce((total, s) => total + s.completedCount, 0), itil.completedCount);
    assert.deepEqual([itil.completedCount, itil.totalCount, itil.percent], [7, 8, 87], '7 of 8 is 87.5%, shown as 87');
    assert.deepEqual(itil.sections.map((s) => s.percent), [100, 100, 66]);
    const pmf = await progress('student', PMF);
    assert.deepEqual([pmf.completedCount, pmf.totalCount, pmf.percent], [2, 8, 25], 'seeded quiz attempt and submission count');
  });

  it('11. unapproved content, hidden content and hidden sections never count', async () => {
    const unapproved = await activityId(ITIL, 'Change enablement');
    const hiddenSection = await sectionId(ITIL, 'Instructor notes');
    const hiddenLesson = await activityId(ITIL, 'Facilitator notes for module 2');
    expectProblem(await completion('student', 'PUT', ITIL, unapproved), 404, 'NOT_FOUND');
    expectProblem(await completion('student', 'PUT', ITIL, hiddenLesson), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', `/courses/${courseId(ITIL)}/sections/${hiddenSection}/progress`), 404, 'NOT_FOUND');
    const itil = await progress('student', ITIL);
    assert.ok(!itil.sections.some((s) => s.sectionId === hiddenSection));
    const module3 = await sectionProgress('student', ITIL, itil.sections[2]!.sectionId);
    assert.ok(!module3.activities.some((a) => a.activityId === unapproved), 'submitted-but-unapproved content is not listed');
    // PMF: a returned (never approved) lesson in unit 2 is excluded from the denominator.
    assert.equal((await progress('student', PMF)).sections[1]!.totalCount, 3);
    // Hiding a section removes it (and the student's marks in it) from the figures; showing it restores them.
    const module1 = itil.sections[0]!;
    await ok('admin', 'PUT', `/courses/${courseId(ITIL)}/sections/${module1.sectionId}`, { isVisible: false });
    const hidden = await progress('student', ITIL);
    assert.deepEqual([hidden.completedCount, hidden.totalCount, hidden.percent], [5, 6, 83]);
    assert.ok(await completionRows(await activityId(ITIL, 'Value, outcomes, costs and risks'), as.student.userId), 'marks are kept, only excluded');
    await ok('admin', 'PUT', `/courses/${courseId(ITIL)}/sections/${module1.sectionId}`, { isVisible: true });
    assert.deepEqual([(await progress('student', ITIL)).completedCount, (await progress('student', ITIL)).totalCount], [7, 8]);
  });

  it('12. draft courses stay inaccessible to students', async () => {
    const draft = courseId(DRAFT);
    const [section] = await query<{ id: string }>('SELECT id FROM sections WHERE course_id = $1 LIMIT 1', [draft]);
    expectProblem(await call('student', 'GET', `/courses/${draft}/progress`), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', `/courses/${draft}/sections/${section!.id}/progress`), 404, 'NOT_FOUND');
    const lesson = (await query<{ id: string }>('SELECT a.id FROM activities a JOIN sections s ON s.id = a.section_id WHERE s.course_id = $1 LIMIT 1', [draft]))[0];
    if (lesson) expectProblem(await completion('student', 'PUT', DRAFT, lesson.id), 404, 'NOT_FOUND');
    assert.ok(!(await ok<{ items: Array<{ courseId: string }> }>('student', 'GET', '/me/progress')).items.some((i) => i.courseId === draft));
  });

  it("13. a student cannot read or change another student's progress", async () => {
    const own = await progress('learnerA', ITIL);
    assert.deepEqual([own.completedCount, own.totalCount], [2, 8], "learner A sees their own figures, not the student's 7 of 8");
    expectProblem(await call('learnerA', 'GET', `/courses/${courseId(ITIL)}/progress/students`), 403, 'FORBIDDEN');
    const withParam = await call('learnerA', 'GET', `/courses/${courseId(ITIL)}/progress?userId=${as.student.userId}`);
    assert.ok(withParam.statusCode === 400 || withParam.json().completedCount === 2, 'a user id in the query is never honoured');
    // Unmarking only ever touches the caller's own record.
    const lesson = await activityId(ITIL, 'Value, outcomes, costs and risks');
    const res = await completion('learnerA', 'DELETE', ITIL, lesson);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await completionRows(lesson, as.student.userId), 1, "the student's mark is untouched");
    assert.equal((await progress('student', ITIL)).completedCount, 7);
  });

  it('14. progress cannot be changed across courses', async () => {
    const itilLesson = await activityId(ITIL, 'Incident and problem management');
    expectProblem(await completion('student', 'PUT', PMF, itilLesson), 404, 'NOT_FOUND');
    const pmfLesson = await activityId(PMF, 'What makes work a project');
    expectProblem(await completion('learnerB', 'PUT', PMF, pmfLesson), 404, 'NOT_FOUND');
    assert.equal(await completionRows(itilLesson, as.student.userId), 0);
    // Database backstop: the activity must belong to the row's course, and the enrollment to the student.
    const [pmfEnrollment] = await query<{ id: string }>('SELECT id FROM enrollments WHERE course_id = $1 AND user_id = $2', [courseId(PMF), as.student.userId]);
    await assert.rejects(
      query('INSERT INTO activity_completions (activity_id, course_id, enrollment_id, user_id) VALUES ($1, $2, $3, $4)', [itilLesson, courseId(PMF), pmfEnrollment!.id, as.student.userId]),
      /does not belong/,
    );
    await assert.rejects(
      query('INSERT INTO activity_completions (activity_id, course_id, enrollment_id, user_id) VALUES ($1, $2, $3, $4)', [pmfLesson, courseId(PMF), pmfEnrollment!.id, as.learnerA.userId]),
      /violates foreign key constraint|enrollment/,
    );
    await assert.rejects(query('UPDATE activity_completions SET user_id = $1', [as.learnerA.userId]), /cannot be updated/);
  });

  it('15. instructors see the progress of students in their assigned courses only', async () => {
    const rows = await overview('instructor', ITIL);
    assert.equal(rows.totalCount, 8);
    assert.deepEqual(rows.items.map((r) => r.student.email), [ACCOUNTS.learnerA, ACCOUNTS.learnerB, ACCOUNTS.student]);
    assert.deepEqual([rowOf(rows.items, 'student')?.completedCount, rowOf(rows.items, 'student')?.percent], [7, 87]);
    assert.deepEqual([rowOf(rows.items, 'learnerA')?.completedCount, rowOf(rows.items, 'learnerB')?.completedCount], [2, 2]);
    assertNoPerformanceData(rows);
    // The teaching assistant is a student in IAI: no overview there.
    expectProblem(await call('ta', 'GET', `/courses/${courseId(IAI)}/progress/students`), 403, 'FORBIDDEN');
    // A course the instructor is not assigned to is invisible (created in test 19's setup below).
    const itil = await ok<{ programId: string; termId: string; templateId: string }>('admin', 'GET', `/courses/${courseId(ITIL)}`);
    const created = await ok<{ id: string }>(
      'admin',
      'POST',
      '/courses',
      { programId: itil.programId, termId: itil.termId, templateId: itil.templateId, code: 'ITIL4-F-2026-2-Z', title: 'ITIL 4 Foundation (no activities yet)', status: 'published' },
      201,
    );
    emptyCourseId = created.id;
    await ok('admin', 'POST', `/courses/${emptyCourseId}/enrollments`, { email: ACCOUNTS.student, role: 'student' }, 201);
    expectProblem(await call('instructor', 'GET', `/courses/${emptyCourseId}/progress/students`), 404, 'NOT_FOUND');
  });

  it('16. non-editing instructors read progress but cannot change any of it', async () => {
    const rows = await overview('ta', ITIL);
    assert.equal(rowOf(rows.items, 'student')?.completedCount, 7);
    const lesson = await activityId(ITIL, 'Incident and problem management');
    expectProblem(await completion('ta', 'PUT', ITIL, lesson), 403, 'FORBIDDEN');
    expectProblem(await completion('ta', 'DELETE', ITIL, lesson), 403, 'FORBIDDEN');
    expectProblem(await call('ta', 'GET', `/courses/${courseId(ITIL)}/progress`), 403, 'FORBIDDEN');
    const module2 = await sectionId(ITIL, 'Module 2 - The service value system');
    expectProblem(await call('ta', 'PUT', `/courses/${courseId(ITIL)}/sections/${module2}/prerequisites`, { requiredSectionIds: [] }), 403, 'FORBIDDEN');
    assert.equal(await completionRows(lesson, as.ta.userId), 0);
  });

  it('17. design team, administrators and other staff get no private progress or impersonation', async () => {
    expectProblem(await call('reviewer', 'GET', `/courses/${courseId(ITIL)}/progress/students`), 403, 'FORBIDDEN');
    expectProblem(await call('reviewer', 'GET', `/courses/${courseId(ITIL)}/progress`), 403, 'FORBIDDEN');
    assert.deepEqual((await ok<{ items: unknown[] }>('reviewer', 'GET', '/me/progress')).items, [], 'design-team roles are not student enrollments');
    // Administrators may inspect (read-only) but never record completion as or for a student.
    assert.equal(rowOf((await overview('admin', ITIL)).items, 'student')?.completedCount, 7);
    const lesson = await activityId(ITIL, 'Incident and problem management');
    expectProblem(await completion('admin', 'PUT', ITIL, lesson), 403, 'FORBIDDEN');
    expectProblem(await call('admin', 'GET', `/courses/${courseId(ITIL)}/progress`), 403, 'FORBIDDEN');
    assert.equal(await count('SELECT count(*)::int AS n FROM activity_completions WHERE user_id = $1', [as.admin.userId]), 0);
  });

  it('17b. program-management grants alone never expose or change private student progress', async () => {
    const id = courseId(ITIL);
    const programId = (await query<{ programId: string }>('SELECT program_id AS "programId" FROM courses WHERE id = $1', [id]))[0]!.programId;
    // The administrator grants the program that owns the course: to an account without any course role, and to the
    // course's design-team reviewer (a course role that itself has no progress permission).
    for (const email of [PROGRAM_MANAGER.email, ACCOUNTS.reviewer]) await ok('admin', 'POST', `/programs/${programId}/managers`, { email }, 201);
    const managed = await request('GET', '/me/managed-programs', { session: manager });
    assert.deepEqual([managed.statusCode, managed.json().scope, managed.json().items.map((p: { id: string }) => p.id)], [200, 'granted', [programId]], 'the grant is in effect');
    const section = (await progress('student', ITIL)).sections[0]!.sectionId;
    const lesson = await activityId(ITIL, 'Value, outcomes, costs and risks');

    // Program manager without separate course authorization: the course and its students' progress do not exist for them.
    for (const url of [`/courses/${id}/progress/students`, `/courses/${id}/progress`, `/courses/${id}/sections/${section}/progress`, `/courses/${id}/section-prerequisites`]) {
      expectProblem(await request('GET', url, { session: manager }), 404, 'NOT_FOUND');
    }
    expectProblem(await request('PUT', `/courses/${id}/activities/${lesson}/completion`, { session: manager }), 404, 'NOT_FOUND');
    expectProblem(await request('DELETE', `/courses/${id}/activities/${lesson}/completion`, { session: manager }), 404, 'NOT_FOUND');
    expectProblem(await request('PUT', `/courses/${id}/sections/${section}/prerequisites`, { session: manager, body: { requiredSectionIds: [] } }), 403, 'FORBIDDEN');
    assert.deepEqual((await request('GET', '/me/progress', { session: manager })).json().items, []);

    // Design team plus a program grant: still no student progress, own progress or prerequisite changes.
    expectProblem(await call('reviewer', 'GET', `/courses/${id}/progress/students`), 403, 'FORBIDDEN');
    expectProblem(await call('reviewer', 'GET', `/courses/${id}/progress`), 403, 'FORBIDDEN');
    expectProblem(await completion('reviewer', 'PUT', ITIL, lesson), 403, 'FORBIDDEN');
    expectProblem(await call('reviewer', 'PUT', `/courses/${id}/sections/${section}/prerequisites`, { requiredSectionIds: [] }), 403, 'FORBIDDEN');

    // The program-management endpoints themselves carry no progress or student data.
    const subjects = await request('GET', `/course-templates?programId=${programId}&limit=100`, { session: manager });
    assert.equal(subjects.statusCode, 200, subjects.body);
    const template = subjects.json().items[0] as { id: string };
    const bodies = [managed.body, subjects.body, (await request('GET', `/course-templates/${template.id}`, { session: manager })).body, (await request('GET', `/course-templates/${template.id}/versions`, { session: manager })).body];
    for (const body of bodies) {
      assert.doesNotMatch(body, /completedCount|percent|completedAt|continueAt/, 'no progress fields');
      for (const persona of ['student', 'learnerA', 'learnerB'] as const) assert.ok(!body.includes(ACCOUNTS[persona]), 'no student identities');
    }
    assert.equal(await count('SELECT count(*)::int AS n FROM activity_completions WHERE user_id = $1', [manager.userId]), 0);
    assert.equal(rowOf((await overview('instructor', ITIL)).items, 'student')?.completedCount, 7, 'student progress is unchanged');
  });

  it('19. a course without eligible activities reports no percentage', async () => {
    const empty = await ok<CourseProgress>('student', 'GET', `/courses/${emptyCourseId}/progress`);
    assert.deepEqual([empty.completedCount, empty.totalCount, empty.percent, empty.state, empty.continueAt], [0, 0, null, 'no_activities', null]);
    assert.ok(empty.sections.length > 0 && empty.sections.every((s) => s.percent === null && s.state === 'no_activities'));
    const listed = (await ok<{ items: Array<Summary & { courseId: string }> }>('student', 'GET', '/me/progress')).items.find((i) => i.courseId === emptyCourseId);
    assert.deepEqual([listed?.percent, listed?.state], [null, 'no_activities']);
    const rows = await ok<{ totalCount: number; items: StudentRow[] }>('admin', 'GET', `/courses/${emptyCourseId}/progress/students`);
    assert.deepEqual([rows.totalCount, rows.items[0]?.percent, rows.items[0]?.state], [0, null, 'no_activities']);
  });

  it('20. concurrent mark and unmark requests leave consistent progress', async () => {
    const lesson = await activityId(ITIL, 'Incident and problem management');
    const mixed = await Promise.all(['PUT', 'DELETE', 'PUT', 'PUT', 'DELETE', 'PUT', 'DELETE', 'PUT'].map((m) => completion('student', m as 'PUT' | 'DELETE', ITIL, lesson)));
    assert.ok(mixed.every((r) => r.statusCode === 200), mixed.map((r) => r.body).join('\n'));
    const stored = await completionRows(lesson, as.student.userId);
    assert.ok(stored <= 1);
    const module3 = (await progress('student', ITIL)).sections[2]!;
    const listed = (await sectionProgress('student', ITIL, module3.sectionId)).activities.find((a) => a.activityId === lesson)!;
    assert.equal(listed.completed, stored === 1, 'the API reports exactly what is stored');
    assert.equal(module3.completedCount, 2 + stored);
    const marked = await auditCount('activity.completion_marked', lesson);
    const unmarked = await auditCount('activity.completion_unmarked', lesson);
    assert.equal(marked - unmarked, stored, 'every stored change is audited exactly once');
    // Two students marking at the same time do not interfere.
    const [a, b] = await Promise.all([completion('learnerA', 'PUT', ITIL, lesson), completion('learnerB', 'PUT', ITIL, lesson)]);
    assert.deepEqual([a.statusCode, b.statusCode], [200, 200]);
    assert.deepEqual([(await progress('learnerA', ITIL)).completedCount, (await progress('learnerB', ITIL)).completedCount], [3, 3]);
    await completion('student', 'DELETE', ITIL, lesson);
    await Promise.all([completion('learnerA', 'DELETE', ITIL, lesson), completion('learnerB', 'DELETE', ITIL, lesson)]);
  });

  it('21. section prerequisites are enforced by the server on every student content route', async () => {
    const id = courseId(ITIL);
    const [m1, m2, m3] = (await progress('student', ITIL)).sections.map((s) => s.sectionId) as [string, string, string];
    // Courses without prerequisites behave as before.
    assert.equal((await call('learnerB', 'GET', `/courses/${id}/sections/${m3}/activities`)).statusCode, 200);
    expectProblem(await call('instructor', 'PUT', `/courses/${id}/sections/${m2}/prerequisites`, { requiredSectionIds: [m1] }), 403, 'FORBIDDEN');
    assert.deepEqual(await ok('admin', 'PUT', `/courses/${id}/sections/${m2}/prerequisites`, { requiredSectionIds: [m1] }), { sectionId: m2, requiredSectionIds: [m1] });
    await ok('admin', 'PUT', `/courses/${id}/sections/${m3}/prerequisites`, { requiredSectionIds: [m2] });
    assert.equal(await auditCount('section.prerequisites_updated', m2), 1);
    assert.deepEqual((await ok<{ items: unknown[] }>('instructor', 'GET', `/courses/${id}/section-prerequisites`)).items, [
      { sectionId: m2, requiredSectionIds: [m1] },
      { sectionId: m3, requiredSectionIds: [m2] },
    ]);
    expectProblem(await call('learnerB', 'GET', `/courses/${id}/section-prerequisites`), 403, 'FORBIDDEN');

    // Learner B has only the module 3 quiz and assignment (seeded): modules 2 and 3 are locked.
    const locked = await progress('learnerB', ITIL);
    assert.deepEqual(locked.sections.map((s) => s.locked), [false, true, true]);
    assert.deepEqual(locked.sections[1]!.requiredSections, [{ sectionId: m1, title: 'Module 1 - Service management concepts', completed: false }]);
    assert.deepEqual([locked.completedCount, locked.totalCount], [2, 8], 'locked activities still count in the total');
    assert.equal(locked.continueAt?.sectionId, m1, 'continue never points into a locked section');
    assert.deepEqual((await sectionProgress('learnerB', ITIL, m2)).activities, [], 'a locked section names no activities');

    const lesson = await activityId(ITIL, 'The four dimensions of service management');
    const document = await activityId(ITIL, 'Service value chain overview');
    const quiz = await activityId(ITIL, 'Module check: ITIL 4 foundations');
    const assignment = await activityId(ITIL, 'Mapping a service to the value chain');
    const lockedRoutes: Array<[Method, string, unknown?]> = [
      ['GET', `/courses/${id}/sections/${m2}/activities`],
      ['GET', `/courses/${id}/activities/${lesson}`],
      ['GET', `/courses/${id}/activities/${document}/document`],
      ['GET', `/courses/${id}/activities/${document}/document/file`],
      ['PUT', `/courses/${id}/activities/${lesson}/completion`],
      ['POST', `/courses/${id}/activities/${quiz}/attempts`],
      ['GET', `/courses/${id}/activities/${quiz}/attempts/mine`],
      ['GET', `/courses/${id}/activities/${assignment}/submissions/mine`],
    ];
    for (const [method, url, body] of lockedRoutes) {
      const res = await call('learnerB', method, url, body);
      expectProblem(res, 403, 'SECTION_LOCKED');
      assert.ok(!res.body.includes('four dimensions') && !res.body.includes('Module check'), `${method} ${url} reveals no content`);
    }
    // The grade list names no locked activity unless its grade was released.
    const grades = await ok<{ items: Array<{ activityId: string; status: string }> }>('learnerB', 'GET', `/courses/${id}/grades/mine`);
    assert.ok(grades.items.every((item) => ![quiz, assignment].includes(item.activityId) || item.status === 'released'));
    // The tutor does not ground answers in lessons of locked sections.
    const tutorFor = async (who: Persona) =>
      (await ok<{ citations: Array<{ sectionId: string }> }>(who, 'POST', `/courses/${id}/tutor/messages`, { question: 'What are the four dimensions of service management?', language: 'en' })).citations;
    assert.ok(!(await tutorFor('learnerB')).some((c) => c.sectionId === m2 || c.sectionId === m3));
    assert.ok((await tutorFor('student')).some((c) => c.sectionId === m2), 'a student who completed module 1 is grounded in module 2');
    // Staff are never locked.
    assert.equal((await call('instructor', 'GET', `/courses/${id}/sections/${m2}/activities`)).statusCode, 200);

    // Completing module 1 opens module 2 (module 3 still needs module 2).
    for (const title of ['Value, outcomes, costs and risks', 'Reading: ITIL overview']) assert.equal((await completion('learnerB', 'PUT', ITIL, await activityId(ITIL, title))).statusCode, 200);
    const opened = await progress('learnerB', ITIL);
    assert.deepEqual(opened.sections.map((s) => s.locked), [false, false, true]);
    assert.equal((await call('learnerB', 'GET', `/courses/${id}/sections/${m2}/activities`)).statusCode, 200);
    assert.equal((await call('learnerB', 'GET', `/courses/${id}/activities/${lesson}`)).statusCode, 200);
    // Unmarking module 1 locks module 2 again.
    await completion('learnerB', 'DELETE', ITIL, await activityId(ITIL, 'Reading: ITIL overview'));
    expectProblem(await call('learnerB', 'GET', `/courses/${id}/activities/${lesson}`), 403, 'SECTION_LOCKED');

    // A requirement on a hidden section is ignored and never named.
    const hidden = await sectionId(ITIL, 'Instructor notes');
    await ok('admin', 'PUT', `/courses/${id}/sections/${m1}/prerequisites`, { requiredSectionIds: [hidden] });
    const withHidden = await progress('learnerB', ITIL);
    assert.deepEqual([withHidden.sections[0]!.locked, withHidden.sections[0]!.requiredSections], [false, []]);
    await ok('admin', 'PUT', `/courses/${id}/sections/${m1}/prerequisites`, { requiredSectionIds: [] });
    // Other courses are unaffected.
    assert.equal((await call('learnerA', 'GET', `/courses/${courseId(PMF)}/sections/${(await progress('learnerA', PMF)).sections[2]!.sectionId}/activities`)).statusCode, 200);
  });

  it('22. circular, self and cross-course prerequisites are refused', async () => {
    const id = courseId(ITIL);
    const [m1, m2, m3] = (await progress('student', ITIL)).sections.map((s) => s.sectionId) as [string, string, string];
    expectProblem(await call('admin', 'PUT', `/courses/${id}/sections/${m1}/prerequisites`, { requiredSectionIds: [m3] }), 422, 'PREREQUISITE_CYCLE');
    expectProblem(await call('admin', 'PUT', `/courses/${id}/sections/${m1}/prerequisites`, { requiredSectionIds: [m2] }), 422, 'PREREQUISITE_CYCLE');
    expectProblem(await call('admin', 'PUT', `/courses/${id}/sections/${m2}/prerequisites`, { requiredSectionIds: [m2] }), 422, 'PREREQUISITE_SELF');
    const pmfSection = (await progress('student', PMF)).sections[0]!.sectionId;
    expectProblem(await call('admin', 'PUT', `/courses/${id}/sections/${m2}/prerequisites`, { requiredSectionIds: [pmfSection] }), 422, 'PREREQUISITE_SECTION_NOT_FOUND');
    expectProblem(await call('admin', 'PUT', `/courses/${id}/sections/${pmfSection}/prerequisites`, { requiredSectionIds: [] }), 404, 'NOT_FOUND');
    expectProblem(await call('admin', 'PUT', `/courses/${id}/sections/${m2}/prerequisites`, { requiredSectionIds: [m1, m1] }), 400, 'VALIDATION_ERROR');
    // Database backstops: the acyclic trigger, the not-self check and the same-course foreign keys.
    await assert.rejects(
      query('INSERT INTO section_prerequisites (course_id, section_id, required_section_id) VALUES ($1, $2, $3)', [id, m1, m3]),
      /cycle/,
    );
    await assert.rejects(query('INSERT INTO section_prerequisites (course_id, section_id, required_section_id) VALUES ($1, $2, $2)', [id, m1]), /not_self/);
    await assert.rejects(
      query('INSERT INTO section_prerequisites (course_id, section_id, required_section_id) VALUES ($1, $2, $3)', [id, m1, pmfSection]),
      /violates foreign key constraint/,
    );
    assert.deepEqual((await ok<{ items: unknown[] }>('admin', 'GET', `/courses/${id}/section-prerequisites`)).items.length, 2, 'nothing was changed');
    // Removing requirements opens everything again.
    await ok('admin', 'PUT', `/courses/${id}/sections/${m3}/prerequisites`, { requiredSectionIds: [] });
    await ok('admin', 'PUT', `/courses/${id}/sections/${m2}/prerequisites`, { requiredSectionIds: [] });
    assert.ok((await progress('learnerB', ITIL)).sections.every((s) => !s.locked));
  });

  it('inactive enrollments cannot use or change progress; reactivation restores it', async () => {
    const enrollment = (await query<{ id: string }>('SELECT id FROM enrollments WHERE course_id = $1 AND user_id = $2', [courseId(PMF), as.learnerA.userId]))[0]!;
    const lesson = await activityId(PMF, 'What makes work a project');
    await completion('learnerA', 'PUT', PMF, lesson);
    await ok('admin', 'PUT', `/courses/${courseId(PMF)}/enrollments/${enrollment.id}`, { status: 'inactive' });
    expectProblem(await call('learnerA', 'GET', `/courses/${courseId(PMF)}/progress`), 404, 'NOT_FOUND');
    expectProblem(await completion('learnerA', 'DELETE', PMF, lesson), 404, 'NOT_FOUND');
    assert.ok(!rowOf((await overview('instructor', PMF)).items, 'learnerA'), 'inactive students are not listed');
    await ok('admin', 'PUT', `/courses/${courseId(PMF)}/enrollments/${enrollment.id}`, { status: 'active' });
    assert.equal((await progress('learnerA', PMF)).completedCount, 2, 'the mark and the seeded submission are kept');
  });

  it('24. CSRF and Origin protections apply to every progress write', async () => {
    const id = courseId(ITIL);
    const lesson = await activityId(ITIL, 'Incident and problem management');
    const m2 = await sectionId(ITIL, 'Module 2 - The service value system');
    const url = `/courses/${id}/activities/${lesson}/completion`;
    expectProblem(await request('PUT', url, { session: as.student, csrf: null }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await request('PUT', url, { session: as.student, csrf: 'not-the-token' }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await request('DELETE', url, { session: as.student, csrf: null }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await request('PUT', url, { session: as.student, origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
    expectProblem(await request('PUT', url), 401, 'UNAUTHENTICATED');
    expectProblem(await request('GET', `/courses/${id}/progress`), 401, 'UNAUTHENTICATED');
    expectProblem(await request('PUT', `/courses/${id}/sections/${m2}/prerequisites`, { session: as.admin, csrf: null, body: { requiredSectionIds: [] } }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(
      await request('PUT', `/courses/${id}/sections/${m2}/prerequisites`, { session: as.admin, origin: 'https://evil.example', body: { requiredSectionIds: [] } }),
      403,
      'ORIGIN_NOT_ALLOWED',
    );
    assert.equal(await completionRows(lesson, as.student.userId), 0, 'refused requests change nothing');
  });

  it('18. existing grades, attempts, submissions and audit records are unchanged', async () => {
    const same = async (table: string, original: string) => {
      const ids = snapshot.ids[table]!;
      const rows = JSON.stringify(await query(`SELECT * FROM ${table} WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]));
      assert.equal(rows, original, `${table}: every pre-existing row is identical`);
    };
    await same('grades', snapshot.grades);
    await same('quiz_attempts', snapshot.attempts);
    await same('assignment_submissions', snapshot.submissions);
    await same('audit_log', snapshot.audit);
    // The only new attempt and submission are the student's own (tests 6 and 7); progress wrote no grades.
    assert.equal(await count('SELECT count(*)::int AS n FROM quiz_attempts WHERE NOT (id = ANY($1::uuid[]))', [snapshot.ids.quiz_attempts]), 1);
    assert.equal(await count('SELECT count(*)::int AS n FROM assignment_submissions WHERE NOT (id = ANY($1::uuid[]))', [snapshot.ids.assignment_submissions]), 1);
    assert.equal(
      await count("SELECT count(*)::int AS n FROM grades WHERE NOT (id = ANY($1::uuid[])) AND NOT (user_id = $2 AND source = 'quiz')", [snapshot.ids.grades, as.student.userId]),
      0,
      'the only new grade is the server-graded quiz attempt of test 6',
    );
  });
});
