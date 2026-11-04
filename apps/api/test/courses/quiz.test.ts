/**
 * Quizzes and server-side grading against a temporary PostgreSQL database.
 * Skipped unless TEST_DATABASE_URL is set. All users are synthetic; passwords are random per run.
 * Tests run in order and build on each other.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { auditLog, quizAttempts, userCredentials, users } from '../../src/db/schema/index.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const COOKIE = 'ap_session';
const WEB_ORIGIN = 'http://localhost:3000';
const SECRET_FIELDS = /isCorrect|correctAnswer|awardedPoints|"score"|maxScore/;

const EMAILS = {
  admin: DEV_USERS[0]!.email,
  instructor: DEV_USERS[1]!.email,
  student: DEV_USERS[2]!.email,
  reviewer: DEV_USERS[3]!.email,
  assistant: 'assistant@academiapath.example',
  otherStudent: 'student2@academiapath.example',
  outsider: 'student3@academiapath.example',
  otherDesigner: 'designer2@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Session = { token: string; csrfToken: string; userId: string };
type StaffQuestion = { id: string; type: string; points: number; options: Array<{ id: string; text: string; isCorrect: boolean }> };
type Answer = { questionId: string; selectedOptionIds: string[] };

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

describe('quizzes and server-side grading (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  const sessions = new Map<Person, Session>();
  const ids: Record<string, string> = {};
  const id = (key: string) => {
    const value = ids[key];
    assert.ok(value, `missing id ${key}`);
    return value;
  };
  let keyQuestions: StaffQuestion[] = [];

  const session = (person: Person) => {
    const value = sessions.get(person);
    assert.ok(value, `${person} is not signed in`);
    return value;
  };

  const call = (
    who: Person | null,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    options: { payload?: object; csrf?: string | null; headers?: Record<string, string> } = {},
  ) => {
    const current = who ? session(who) : null;
    const csrf = options.csrf === undefined ? current?.csrfToken : options.csrf;
    return app.inject({
      method,
      url: `/api/v1${url}`,
      ...(options.payload ? { payload: options.payload } : {}),
      cookies: current ? { [COOKIE]: current.token } : {},
      headers: { ...(method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {}), ...options.headers },
    });
  };

  const login = async (person: Person) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: EMAILS[person], password: PASSWORD },
      headers: { origin: WEB_ORIGIN },
    });
    const body = expectStatus(res, 200);
    const token = res.cookies.find((cookie) => cookie.name === COOKIE)?.value;
    assert.ok(token);
    sessions.set(person, { token, csrfToken: body.csrfToken, userId: body.user.id });
  };

  const quizUrl = (quizId: string, courseId = id('courseA')) => `/courses/${courseId}/activities/${quizId}`;
  const attemptUrl = (attemptId: string, courseId = id('courseA')) => `/courses/${courseId}/attempts/${attemptId}`;

  const createQuiz = async (settings: object) =>
    expectStatus(await call('instructor', 'POST', `/courses/${id('courseA')}/sections/${id('sectionA')}/activities`, { payload: { type: 'quiz', ...settings } }), 201);
  const addQuestion = async (quizId: string, payload: object) =>
    expectStatus(await call('instructor', 'POST', `${quizUrl(quizId)}/questions`, { payload }), 201) as StaffQuestion;
  const publish = async (quizId: string) => {
    expectStatus(await call('instructor', 'POST', `${quizUrl(quizId)}/submit`), 200);
    expectStatus(await call('reviewer', 'POST', `${quizUrl(quizId)}/review`, { payload: { decision: 'approve' } }), 200);
  };
  const start = (who: Person, quizId: string, courseId?: string) => call(who, 'POST', `${quizUrl(quizId, courseId)}/attempts`);

  /** Answers built from the staff answer key: all correct, all wrong, or a custom chooser. */
  const answersFor = (questions: StaffQuestion[], choose: (q: StaffQuestion) => string[]): Answer[] =>
    questions.map((q) => ({ questionId: q.id, selectedOptionIds: choose(q) }));
  const correctOf = (q: StaffQuestion) => q.options.filter((o) => o.isCorrect).map((o) => o.id);
  const wrongOf = (q: StaffQuestion) => [q.options.find((o) => !o.isCorrect)!.id];

  const resultsFor = async (quizId: string) =>
    expectStatus(await call('instructor', 'GET', `${quizUrl(quizId)}/results`), 200).items as Array<{
      attemptId: string;
      score: number | null;
      maxScore: number;
      status: string;
      closedByTimeLimit: boolean;
      student: { email: string };
    }>;

  before(async () => {
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const passwordHash = await hashPassword(PASSWORD);
    for (const person of ['assistant', 'otherStudent', 'outsider', 'otherDesigner'] as const) {
      const [user] = await database.db.insert(users).values({ email: EMAILS[person], givenName: 'Test', familyName: person }).returning();
      assert.ok(user);
      await database.db.insert(userCredentials).values({ userId: user.id, passwordHash });
    }
    app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: WEB_ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000' }),
      database: database.db,
    });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) await login(person);

    const program = expectStatus(await call('admin', 'POST', '/programs', { payload: { code: 'ING-SIS', name: 'Ingeniería' } }), 201);
    const term = expectStatus(await call('admin', 'POST', '/terms', { payload: { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' } }), 201);
    const template = expectStatus(
      await call('admin', 'POST', '/course-templates', { payload: { code: 'ITIL-F', programId: program.id, title: 'ITIL', sections: [{ title: 'Assessment' }] } }),
      201,
    );
    const course = async (code: string) =>
      expectStatus(await call('admin', 'POST', '/courses', { payload: { programId: program.id, termId: term.id, templateId: template.templateId, code, status: 'published' } }), 201).id as string;
    ids.courseA = await course('ITIL-A');
    ids.courseB = await course('ITIL-B');
    const enroll = async (courseId: string, person: Person, role: string) =>
      expectStatus(await call('admin', 'POST', `/courses/${courseId}/enrollments`, { payload: { email: EMAILS[person], role } }), 201);
    await enroll(id('courseA'), 'instructor', 'instructor');
    await enroll(id('courseA'), 'reviewer', 'design_team');
    await enroll(id('courseA'), 'assistant', 'non_editing_instructor');
    await enroll(id('courseA'), 'student', 'student');
    await enroll(id('courseA'), 'otherStudent', 'student');
    await enroll(id('courseB'), 'outsider', 'student');
    await enroll(id('courseB'), 'otherDesigner', 'design_team');
    ids.sectionA = expectStatus(await call('admin', 'GET', `/courses/${id('courseA')}/sections`), 200).items[0].id;
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  it('1. instructor creates a quiz as a draft with its configuration', async () => {
    const quiz = await createQuiz({ title: 'ITIL check', instructions: 'Answer all questions.', attemptLimit: 2, shuffleQuestions: true, shuffleOptions: true });
    assert.equal(quiz.type, 'quiz');
    assert.equal(quiz.review.status, 'draft');
    assert.deepEqual(quiz.content, {
      instructions: 'Answer all questions.',
      attemptLimit: 2,
      timeLimitMinutes: null,
      shuffleQuestions: true,
      shuffleOptions: true,
      questionCount: 0,
      totalPoints: 0,
    });
    ids.quiz = quiz.id;
  });

  it('2. instructor adds each supported question type (with answer-key validation)', async () => {
    const single = await addQuestion(id('quiz'), {
      type: 'single_choice',
      prompt: 'Which publication defines ITIL 4?',
      points: 2,
      options: [{ text: 'ITIL Foundation', isCorrect: true }, { text: 'PMBOK', isCorrect: false }, { text: 'COBIT', isCorrect: false }],
    });
    const multiple = await addQuestion(id('quiz'), {
      type: 'multiple_choice',
      prompt: 'Which are guiding principles?',
      points: 3,
      options: [{ text: 'Focus on value', isCorrect: true }, { text: 'Keep it simple', isCorrect: true }, { text: 'Work in silos', isCorrect: false }],
    });
    const trueFalse = await addQuestion(id('quiz'), { type: 'true_false', prompt: 'ITIL is a framework.', points: 1, correctAnswer: true });
    assert.deepEqual([single.type, multiple.type, trueFalse.type], ['single_choice', 'multiple_choice', 'true_false']);
    assert.deepEqual(trueFalse.options.map((o) => [o.id, o.isCorrect]), [['true', true], ['false', false]]);
    expectProblem(
      await call('instructor', 'POST', `${quizUrl(id('quiz'))}/questions`, {
        payload: { type: 'single_choice', prompt: 'Bad', points: 1, options: [{ text: 'A', isCorrect: true }, { text: 'B', isCorrect: true }] },
      }),
      422,
      'INVALID_ANSWER_KEY',
    );
    expectProblem(
      await call('instructor', 'POST', `${quizUrl(id('quiz'))}/questions`, { payload: { type: 'essay', prompt: 'Not supported', points: 1 } }),
      400,
      'VALIDATION_ERROR',
    );
    keyQuestions = expectStatus(await call('instructor', 'GET', `${quizUrl(id('quiz'))}/questions`), 200).items;
    assert.equal(keyQuestions.length, 3);
    const quiz = expectStatus(await call('instructor', 'GET', quizUrl(id('quiz'))), 200);
    assert.deepEqual([quiz.content.questionCount, quiz.content.totalPoints], [3, 6]);
  });

  it('3. students cannot access a draft quiz or its questions', async () => {
    expectProblem(await call('student', 'GET', quizUrl(id('quiz'))), 404, 'NOT_FOUND');
    expectProblem(await start('student', id('quiz')), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', `${quizUrl(id('quiz'))}/questions`), 403, 'FORBIDDEN');
    const list = expectStatus(await call('student', 'GET', `/courses/${id('courseA')}/sections/${id('sectionA')}/activities`), 200);
    assert.equal(list.items.length, 0);
  });

  it('4–5. a reviewer approves the quiz; the instructor cannot approve it', async () => {
    const empty = await createQuiz({ title: 'Empty quiz', attemptLimit: 1 });
    expectProblem(await call('instructor', 'POST', `${quizUrl(empty.id)}/submit`), 422, 'QUIZ_HAS_NO_QUESTIONS');

    expectStatus(await call('instructor', 'POST', `${quizUrl(id('quiz'))}/submit`), 200);
    expectProblem(
      await call('instructor', 'POST', `${quizUrl(id('quiz'))}/questions`, { payload: { type: 'true_false', prompt: 'Late', points: 1, correctAnswer: true } }),
      409,
      'ACTIVITY_UNDER_REVIEW',
    );
    expectProblem(await call('instructor', 'POST', `${quizUrl(id('quiz'))}/review`, { payload: { decision: 'approve' } }), 403, 'FORBIDDEN');
    expectProblem(await call('assistant', 'POST', `${quizUrl(id('quiz'))}/review`, { payload: { decision: 'approve' } }), 403, 'FORBIDDEN');
    const approved = expectStatus(await call('reviewer', 'POST', `${quizUrl(id('quiz'))}/review`, { payload: { decision: 'approve' } }), 200);
    assert.equal(approved.review.status, 'approved');
    assert.equal(approved.liveVersion.content.questionCount, 3);
  });

  it('6–7. students access the approved quiz without any answer keys', async () => {
    const quiz = await call('student', 'GET', quizUrl(id('quiz')));
    const body = expectStatus(quiz, 200);
    assert.deepEqual([body.content.questionCount, body.content.totalPoints, body.review], [3, 6, null]);
    assert.ok(!('questions' in body.content));
    assert.doesNotMatch(quiz.body, SECRET_FIELDS);
    const mine = expectStatus(await call('student', 'GET', `${quizUrl(id('quiz'))}/attempts/mine`), 200);
    assert.deepEqual([mine.attemptLimit, mine.attemptsUsed, mine.activeAttemptId], [2, 0, null]);
  });

  it('9–10. a student starts an attempt whose question and option order is stable', async () => {
    const started = await start('student', id('quiz'));
    const attempt = expectStatus(started, 201);
    assert.doesNotMatch(started.body, SECRET_FIELDS, 'no answer keys or scores in the attempt');
    assert.deepEqual([attempt.attemptNumber, attempt.status, attempt.deadlineAt, attempt.resultsReleased], [1, 'in_progress', null, false]);
    assert.equal(attempt.questions.length, 3);
    ids.attempt1 = attempt.id;
    const order = (a: { questions: Array<{ questionId: string; options: Array<{ id: string }> }> }) =>
      a.questions.map((q) => [q.questionId, q.options.map((o) => o.id)]);
    const reloaded = expectStatus(await call('student', 'GET', attemptUrl(id('attempt1'))), 200);
    assert.deepEqual(order(reloaded), order(attempt));
    const resumed = expectStatus(await start('student', id('quiz')), 200);
    assert.equal(resumed.id, attempt.id, 'starting again resumes the active attempt');
    assert.deepEqual(order(resumed), order(attempt));
  });

  it('11, 14–16. correct answers are graded on the server; scores from the browser are rejected; no duplicate grading', async () => {
    const answers = answersFor(keyQuestions, correctOf);
    expectStatus(await call('student', 'PUT', `${attemptUrl(id('attempt1'))}/answers`, { payload: { answers: answers.slice(0, 1) } }), 200);
    expectProblem(
      await call('student', 'POST', `${attemptUrl(id('attempt1'))}/submit`, { payload: { answers, score: 6 } }),
      400,
      'VALIDATION_ERROR',
    );
    expectProblem(
      await call('student', 'POST', `${attemptUrl(id('attempt1'))}/submit`, { payload: { answers: [{ ...answers[0], isCorrect: true }] } }),
      400,
      'VALIDATION_ERROR',
    );
    const submitted = await call('student', 'POST', `${attemptUrl(id('attempt1'))}/submit`, { payload: { answers } });
    const confirmation = expectStatus(submitted, 200);
    assert.equal(confirmation.status, 'submitted');
    assert.ok(confirmation.submittedAt);
    assert.doesNotMatch(submitted.body, SECRET_FIELDS, 'confirmation reveals no score');
    expectProblem(await call('student', 'POST', `${attemptUrl(id('attempt1'))}/submit`, { payload: { answers } }), 409, 'ATTEMPT_NOT_IN_PROGRESS');
    const [result] = (await resultsFor(id('quiz'))).filter((r) => r.attemptId === id('attempt1'));
    assert.deepEqual([result?.score, result?.maxScore], [6, 6]);
    const graded = await database.db.select({ n: count() }).from(auditLog).where(and(eq(auditLog.action, 'quiz.attempt_graded'), eq(auditLog.entityId, id('attempt1'))));
    assert.equal(graded[0]?.n, 1, 'graded exactly once');
  });

  it('12. incorrect answers score zero', async () => {
    const attempt = expectStatus(await start('student', id('quiz')), 201);
    ids.attempt2 = attempt.id;
    expectStatus(await call('student', 'POST', `${attemptUrl(attempt.id)}/submit`, { payload: { answers: answersFor(keyQuestions, wrongOf) } }), 200);
    const [result] = (await resultsFor(id('quiz'))).filter((r) => r.attemptId === attempt.id);
    assert.deepEqual([result?.score, result?.maxScore], [0, 6]);
  });

  it('13. multiple-answer questions require the exact correct selection', async () => {
    const [single, multiple, trueFalse] = keyQuestions;
    assert.ok(single && multiple && trueFalse);
    const attempt = expectStatus(await start('otherStudent', id('quiz')), 201);
    ids.otherAttempt = attempt.id;
    const partial = [correctOf(multiple)[0]!];
    expectStatus(
      await call('otherStudent', 'POST', `${attemptUrl(attempt.id)}/submit`, {
        payload: {
          answers: [
            { questionId: single.id, selectedOptionIds: correctOf(single) },
            { questionId: multiple.id, selectedOptionIds: partial },
            { questionId: trueFalse.id, selectedOptionIds: wrongOf(trueFalse) },
          ],
        },
      }),
      200,
    );
    const detail = expectStatus(await call('instructor', 'GET', `${quizUrl(id('quiz'))}/results/${attempt.id}`), 200);
    assert.equal(detail.score, 2);
    const byQuestion = new Map(detail.questions.map((q: { questionId: string; awardedPoints: number; isCorrect: boolean }) => [q.questionId, [q.awardedPoints, q.isCorrect]]));
    assert.deepEqual(byQuestion.get(single.id), [2, true]);
    assert.deepEqual(byQuestion.get(multiple.id), [0, false], 'partial selection earns nothing');
    assert.deepEqual(byQuestion.get(trueFalse.id), [0, false]);
  });

  it('17. attempt limits are enforced, including under concurrent requests', async () => {
    expectProblem(await start('student', id('quiz')), 409, 'ATTEMPT_LIMIT_REACHED');
    const limited = await createQuiz({ title: 'One try', attemptLimit: 1 });
    await addQuestion(limited.id, { type: 'true_false', prompt: 'Once?', points: 1, correctAnswer: true });
    await publish(limited.id);
    const responses = await Promise.all(Array.from({ length: 6 }, () => start('otherStudent', limited.id)));
    const statuses = responses.map((r) => r.statusCode).sort();
    assert.equal(statuses.filter((s) => s === 201).length, 1, `exactly one attempt created (${statuses.join(',')})`);
    assert.ok(statuses.every((s) => s === 200 || s === 201 || s === 409), statuses.join(','));
    const attemptId = responses.find((r) => r.statusCode === 201)!.json().id;
    expectStatus(await call('otherStudent', 'POST', `${attemptUrl(attemptId)}/submit`, { payload: {} }), 200);
    const again = await Promise.all(Array.from({ length: 4 }, () => start('otherStudent', limited.id)));
    for (const res of again) expectProblem(res, 409, 'ATTEMPT_LIMIT_REACHED');
    const [{ n } = { n: 0 }] = await database.db
      .select({ n: count() })
      .from(quizAttempts)
      .where(and(eq(quizAttempts.activityId, limited.id), eq(quizAttempts.userId, session('otherStudent').userId)));
    assert.equal(n, 1);
  });

  it('18. time limits are enforced by the server clock', async () => {
    const timed = await createQuiz({ title: 'Timed quiz', attemptLimit: 2, timeLimitMinutes: 1 });
    const q = await addQuestion(timed.id, { type: 'true_false', prompt: 'Timed?', points: 1, correctAnswer: true });
    const q2 = await addQuestion(timed.id, { type: 'true_false', prompt: 'Still timed?', points: 1, correctAnswer: true });
    await publish(timed.id);
    const expire = (attemptId: string) =>
      database.pool.query(`UPDATE quiz_attempts SET started_at = now() - interval '5 minutes', deadline_at = now() - interval '2 minutes' WHERE id = $1`, [attemptId]);

    const first = expectStatus(await start('student', timed.id), 201);
    assert.ok(Math.abs(Date.parse(first.deadlineAt) - Date.parse(first.startedAt) - 60_000) < 1000, 'deadline = start + 1 minute');
    expectStatus(await call('student', 'PUT', `${attemptUrl(first.id)}/answers`, { payload: { answers: [{ questionId: q.id, selectedOptionIds: ['true'] }] } }), 200);
    await expire(first.id);
    expectProblem(
      await call('student', 'PUT', `${attemptUrl(first.id)}/answers`, { payload: { answers: [{ questionId: q2.id, selectedOptionIds: ['true'] }] } }),
      409,
      'ATTEMPT_EXPIRED',
    );
    const closed = expectStatus(await call('student', 'GET', attemptUrl(first.id)), 200);
    assert.deepEqual([closed.status, closed.closedByTimeLimit], ['submitted', true]);

    const second = expectStatus(await start('student', timed.id), 201);
    await expire(second.id);
    const late = expectStatus(
      await call('student', 'POST', `${attemptUrl(second.id)}/submit`, {
        payload: { answers: [{ questionId: q.id, selectedOptionIds: ['true'] }, { questionId: q2.id, selectedOptionIds: ['true'] }] },
      }),
      200,
    );
    assert.deepEqual([late.status, late.closedByTimeLimit], ['submitted', true]);
    const results = await resultsFor(timed.id);
    const score = (attemptId: string) => results.find((r) => r.attemptId === attemptId)?.score;
    assert.equal(score(first.id), 1, 'only the answer saved before the deadline counts');
    assert.equal(score(second.id), 0, 'answers sent after the deadline are ignored');
  });

  it('19. cross-course attempts are denied', async () => {
    expectProblem(await start('outsider', id('quiz')), 404, 'NOT_FOUND');
    expectProblem(await start('outsider', id('quiz'), id('courseB')), 404, 'NOT_FOUND');
    expectProblem(await start('student', id('quiz'), id('courseB')), 404, 'NOT_FOUND');
    expectProblem(await call('outsider', 'GET', attemptUrl(id('attempt1'), id('courseB'))), 404, 'NOT_FOUND');
    expectProblem(await call('otherDesigner', 'GET', `${quizUrl(id('quiz'))}/questions`), 404, 'NOT_FOUND');
  });

  it("20–21. students cannot see other students' attempts or any grades", async () => {
    expectProblem(await call('otherStudent', 'GET', attemptUrl(id('attempt1'))), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', `${quizUrl(id('quiz'))}/results`), 403, 'FORBIDDEN');
    expectProblem(await call('student', 'GET', `${quizUrl(id('quiz'))}/results/${id('attempt1')}`), 403, 'FORBIDDEN');
    for (const url of [attemptUrl(id('attempt1')), `${quizUrl(id('quiz'))}/attempts/mine`, quizUrl(id('quiz'))]) {
      const res = await call('student', 'GET', url);
      assert.equal(res.statusCode, 200);
      assert.doesNotMatch(res.body, SECRET_FIELDS, url);
    }
    const own = expectStatus(await call('student', 'GET', attemptUrl(id('attempt1'))), 200);
    assert.equal(own.resultsReleased, false);
  });

  it('22. completed attempts cannot be changed (API and database)', async () => {
    expectProblem(
      await call('student', 'PUT', `${attemptUrl(id('attempt1'))}/answers`, { payload: { answers: [{ questionId: keyQuestions[0]!.id, selectedOptionIds: [] }] } }),
      409,
      'ATTEMPT_NOT_IN_PROGRESS',
    );
    const isRestrict = (error: unknown) => (error as { code?: string }).code === '23001';
    await assert.rejects(database.pool.query(`UPDATE quiz_attempts SET score = 0 WHERE id = $1`, [id('attempt1')]), isRestrict);
    await assert.rejects(database.pool.query(`UPDATE quiz_attempt_answers SET response = '{"optionIds":[]}' WHERE attempt_id = $1`, [id('attempt1')]), isRestrict);
    await assert.rejects(database.pool.query(`DELETE FROM quiz_attempts WHERE id = $1`, [id('attempt1')]), isRestrict);
    const [result] = (await resultsFor(id('quiz'))).filter((r) => r.attemptId === id('attempt1'));
    assert.equal(result?.score, 6, 'score unchanged');
  });

  it('23. attempts require CSRF tokens and an allowed origin', async () => {
    const quiz = await createQuiz({ title: 'CSRF quiz', attemptLimit: 1 });
    await addQuestion(quiz.id, { type: 'true_false', prompt: 'CSRF?', points: 1, correctAnswer: true });
    await publish(quiz.id);
    expectProblem(await call('student', 'POST', `${quizUrl(quiz.id)}/attempts`, { csrf: null }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await call('student', 'POST', `${quizUrl(quiz.id)}/attempts`, { headers: { origin: 'https://evil.example' } }), 403, 'ORIGIN_NOT_ALLOWED');
    const attempt = expectStatus(await start('student', quiz.id), 201);
    expectProblem(await call('student', 'POST', `${attemptUrl(attempt.id)}/submit`, { payload: {}, csrf: 'forged' }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await call(null, 'POST', `${attemptUrl(attempt.id)}/submit`, { payload: {} }), 401, 'UNAUTHENTICATED');
    assert.equal(expectStatus(await call('student', 'GET', attemptUrl(attempt.id)), 200).status, 'in_progress', 'forged requests changed nothing');
  });

  it('enforces staff permissions for questions, results and attempts', async () => {
    assert.equal(expectStatus(await call('assistant', 'GET', `${quizUrl(id('quiz'))}/questions`), 200).items.length, 3);
    assert.ok(expectStatus(await call('assistant', 'GET', `${quizUrl(id('quiz'))}/results`), 200).items.length >= 3);
    expectProblem(
      await call('assistant', 'POST', `${quizUrl(id('quiz'))}/questions`, { payload: { type: 'true_false', prompt: 'X', points: 1, correctAnswer: true } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(await call('reviewer', 'GET', `${quizUrl(id('quiz'))}/results`), 403, 'FORBIDDEN');
    expectProblem(await start('instructor', id('quiz')), 403, 'FORBIDDEN');
    expectProblem(await start('admin', id('quiz')), 403, 'FORBIDDEN');
    assert.ok(expectStatus(await call('admin', 'GET', `${quizUrl(id('quiz'))}/results`), 200).items.length >= 3);
  });

  it('editing an approved quiz never exposes unreviewed questions', async () => {
    await addQuestion(id('quiz'), { type: 'true_false', prompt: 'Unreviewed question', points: 5, correctAnswer: false });
    const staffView = expectStatus(await call('instructor', 'GET', quizUrl(id('quiz'))), 200);
    assert.deepEqual([staffView.review.status, staffView.content.questionCount, staffView.liveVersion.content.questionCount], ['draft', 4, 3]);
    const studentView = expectStatus(await call('otherStudent', 'GET', quizUrl(id('quiz'))), 200);
    assert.deepEqual([studentView.content.questionCount, studentView.content.totalPoints], [3, 6]);
    const attempt = expectStatus(await start('otherStudent', id('quiz')), 201);
    assert.equal(attempt.questions.length, 3);
    assert.ok(attempt.questions.every((q: { prompt: string }) => q.prompt !== 'Unreviewed question'));
  });

  it('24. quiz authoring, attempts and grading are audited', async () => {
    const actions = (await database.db.select({ action: auditLog.action }).from(auditLog)).map((row) => row.action);
    for (const action of ['quiz.question_added', 'activity.submitted', 'activity.approved', 'quiz.attempt_started', 'quiz.attempt_submitted', 'quiz.attempt_graded']) {
      assert.ok(actions.includes(action), action);
    }
    const graded = await database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'quiz.attempt_graded'), inArray(auditLog.entityId, [id('attempt1'), id('attempt2')])));
    assert.deepEqual(
      graded.map((e) => (e.metadata.after as { score: number }).score).sort(),
      [0, 6],
    );
    assert.ok(graded.every((e) => e.actorUserId === session('student').userId));
    // Answer keys never reach the append-only audit log (question changes or approval snapshots).
    const draft = await createQuiz({ title: 'Audit key quiz', attemptLimit: 1 });
    const tf = await addQuestion(draft.id, { type: 'true_false', prompt: 'Key change?', points: 1, correctAnswer: true });
    expectStatus(await call('instructor', 'PUT', `${quizUrl(draft.id)}/questions/${tf.id}`, { payload: { type: 'true_false', prompt: 'Key change?', points: 1, correctAnswer: false } }), 200);
    const [keyChange] = await database.db.select().from(auditLog).where(and(eq(auditLog.action, 'quiz.question_updated'), eq(auditLog.entityId, draft.id)));
    assert.equal((keyChange?.metadata.after as { answerKeyChanged: boolean }).answerKeyChanged, true);
    const approvals = await database.db.select().from(auditLog).where(and(eq(auditLog.action, 'activity.approved'), eq(auditLog.entityId, id('quiz'))));
    assert.ok(approvals.length >= 1);
    assert.deepEqual((approvals[0]!.metadata.after as { liveVersion: { questionIds: string[] } }).liveVersion.questionIds.length, 3);
    for (const entry of await database.db.select().from(auditLog)) {
      assert.doesNotMatch(JSON.stringify(entry.metadata), /correctAnswer|isCorrect/, `${entry.action} must not contain answer keys`);
    }
    const secrets = [PASSWORD, ...[...sessions.values()].flatMap((s) => [s.token, s.csrfToken])];
    const all = await database.db.select().from(auditLog);
    assert.ok(all.every((e) => secrets.every((secret) => !JSON.stringify(e.metadata).includes(secret))), 'no secrets in audit data');
    assert.ok(randomUUID());
  });
});
