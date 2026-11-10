/**
 * Advanced quiz and assessment controls (AP-022) on the synthetic demo dataset, against a temporary
 * PostgreSQL database (skipped unless TEST_DATABASE_URL is set): attempt limits under concurrency,
 * server-side deadlines and request-driven finalization, question pools and per-attempt selection,
 * randomized order with correct scoring, release-gated passing status and feedback without answer keys,
 * question reuse across quizzes, role boundaries, progress and gradebook integration, historical data,
 * CSRF/Origin and audit records.
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
const ITIL = 'ITIL4-F-2026-2-A';
const PMF = 'PMF-2026-2-A';

type App = ReturnType<typeof buildApp>;
type Session = { token: string; csrf: string; userId: string };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type AttemptQuestion = { questionId: string; position: number; prompt: string; points: number; options: Array<{ id: string; text: string }>; selectedOptionIds: string[] };
type Attempt = { id: string; status: string; startedAt: string; deadlineAt: string | null; serverTime: string; questions: AttemptQuestion[] };
type Summary = {
  attemptLimit: number;
  attemptsUsed: number;
  attemptsRemaining: number;
  questionsPerAttempt: number | null;
  passingScorePercent: number | null;
  gradeReleased: boolean;
  passed: boolean | null;
  activeAttemptId: string | null;
  items: Array<{ id: string; status: string; closedByTimeLimit: boolean; feedbackAvailable: boolean }>;
};

describe('assessment controls (PostgreSQL, demo dataset)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let report: DemoReport;
  let app: App;
  const as = {} as Record<Persona, Session>;
  const ids = {} as { pool: string; poolQuestions: string[]; attempt1: string; attempt2: string; module3: string };
  let history: { attempts: string; grades: string; attemptIds: string[]; gradeIds: string[] };

  const courseId = (code: string) => report.courses.find((c) => c.code === code)!.id;
  const request = (method: Method, url: string, options: { session?: Session; body?: unknown; csrf?: string | null; origin?: string | null; headers?: Record<string, string> } = {}) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: options.session ? { ap_session: options.session.token } : {},
      headers: {
        ...(options.origin === null ? {} : { origin: options.origin ?? ORIGIN }),
        ...(options.session && method !== 'GET' && options.csrf !== null ? { 'x-csrf-token': options.csrf ?? options.session.csrf } : {}),
        ...(options.headers ?? {}),
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
  const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[];
  const count = async (sql: string, params: unknown[] = []) => Number((await query<{ n: number }>(sql, params))[0]!.n);
  const c = () => `/courses/${courseId(ITIL)}`;
  const start = (who: Persona, quiz: string) => call(who, 'POST', `${c()}/activities/${quiz}/attempts`);
  const mine = (who: Persona, quiz: string) => ok<Summary>(who, 'GET', `${c()}/activities/${quiz}/attempts/mine`);
  const view = (who: Persona, attempt: string) => ok<Attempt>(who, 'GET', `${c()}/attempts/${attempt}`);
  /** Picks the right option by its text ("Right …"), whatever order the server presented. */
  const answersFor = (attempt: Attempt, correct: (q: AttemptQuestion, index: number) => boolean) =>
    attempt.questions.map((q, index) => ({
      questionId: q.questionId,
      selectedOptionIds: [q.options.find((o) => (correct(q, index) ? o.text.startsWith('Right') : o.text.startsWith('Wrong')))!.id],
    }));
  const expire = (attempt: string) =>
    query(`UPDATE quiz_attempts SET started_at = now() - interval '30 minutes', deadline_at = now() - interval '10 minutes' WHERE id = $1`, [attempt]);
  const audits = (action: string, entityId: string) => count('SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND entity_id = $2', [action, entityId]);
  const assertNoKeys = (body: string, where: string) => {
    assert.doesNotMatch(body, /correctAnswer|"isCorrect"\s*:\s*true,\s*"text"|answerKey/, `${where}: no answer keys`);
    for (const option of JSON.parse(body).questions?.flatMap((q: { options: object[] }) => q.options) ?? []) {
      assert.deepEqual(Object.keys(option).sort(), ['id', 'text'], `${where}: options carry no correctness`);
    }
  };

  before(async () => {
    database = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'ap-assessments-'));
    const env = { NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: join(root, 'store') };
    report = await seedDemo(database.db, { password: PASSWORD, env, uploadFilesDir: null });
    app = buildApp({ config: { ...loadConfig(env), loginRateLimit: { max: 1000, windowMs: 60_000 } }, database: database.db });
    await app.ready();
    for (const persona of Object.keys(ACCOUNTS) as Persona[]) {
      const res = await request('POST', '/auth/login', { body: { email: ACCOUNTS[persona], password: PASSWORD } });
      assert.equal(res.statusCode, 200, res.body);
      as[persona] = { token: res.cookies.find((x) => x.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
    }
    ids.module3 = (await query<{ id: string }>("SELECT id FROM sections WHERE course_id = $1 AND title LIKE 'Module 3%'", [courseId(ITIL)]))[0]!.id;
    history = {
      attempts: JSON.stringify(await query('SELECT * FROM quiz_attempts ORDER BY id')),
      grades: JSON.stringify(await query('SELECT * FROM grades ORDER BY id')),
      attemptIds: (await query<{ id: string }>('SELECT id FROM quiz_attempts')).map((r) => r.id),
      gradeIds: (await query<{ id: string }>('SELECT id FROM grades')).map((r) => r.id),
    };
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('1. existing quizzes keep their behaviour: defaults, every question, no feedback, no threshold', async () => {
    const seeded = (await query<{ id: string }>("SELECT id FROM activities WHERE section_id = $1 AND type = 'quiz'", [ids.module3]))[0]!.id;
    const activity = await ok<{ content: Record<string, unknown> }>('student', 'GET', `${c()}/activities/${seeded}`);
    assert.deepEqual([activity.content.passingScorePercent, activity.content.showFeedback, activity.content.questionsPerAttempt], [null, false, null]);
    const res = await start('student', seeded);
    assert.equal(res.statusCode, 201, res.body);
    const attempt = res.json() as Attempt;
    assert.equal(attempt.questions.length, 3, 'every approved question, as before');
    await ok('student', 'POST', `${c()}/attempts/${attempt.id}/submit`, {});
    const summary = await mine('student', seeded);
    assert.deepEqual([summary.questionsPerAttempt, summary.passingScorePercent, summary.passed, summary.attemptsRemaining], [null, null, null, 1]);
    assert.ok(summary.items.every((item) => item.feedbackAvailable === false));
    const learnerA = await mine('learnerA', seeded);
    assert.ok(learnerA.items.every((item) => item.feedbackAvailable === false), 'historical attempts never gain feedback');
  });

  it('10. creates a pooled quiz; invalid pool sizes and mixed points are refused clearly', async () => {
    const quiz = await ok<{ id: string; content: Record<string, unknown> }>(
      'instructor',
      'POST',
      `${c()}/sections/${ids.module3}/activities`,
      { type: 'quiz', title: 'Pooled check', attemptLimit: 3, timeLimitMinutes: 10, shuffleQuestions: true, shuffleOptions: true, passingScorePercent: 60, showFeedback: true, questionsPerAttempt: 3 },
      201,
    );
    ids.pool = quiz.id;
    assert.deepEqual([quiz.content.passingScorePercent, quiz.content.showFeedback, quiz.content.questionsPerAttempt], [60, true, 3]);
    for (const bad of [{ questionsPerAttempt: 0 }, { questionsPerAttempt: 101 }, { passingScorePercent: 0 }, { passingScorePercent: 101 }]) {
      const res = await call('instructor', 'PUT', `${c()}/activities/${ids.pool}`, { title: 'Pooled check', attemptLimit: 3, ...bad });
      assert.equal(res.statusCode, 400, JSON.stringify(bad));
    }
    // Too few questions for the pool.
    for (let i = 1; i <= 2; i++) {
      await ok('instructor', 'POST', `${c()}/activities/${ids.pool}/questions`, { type: 'single_choice', prompt: `Pool question ${i}`, points: 2, options: [{ text: `Right ${i}`, isCorrect: true }, { text: `Wrong ${i}a`, isCorrect: false }, { text: `Wrong ${i}b`, isCorrect: false }] }, 201);
    }
    expectProblem(await call('instructor', 'POST', `${c()}/activities/${ids.pool}/submit`), 422, 'QUIZ_POOL_TOO_SMALL');
    // Mixed points are refused (every attempt must be worth the same).
    const odd = await ok<{ id: string }>('instructor', 'POST', `${c()}/activities/${ids.pool}/questions`, { type: 'true_false', prompt: 'Pool question 3', points: 5, correctAnswer: true }, 201);
    expectProblem(await call('instructor', 'POST', `${c()}/activities/${ids.pool}/submit`), 422, 'QUIZ_POOL_POINTS_MIXED');
    await ok('instructor', 'DELETE', `${c()}/activities/${ids.pool}/questions/${odd.id}`, undefined, 204);
    for (let i = 3; i <= 5; i++) {
      await ok('instructor', 'POST', `${c()}/activities/${ids.pool}/questions`, { type: 'single_choice', prompt: `Pool question ${i}`, points: 2, options: [{ text: `Right ${i}`, isCorrect: true }, { text: `Wrong ${i}a`, isCorrect: false }, { text: `Wrong ${i}b`, isCorrect: false }] }, 201);
    }
    await ok('instructor', 'POST', `${c()}/activities/${ids.pool}/submit`);
    await ok('reviewer', 'POST', `${c()}/activities/${ids.pool}/review`, { decision: 'approve' });
    ids.poolQuestions = (await query<{ id: string }>('SELECT id FROM quiz_questions WHERE activity_id = $1', [ids.pool])).map((r) => r.id);
    assert.equal(ids.poolQuestions.length, 5);
  });

  it('9, 11, 4–5. each attempt gets a server-chosen, persisted selection that survives refreshes and client clocks', async () => {
    const res = await request('POST', `${c()}/activities/${ids.pool}/attempts`, { session: as.student, headers: { date: 'Sat, 01 Jan 2000 00:00:00 GMT', 'x-client-time': '2000-01-01T00:00:00Z' } });
    assert.equal(res.statusCode, 201, res.body);
    const attempt = res.json() as Attempt;
    ids.attempt1 = attempt.id;
    assert.equal(attempt.questions.length, 3, 'three of the five approved questions');
    assert.equal(new Set(attempt.questions.map((q) => q.questionId)).size, 3);
    assert.ok(attempt.questions.every((q) => ids.poolQuestions.includes(q.questionId)), 'only approved pool questions');
    const deadline = Date.parse(attempt.deadlineAt!);
    assert.ok(Math.abs(deadline - Date.parse(attempt.startedAt) - 10 * 60_000) < 2000, 'deadline = server start + 10 minutes');
    assert.ok(Math.abs(Date.parse(attempt.serverTime) - Date.now()) < 5000, 'server time is reported');
    const [{ max_score: maxScore }] = await query<{ max_score: number }>('SELECT max_score FROM quiz_attempts WHERE id = $1', [attempt.id]) as [{ max_score: number }];
    assert.equal(maxScore, 6);
    // Refresh (and a skewed client clock) changes nothing: same deadline, questions, order and options.
    for (let i = 0; i < 3; i++) {
      const again = await request('GET', `${c()}/attempts/${attempt.id}`, { session: as.student, headers: { date: 'Fri, 01 Jan 2100 00:00:00 GMT' } });
      const body = again.json() as Attempt;
      assert.deepEqual([body.deadlineAt, body.startedAt], [attempt.deadlineAt, attempt.startedAt]);
      assert.deepEqual(body.questions.map((q) => [q.questionId, q.options.map((o) => o.id)]), attempt.questions.map((q) => [q.questionId, q.options.map((o) => o.id)]));
    }
    // Starting again returns the same active attempt; the client cannot choose questions or times.
    const reuse = await start('student', ids.pool);
    assert.deepEqual([reuse.statusCode, reuse.json().id], [200, attempt.id]);
    const forged = await call('student', 'PUT', `${c()}/attempts/${attempt.id}/answers`, { answers: [{ questionId: attempt.questions[0]!.questionId, selectedOptionIds: [] }], deadlineAt: '2100-01-01T00:00:00Z' });
    assert.equal(forged.statusCode, 400);
    const outside = ids.poolQuestions.find((id) => !attempt.questions.some((q) => q.questionId === id))!;
    expectProblem(await call('student', 'PUT', `${c()}/attempts/${attempt.id}/answers`, { answers: [{ questionId: outside, selectedOptionIds: [] }] }), 422, 'INVALID_ANSWER');
    // The selection, order and policy are immutable in the database, even while in progress.
    await assert.rejects(query('UPDATE quiz_attempt_answers SET position = position + 10 WHERE attempt_id = $1', [attempt.id]), /selection of a quiz attempt is immutable/);
    await assert.rejects(query(`UPDATE quiz_attempt_answers SET options = '[]'::jsonb WHERE attempt_id = $1`, [attempt.id]), /immutable/);
    await assert.rejects(query('UPDATE quiz_attempts SET attempt_limit = 10, max_score = 1 WHERE id = $1', [attempt.id]), /policy snapshot of a quiz attempt is immutable/);
    await assert.rejects(query('UPDATE quiz_attempts SET feedback_enabled = false WHERE id = $1', [attempt.id]), /immutable/);
  });

  it('6–8, 18. an expired attempt is finalized on the next request with the answers saved in time; no later answers', async () => {
    const attempt = await view('student', ids.attempt1);
    // Two correct answers and one wrong are saved in time.
    await ok('student', 'PUT', `${c()}/attempts/${attempt.id}/answers`, { answers: answersFor(attempt, (_q, i) => i < 2) });
    await expire(attempt.id);
    // Any later answer is refused, whatever the client clock says.
    const late = await request('PUT', `${c()}/attempts/${attempt.id}/answers`, { session: as.student, body: { answers: answersFor(attempt, () => true) }, headers: { date: 'Sat, 01 Jan 2000 00:00:00 GMT' } });
    expectProblem(late, 409, 'ATTEMPT_EXPIRED');
    const [row] = await query<{ status: string; score: number; closed_by_time_limit: boolean }>('SELECT status, score, closed_by_time_limit FROM quiz_attempts WHERE id = $1', [attempt.id]);
    assert.deepEqual([row!.status, row!.score, row!.closed_by_time_limit], ['submitted', 4, true], 'graded with the answers saved before the deadline');
    expectProblem(await call('student', 'PUT', `${c()}/attempts/${attempt.id}/answers`, { answers: answersFor(attempt, () => true) }), 409, 'ATTEMPT_NOT_IN_PROGRESS');
    expectProblem(await call('student', 'POST', `${c()}/attempts/${attempt.id}/submit`, {}), 409, 'ATTEMPT_NOT_IN_PROGRESS');
    // AP-020: the submitted (time-limited) attempt completes the quiz.
    const progress = await ok<{ sections: Array<{ sectionId: string; completedCount: number }> }>('student', 'GET', `${c()}/progress`);
    const section = await ok<{ activities: Array<{ activityId: string; completed: boolean }> }>('student', 'GET', `${c()}/sections/${ids.module3}/progress`);
    assert.ok(progress.sections.length > 0);
    assert.equal(section.activities.find((a) => a.activityId === ids.pool)?.completed, true);
  });

  it('7. concurrent reads after expiry finalize an attempt exactly once (request-driven, no background job)', async () => {
    const res = await start('learnerB', ids.pool);
    assert.equal(res.statusCode, 201, res.body);
    const attempt = res.json() as Attempt;
    await ok('learnerB', 'PUT', `${c()}/attempts/${attempt.id}/answers`, { answers: answersFor(attempt, () => true) });
    await expire(attempt.id);
    // Progress is the first read: before AP-022 it waited for a quiz-specific read.
    const reads = await Promise.all([
      call('learnerB', 'GET', `${c()}/progress`),
      call('learnerB', 'GET', `${c()}/activities/${ids.pool}/attempts/mine`),
      call('learnerB', 'GET', `${c()}/grades/mine`),
      call('learnerB', 'GET', '/me/progress'),
      call('instructor', 'GET', `${c()}/gradebook?limit=100`),
      call('instructor', 'GET', `${c()}/progress/students?limit=100`),
      call('instructor', 'GET', `${c()}/activities/${ids.pool}/results?limit=100`),
    ]);
    assert.ok(reads.every((r) => r.statusCode === 200), reads.map((r) => `${r.statusCode} ${r.body.slice(0, 120)}`).join('\n'));
    assert.equal(await audits('quiz.attempt_submitted', attempt.id), 1, 'finalized once');
    assert.equal(await audits('quiz.attempt_graded', attempt.id), 1);
    assert.equal(await count('SELECT count(*)::int AS n FROM grades WHERE activity_id = $1 AND user_id = $2', [ids.pool, as.learnerB.userId]), 1);
    const [row] = await query<{ status: string; score: number }>('SELECT status, score FROM quiz_attempts WHERE id = $1', [attempt.id]);
    assert.deepEqual([row!.status, row!.score], ['submitted', 6]);
  });

  it('2–3. attempt limits hold under concurrent starts', async () => {
    for (let round = 1; round <= 3; round++) {
      const results = await Promise.all(Array.from({ length: 6 }, () => start('learnerA', ids.pool)));
      const created = results.filter((r) => r.statusCode === 201);
      assert.equal(created.length, 1, `round ${round}: ${results.map((r) => r.statusCode).join(',')}`);
      assert.ok(results.every((r) => [200, 201, 409].includes(r.statusCode)), results.map((r) => r.body).join('\n'));
      await ok('learnerA', 'POST', `${c()}/attempts/${created[0]!.json().id}/submit`, {});
    }
    const final = await Promise.all(Array.from({ length: 4 }, () => start('learnerA', ids.pool)));
    assert.ok(final.every((r) => r.statusCode === 409 && r.json().code === 'ATTEMPT_LIMIT_REACHED'));
    assert.equal(await count('SELECT count(*)::int AS n FROM quiz_attempts WHERE activity_id = $1 AND user_id = $2', [ids.pool, as.learnerA.userId]), 3);
    const summary = await mine('learnerA', ids.pool);
    assert.deepEqual([summary.attemptsUsed, summary.attemptsRemaining], [3, 0]);
  });

  it('12. randomized question and option order never changes the scoring key', async () => {
    const res = await start('student', ids.pool);
    const attempt = res.json() as Attempt;
    ids.attempt2 = attempt.id;
    const submitted = await ok<Attempt>('student', 'POST', `${c()}/attempts/${attempt.id}/submit`, { answers: answersFor(attempt, () => true) });
    assert.equal(submitted.status, 'submitted');
    const results = await ok<{ items: Array<{ attemptId: string; score: number; maxScore: number; passed: boolean | null; passingScorePercent: number | null }> }>(
      'instructor',
      'GET',
      `${c()}/activities/${ids.pool}/results?limit=100`,
    );
    const mineResult = results.items.find((item) => item.attemptId === attempt.id)!;
    assert.deepEqual([mineResult.score, mineResult.maxScore, mineResult.passed, mineResult.passingScorePercent], [6, 6, true, 60]);
    const first = results.items.find((item) => item.attemptId === ids.attempt1)!;
    assert.deepEqual([first.score, first.passed], [4, true], '4 of 6 = 66.7% ≥ 60%');
    // Orders differed between attempts at least once across the learners (shuffling is active), yet every score is exact.
    const orders = await query<{ attempt_id: string; ids: string }>(
      "SELECT attempt_id, string_agg(question_id::text, ',' ORDER BY position) AS ids FROM quiz_attempt_answers a JOIN quiz_attempts q ON q.id = a.attempt_id WHERE q.activity_id = $1 GROUP BY attempt_id",
      [ids.pool],
    );
    assert.ok(new Set(orders.map((o) => o.ids)).size > 1, 'attempts received different selections or orders');
  });

  it('13–14. no answer keys, no early passing status or feedback; feedback only after release and never the key', async () => {
    // Before release.
    for (const body of [(await call('student', 'GET', `${c()}/attempts/${ids.attempt1}`)).body, (await call('student', 'GET', `${c()}/activities/${ids.pool}/attempts/mine`)).body]) {
      assert.doesNotMatch(body, /correctAnswer|isCorrect|awardedPoints|"score"/, 'student views never carry keys or scores');
    }
    const before = await mine('student', ids.pool);
    assert.deepEqual([before.gradeReleased, before.passed], [false, null]);
    assert.ok(before.items.every((item) => !item.feedbackAvailable));
    expectProblem(await call('student', 'GET', `${c()}/attempts/${ids.attempt1}/feedback`), 403, 'FEEDBACK_NOT_AVAILABLE');
    expectProblem(await call('student', 'GET', `${c()}/activities/${ids.pool}/questions`), 403, 'FORBIDDEN');
    expectProblem(await call('student', 'GET', `${c()}/activities/${ids.pool}/results`), 403, 'FORBIDDEN');
    const grades = await ok<{ items: Array<{ activityId: string; status: string; grade: unknown }> }>('student', 'GET', `${c()}/grades/mine`);
    assert.deepEqual(grades.items.find((i) => i.activityId === ids.pool), { activityId: ids.pool, title: 'Pooled check', type: 'quiz', status: 'pending', grade: null });

    // Release, then review.
    await ok('instructor', 'POST', `${c()}/activities/${ids.pool}/grades/release`);
    const afterRelease = await mine('student', ids.pool);
    assert.deepEqual([afterRelease.gradeReleased, afterRelease.passed], [true, true], 'best attempt 6/6');
    assert.ok(afterRelease.items.every((item) => item.feedbackAvailable));
    const feedback = await call('student', 'GET', `${c()}/attempts/${ids.attempt1}/feedback`);
    assert.equal(feedback.statusCode, 200, feedback.body);
    assertNoKeys(feedback.body, 'feedback');
    const review = feedback.json() as { score: number; maxScore: number; passed: boolean; questions: Array<{ isCorrect: boolean; awardedPoints: number; selectedOptionIds: string[] }> };
    assert.deepEqual([review.score, review.maxScore, review.passed], [4, 6, true]);
    assert.deepEqual(review.questions.map((q) => q.isCorrect).sort(), [false, true, true]);
    // An attempt made after the release stays without feedback until the next release.
    const third = (await start('student', ids.pool)).json() as Attempt;
    await ok('student', 'POST', `${c()}/attempts/${third.id}/submit`, { answers: answersFor(third, () => false) });
    expectProblem(await call('student', 'GET', `${c()}/attempts/${third.id}/feedback`), 403, 'FEEDBACK_NOT_AVAILABLE');
    const exhausted = await mine('student', ids.pool);
    assert.deepEqual([exhausted.attemptsRemaining, exhausted.items.find((i) => i.id === third.id)?.feedbackAvailable], [0, false]);
    expectProblem(await start('student', ids.pool), 409, 'ATTEMPT_LIMIT_REACHED');
    // Exhausting attempts keeps the grade and the completion.
    const section = await ok<{ activities: Array<{ activityId: string; completed: boolean }> }>('student', 'GET', `${c()}/sections/${ids.module3}/progress`);
    assert.equal(section.activities.find((a) => a.activityId === ids.pool)?.completed, true);
    assert.equal(await count('SELECT count(*)::int AS n FROM grades WHERE activity_id = $1 AND user_id = $2 AND points = 6', [ids.pool, as.student.userId]), 1);
  });

  it('15–17. students only see their own attempts; design team gets no results; no management outside assigned courses', async () => {
    expectProblem(await call('learnerA', 'GET', `${c()}/attempts/${ids.attempt1}`), 404, 'NOT_FOUND');
    expectProblem(await call('learnerA', 'GET', `${c()}/attempts/${ids.attempt1}/feedback`), 404, 'NOT_FOUND');
    for (const url of [`${c()}/activities/${ids.pool}/results`, `${c()}/activities/${ids.pool}/results/${ids.attempt1}`, `${c()}/gradebook`]) {
      expectProblem(await call('reviewer', 'GET', url), 403, 'FORBIDDEN');
    }
    expectProblem(await call('reviewer', 'GET', `${c()}/attempts/${ids.attempt1}/feedback`), 403, 'FORBIDDEN');
    expectProblem(await call('ta', 'POST', `${c()}/activities/${ids.pool}/questions/import`, { sourceActivityId: ids.pool }), 403, 'FORBIDDEN');
    // A course the instructor is not assigned to: invisible, so nothing can be managed there.
    const itil = await ok<{ programId: string; termId: string; templateId: string }>('admin', 'GET', c());
    const other = await ok<{ id: string }>('admin', 'POST', '/courses', { programId: itil.programId, termId: itil.termId, templateId: itil.templateId, code: 'ITIL4-F-2026-2-Q', title: 'Unassigned', status: 'published' }, 201);
    const otherSection = (await query<{ id: string }>('SELECT id FROM sections WHERE course_id = $1 LIMIT 1', [other.id]))[0]!.id;
    expectProblem(await call('instructor', 'POST', `/courses/${other.id}/sections/${otherSection}/activities`, { type: 'quiz', title: 'X', attemptLimit: 1 }), 404, 'NOT_FOUND');
    expectProblem(await call('instructor', 'GET', `/courses/${other.id}/activities/${ids.pool}/results`), 404, 'NOT_FOUND');
  });

  it('reuses approved questions from another quiz of the same course only (question pools)', async () => {
    const seeded = (await query<{ id: string }>("SELECT id FROM activities WHERE section_id = $1 AND type = 'quiz' AND id <> $2", [ids.module3, ids.pool]))[0]!.id;
    const draft = await ok<{ id: string }>('instructor', 'POST', `${c()}/sections/${ids.module3}/activities`, { type: 'quiz', title: 'Reuse target', attemptLimit: 1, questionsPerAttempt: 2 }, 201);
    const imported = await ok<{ items: Array<{ id: string; prompt: string; options: Array<{ isCorrect: boolean }> }> }>('instructor', 'POST', `${c()}/activities/${draft.id}/questions/import`, { sourceActivityId: seeded });
    assert.equal(imported.items.length, 3);
    assert.ok(imported.items.every((q) => q.options.some((o) => o.isCorrect)), 'staff copies keep their answer keys');
    assert.equal(await audits('quiz.questions_imported', draft.id), 1);
    const audit = (await query<{ metadata: object }>("SELECT metadata FROM audit_log WHERE action = 'quiz.questions_imported' AND entity_id = $1", [draft.id]))[0]!;
    assert.doesNotMatch(JSON.stringify(audit.metadata), /correctAnswer|optionIds/, 'the audit log never stores answer keys');
    // Not from itself, not from an unapproved quiz, not from another course, not by students.
    expectProblem(await call('instructor', 'POST', `${c()}/activities/${draft.id}/questions/import`, { sourceActivityId: draft.id }), 422, 'QUIZ_SOURCE_INVALID');
    const unapproved = await ok<{ id: string }>('instructor', 'POST', `${c()}/sections/${ids.module3}/activities`, { type: 'quiz', title: 'Unapproved', attemptLimit: 1 }, 201);
    expectProblem(await call('instructor', 'POST', `${c()}/activities/${draft.id}/questions/import`, { sourceActivityId: unapproved.id }), 422, 'QUIZ_SOURCE_INVALID');
    const pmfQuiz = (await query<{ id: string }>("SELECT a.id FROM activities a JOIN sections s ON s.id = a.section_id WHERE s.course_id = $1 AND a.type = 'quiz' LIMIT 1", [courseId(PMF)]))[0]!.id;
    expectProblem(await call('instructor', 'POST', `${c()}/activities/${draft.id}/questions/import`, { sourceActivityId: pmfQuiz }), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'POST', `${c()}/activities/${draft.id}/questions/import`, { sourceActivityId: seeded }), 403, 'FORBIDDEN');
    // Imported questions reach students only after this quiz is reviewed and approved.
    expectProblem(await start('student', draft.id), 404, 'NOT_FOUND');
  });

  it('19. the gradebook counts the best attempt and uses the per-attempt maximum of a pooled quiz', async () => {
    const book = await ok<{ columns: Array<{ activityId: string; maxPoints: number }>; items: Array<{ student: { email: string }; cells: Array<{ activityId: string; points: number | null; maxPoints: number | null }> }> }>(
      'instructor',
      'GET',
      `${c()}/gradebook?limit=100`,
    );
    assert.equal(book.columns.find((col) => col.activityId === ids.pool)?.maxPoints, 6, '3 questions × 2 points, not the 10-point bank');
    const cell = (email: string) => book.items.find((row) => row.student.email === email)!.cells.find((x) => x.activityId === ids.pool)!;
    assert.deepEqual([cell(ACCOUNTS.student).points, cell(ACCOUNTS.student).maxPoints], [6, 6], 'best of 4/6, 6/6 and 0/6');
    assert.deepEqual([cell(ACCOUNTS.learnerB).points, cell(ACCOUNTS.learnerB).maxPoints], [6, 6]);
    assert.deepEqual([cell(ACCOUNTS.learnerA).points, cell(ACCOUNTS.learnerA).maxPoints], [0, 6]);
  });

  it('a grade release first finalizes attempts whose time ran out, so they are included', async () => {
    const quiz = await ok<{ id: string }>('instructor', 'POST', `${c()}/sections/${ids.module3}/activities`, { type: 'quiz', title: 'Release check', attemptLimit: 1, timeLimitMinutes: 5, showFeedback: true }, 201);
    await ok('instructor', 'POST', `${c()}/activities/${quiz.id}/questions`, { type: 'single_choice', prompt: 'Release question', points: 3, options: [{ text: 'Right r', isCorrect: true }, { text: 'Wrong r', isCorrect: false }] }, 201);
    await ok('instructor', 'POST', `${c()}/activities/${quiz.id}/submit`);
    await ok('reviewer', 'POST', `${c()}/activities/${quiz.id}/review`, { decision: 'approve' });
    const attempt = (await start('learnerB', quiz.id)).json() as Attempt;
    await ok('learnerB', 'PUT', `${c()}/attempts/${attempt.id}/answers`, { answers: answersFor(attempt, () => true) });
    await expire(attempt.id);
    const released = await ok<{ releasedCount: number }>('instructor', 'POST', `${c()}/activities/${quiz.id}/grades/release`);
    assert.equal(released.releasedCount, 1, 'the expired attempt was graded and released');
    const summary = await mine('learnerB', quiz.id);
    assert.deepEqual([summary.gradeReleased, summary.items[0]?.status, summary.items[0]?.feedbackAvailable], [true, 'submitted', true]);
  });

  it('21. CSRF and Origin protect the new write; audit records are written', async () => {
    const url = `${c()}/activities/${ids.pool}/questions/import`;
    expectProblem(await request('POST', url, { session: as.instructor, csrf: null, body: { sourceActivityId: ids.pool } }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await request('POST', url, { session: as.instructor, origin: 'https://evil.example', body: { sourceActivityId: ids.pool } }), 403, 'ORIGIN_NOT_ALLOWED');
    expectProblem(await request('GET', `${c()}/attempts/${ids.attempt1}/feedback`), 401, 'UNAUTHENTICATED');
    const started = (await query<{ metadata: { after: { questionIds: string[]; maxScore: number } } }>("SELECT metadata FROM audit_log WHERE action = 'quiz.attempt_started' AND entity_id = $1", [ids.attempt1]))[0]!;
    assert.deepEqual([started.metadata.after.questionIds.length, started.metadata.after.maxScore], [3, 6], 'the selection is audited (ids only)');
  });

  it('20. historical attempts and grades are unchanged', async () => {
    const attempts = JSON.stringify(await query('SELECT * FROM quiz_attempts WHERE id = ANY($1::uuid[]) ORDER BY id', [history.attemptIds]));
    const grades = JSON.stringify(await query('SELECT * FROM grades WHERE id = ANY($1::uuid[]) ORDER BY id', [history.gradeIds]));
    assert.equal(attempts, history.attempts);
    assert.equal(grades, history.grades);
  });
});
