/**
 * Advanced gradebook (AP-023) and the AP-022 consistency fixes, against a temporary PostgreSQL database
 * (skipped unless TEST_DATABASE_URL is set; the pure calculation tests always run). Synthetic users and a
 * controlled API server clock. Tests run in order and build on each other.
 *
 * Course A (known numbers): quiz Q1 (5 × 2 points = 10), assignment E1 (rubric 6 + 4 = 10) and
 * assignment E2 (rubric 10). Students: S1 = 8, 7, 5; S2 = 0 (earned), E1 awaiting grading, E2 not
 * submitted; S3 nothing (and a formula-like name for the CSV test). Course B holds the quiz threshold,
 * timer-boundary and question-pool checks.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { userCredentials, users } from '../../src/db/schema/index.js';
import { csvField, neutralizeFormula, toCsv } from '../../src/grading/csv.js';
import { computeCourseGrade, percentOf, type PolicyCategory } from '../../src/grading/policy.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const DAY = 24 * 60 * 60 * 1000;
const FORMULA_NAME = '=HYPERLINK("http://evil.example","x")';

const EMAILS = {
  admin: DEV_USERS[0]!.email,
  instructor: DEV_USERS[1]!.email,
  s1: DEV_USERS[2]!.email,
  reviewer: DEV_USERS[3]!.email,
  assistant: 'assistant@academiapath.example',
  s2: 'student2@academiapath.example',
  s3: 'student3@academiapath.example',
  pm: 'program.manager@academiapath.example',
  instructorB: 'instructor2@academiapath.example',
  outsider: 'outsider@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Session = { token: string; csrf: string; userId: string };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Cell = { activityId: string; status: string; points: number | null; maxPoints: number | null; grade20: number | null; revision: number | null };
type CourseGrade = {
  method: string;
  status: string;
  grade20: number | null;
  percent: number | null;
  countedItems: number;
  gradedItems: number;
  pendingItems: number;
  categories: Array<{ name: string; weightPercent: number; points: number; maxPoints: number; gradedItems: number; percent: number | null; grade20: number | null }>;
};
type Row = { student: { id: string; email: string }; cells: Cell[]; total: { points: number; maxPoints: number; grade20: number | null }; courseGrade: CourseGrade; counts: Record<string, number> };
type Book = { policy: { status: string; method: string }; columns: Array<{ activityId: string; maxPoints: number; categoryId: string | null }>; items: Row[] };

// ------------------------------------------------------------------------------------ pure calculation

describe('course grade calculation (exact numbers)', () => {
  const columns = ['q1', 'e1', 'e2', 'lab'].map((activityId) => ({ activityId, visible: true }));
  const cats = (spec: Array<[string, number, string[]]>): PolicyCategory[] => spec.map(([name, weightPercent, activityIds], position) => ({ id: name, name, weightPercent, position, activityIds }));
  const grades = (values: Record<string, [number, number, boolean?]>) => (activityId: string) => {
    const value = values[activityId];
    return { counted: value ? { points: value[0], maxPoints: value[1], final: value[2] ?? false } : null, exists: value !== undefined };
  };

  it('points method: unchanged unweighted sum, converted once', () => {
    const result = computeCourseGrade(columns, null, grades({ q1: [8, 10], e1: [7, 10], e2: [5, 10] }));
    assert.deepEqual([result.method, result.grade20, result.percent, result.gradedItems, result.pendingItems], ['points', 13.3, 66.7, 3, 4]);
  });

  it('weighted: 40 % × 80 % + 60 % × 60 % = 68.0 % = 13.6 / 20', () => {
    const result = computeCourseGrade(columns, cats([['Quizzes', 40, ['q1']], ['Assignments', 60, ['e1', 'e2']]]), grades({ q1: [8, 10], e1: [7, 10], e2: [5, 10] }));
    assert.deepEqual([result.method, result.percent, result.grade20, result.countedItems], ['weighted', 68, 13.6, 3]);
    assert.deepEqual(result.categories.map((c) => [c.name, c.points, c.maxPoints, c.percent, c.grade20]), [['Quizzes', 8, 10, 80, 16], ['Assignments', 12, 20, 60, 12]]);
  });

  it('a category without graded work is left out and the other weights are scaled (no division by zero)', () => {
    const result = computeCourseGrade(columns, cats([['Quizzes', 30, ['q1']], ['Assignments', 60, ['e1', 'e2']], ['Labs', 10, ['lab']]]), grades({ q1: [8, 10], e1: [7, 10], e2: [5, 10] }));
    // (30 × 0.8 + 60 × 0.6) / 90 = 0.6667 → 66.7 %, 13.3 / 20; Labs has no grade: null, not 0 %.
    assert.deepEqual([result.percent, result.grade20], [66.7, 13.3]);
    assert.deepEqual(result.categories.map((c) => c.percent), [80, 60, null]);
    const empty = computeCourseGrade(columns, cats([['Quizzes', 40, ['q1']], ['Assignments', 60, ['e1', 'e2']]]), grades({}));
    assert.deepEqual([empty.grade20, empty.percent, empty.status, empty.categories.map((c) => c.percent)], [null, null, 'provisional', [null, null]]);
  });

  it('an earned zero counts; ungraded work is never zero', () => {
    const zero = computeCourseGrade(columns, cats([['Quizzes', 40, ['q1']], ['Assignments', 60, ['e1', 'e2']]]), grades({ q1: [0, 10] }));
    assert.deepEqual([zero.grade20, zero.percent, zero.gradedItems, zero.categories[1]!.percent], [0, 0, 1, null]);
  });

  it('rounds once, half up, with exact arithmetic (no floating-point drift)', () => {
    // 1/3 weighted 50/50 with 2/3: (50 × 1/3 + 50 × 2/3) / 100 = 0.5 exactly → 10.0 / 20.
    const half = computeCourseGrade(columns, cats([['A', 50, ['q1']], ['B', 50, ['e1']]]), grades({ q1: [1, 3], e1: [2, 3] }));
    assert.deepEqual([half.percent, half.grade20], [50, 10]);
    // 33 × 0.5 + 67 × 0.55 = 53.35 → 53.4 % (half up), 10.67 → 10.7.
    const up = computeCourseGrade(columns, cats([['A', 33, ['q1']], ['B', 67, ['e1']]]), grades({ q1: [1, 2], e1: [11, 20] }));
    assert.deepEqual([up.percent, up.grade20], [53.4, 10.7]);
    assert.equal(percentOf(2, 3), 66.7);
    assert.equal(percentOf(1, 8), 12.5);
  });

  it('final only when every required counted activity has a released, current grade', () => {
    const all = grades({ q1: [8, 10, true], e1: [7, 10, true], e2: [5, 10, true] });
    const weighted = cats([['Quizzes', 40, ['q1']], ['Assignments', 60, ['e1', 'e2']]]);
    assert.equal(computeCourseGrade(columns, weighted, all).status, 'final', 'the uncategorized lab does not count');
    assert.equal(computeCourseGrade(columns, null, all).status, 'provisional', 'points method: the visible lab is still pending');
    const hiddenLab = columns.map((column) => (column.activityId === 'lab' ? { ...column, visible: false } : column));
    assert.equal(computeCourseGrade(hiddenLab, null, all).status, 'final', 'a hidden activity without a grade is not required');
    assert.equal(computeCourseGrade(columns, weighted, grades({ q1: [8, 10, true], e1: [7, 10, false], e2: [5, 10, true] })).status, 'provisional');
  });

  it('neutralizes spreadsheet formulas in CSV text and quotes every field', () => {
    for (const value of ['=1+2', '+1', '-1', '@SUM(A1)', '\t=1', '\r=1', '  =1']) assert.ok(neutralizeFormula(value).startsWith("'"), JSON.stringify(value));
    for (const value of ['Ana', 'a=b', '1-2', 'student@x.example']) assert.equal(neutralizeFormula(value), value);
    assert.equal(csvField('say "hi"'), '"say ""hi"""');
    assert.equal(csvField(null), '""');
    assert.equal(csvField(-5), '"-5"', 'numbers are written as numbers');
    assert.equal(toCsv([['a', 1]]), '﻿"a","1"\r\n');
  });
});

// ------------------------------------------------------------------------------------ PostgreSQL

describe('advanced gradebook (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  /** The controlled API server clock: the real time unless a test pins it. */
  let pinned: Date | null = null;
  const sessions = {} as Record<Person, Session>;
  const ids = {} as Record<string, string> & { sectionA: string; sectionB: string; courseA: string; courseB: string };
  const progressBefore: Record<string, string> = {};

  const request = (who: Person | null, method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const session = who ? sessions[who] : null;
    return app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: session ? { ap_session: session.token } : {},
      headers: { origin: ORIGIN, ...(session && method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}), ...headers },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
  };
  const ok = async <T = any>(who: Person, method: Method, url: string, body?: unknown, status = 200): Promise<T> => {
    const res = await request(who, method, url, body);
    assert.equal(res.statusCode, status, `${method} ${url} as ${who}: ${res.body}`);
    return (res.body ? res.json() : null) as T;
  };
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };
  const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[];
  const count = async (sql: string, params: unknown[] = []) => Number((await query<{ n: number }>(sql, params))[0]!.n);
  const audits = (action: string, entityId?: string) =>
    count(`SELECT count(*)::int AS n FROM audit_log WHERE action = $1 ${entityId ? 'AND entity_id = $2' : ''}`, entityId ? [action, entityId] : [action]);

  const A = () => `/courses/${ids.courseA}`;
  const B = () => `/courses/${ids.courseB}`;
  const book = () => ok<Book>('instructor', 'GET', `${A()}/gradebook?limit=100`);
  const rowOf = (data: Book, who: Person) => data.items.find((item) => item.student.id === sessions[who].userId)!;
  const cellOf = (row: Row, activity: string) => row.cells.find((cell) => cell.activityId === ids[activity])!;
  const savePolicy = async (who: Person, status: 'draft' | 'published', categories: Array<[string, number, string[]]>, expected?: number) => {
    const current = await ok<{ version: number }>('instructor', 'GET', `${A()}/grading-policy`);
    return request(who, 'PUT', `${A()}/grading-policy`, {
      expectedVersion: expected ?? current.version,
      status,
      categories: categories.map(([name, weightPercent, activities]) => ({ name, weightPercent, activityIds: activities.map((key) => ids[key] ?? key) })),
    });
  };
  const STANDARD: Array<[string, number, string[]]> = [['Quizzes', 40, ['q1']], ['Assignments', 60, ['e1', 'e2']]];

  /** Creates and approves a quiz of single-choice questions ("Right n" is correct). */
  const makeQuiz = async (course: string, section: string, title: string, settings: Record<string, unknown>, questions: number, points: number, instructor: Person = 'instructor') => {
    const quiz = await ok<{ id: string }>(instructor, 'POST', `${course}/sections/${section}/activities`, { type: 'quiz', title, attemptLimit: 1, ...settings }, 201);
    for (let i = 1; i <= questions; i++) {
      await ok(instructor, 'POST', `${course}/activities/${quiz.id}/questions`, {
        type: 'single_choice',
        prompt: `${title} question ${i}`,
        points,
        options: [{ text: `Right ${i}`, isCorrect: true }, { text: `Wrong ${i}`, isCorrect: false }],
      }, 201);
    }
    await ok(instructor, 'POST', `${course}/activities/${quiz.id}/submit`);
    await ok('reviewer', 'POST', `${course}/activities/${quiz.id}/review`, { decision: 'approve' });
    return quiz.id;
  };
  type Attempt = { id: string; deadlineAt: string | null; startedAt: string; serverTime: string; status: string; questions: Array<{ questionId: string; options: Array<{ id: string; text: string }> }> };
  const answers = (attempt: Attempt, correct: number) =>
    attempt.questions.map((q, index) => ({ questionId: q.questionId, selectedOptionIds: [q.options.find((o) => o.text.startsWith(index < correct ? 'Right' : 'Wrong'))!.id] }));
  const takeQuiz = async (who: Person, course: string, quiz: string, correct: number) => {
    const attempt = await ok<Attempt>(who, 'POST', `${course}/activities/${quiz}/attempts`, undefined, 201);
    await ok(who, 'POST', `${course}/attempts/${attempt.id}/submit`, { answers: answers(attempt, correct) });
    return attempt.id;
  };
  const makeAssignment = async (title: string, rubric: number[]) => {
    const assignment = await ok<{ id: string }>('instructor', 'POST', `${A()}/sections/${ids.sectionA}/activities`, {
      type: 'assignment',
      title,
      instructions: 'Write a short analysis.',
      dueAt: new Date(Date.now() + 7 * DAY).toISOString(),
      rubric: rubric.map((maxPoints, i) => ({ title: `Criterion ${i + 1}`, maxPoints })),
    }, 201);
    await ok('instructor', 'POST', `${A()}/activities/${assignment.id}/submit`);
    await ok('reviewer', 'POST', `${A()}/activities/${assignment.id}/review`, { decision: 'approve' });
    return assignment.id;
  };
  const gradeWork = async (who: Person, assignment: string, scores: number[], feedback = 'Synthetic feedback.') => {
    const page = await ok<{ items: Array<{ id: string; student: { id: string } }> }>('instructor', 'GET', `${A()}/activities/${ids[assignment]}/submissions`);
    const submission = page.items.find((item) => item.student.id === sessions[who].userId)!;
    const detail = await ok<{ rubric: Array<{ id: string }> }>('instructor', 'GET', `${A()}/activities/${ids[assignment]}/submissions/${submission.id}`);
    await ok('instructor', 'PUT', `${A()}/activities/${ids[assignment]}/submissions/${submission.id}/grade`, {
      scores: detail.rubric.map((criterion, i) => ({ criterionId: criterion.id, points: scores[i]! })),
      feedback,
    });
  };

  before(async () => {
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const passwordHash = await hashPassword(PASSWORD);
    const extra: Array<[Person, string]> = [['assistant', 'Asistente'], ['s2', 'Second'], ['s3', FORMULA_NAME], ['pm', 'Manager'], ['instructorB', 'Other'], ['outsider', 'Outside']];
    for (const [person, givenName] of extra) {
      const [user] = await database.db.insert(users).values({ email: EMAILS[person], givenName, familyName: 'Synthetic' }).returning();
      await database.db.insert(userCredentials).values({ userId: user!.id, passwordHash });
    }
    app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000' }),
      database: database.db,
      clock: () => pinned ?? new Date(),
    });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAILS[person], password: PASSWORD }, headers: { origin: ORIGIN } });
      assert.equal(res.statusCode, 200, res.body);
      sessions[person] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
    }
    const program = await ok('admin', 'POST', '/programs', { code: 'GB-23', name: 'Gradebook program' }, 201);
    ids.program = program.id;
    const term = await ok('admin', 'POST', '/terms', { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' }, 201);
    const template = await ok('admin', 'POST', '/course-templates', { code: 'GB-T', programId: program.id, title: 'Gradebook', sections: [{ title: 'Evaluation' }] }, 201);
    const course = async (code: string) => (await ok('admin', 'POST', '/courses', { programId: program.id, termId: term.id, templateId: template.templateId, code, status: 'published' }, 201)).id as string;
    ids.courseA = await course('GB-A');
    ids.courseB = await course('GB-B');
    const enroll = (courseId: string, person: Person, role: string) => ok('admin', 'POST', `/courses/${courseId}/enrollments`, { email: EMAILS[person], role }, 201);
    for (const [person, role] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['assistant', 'non_editing_instructor'], ['s1', 'student'], ['s2', 'student'], ['s3', 'student']] as const) await enroll(ids.courseA, person, role);
    for (const [person, role] of [['instructorB', 'instructor'], ['reviewer', 'design_team'], ['outsider', 'student']] as const) await enroll(ids.courseB, person, role);
    // A program manager of the courses' program, with no course role.
    await ok('admin', 'POST', `/programs/${program.id}/managers`, { email: EMAILS.pm }, 201);
    ids.sectionA = (await ok('admin', 'GET', `${A()}/sections`)).items[0].id;
    ids.sectionB = (await ok('admin', 'GET', `${B()}/sections`)).items[0].id;

    ids.q1 = await makeQuiz(A(), ids.sectionA, 'Q1', {}, 5, 2);
    ids.e1 = await makeAssignment('E1', [6, 4]);
    ids.e2 = await makeAssignment('E2', [10]);
    await takeQuiz('s1', A(), ids.q1, 4); // 8 / 10
    await takeQuiz('s2', A(), ids.q1, 0); // an earned 0 / 10
    for (const [who, assignment] of [['s1', 'e1'], ['s1', 'e2'], ['s2', 'e1']] as const) {
      await ok(who, 'POST', `${A()}/activities/${ids[assignment]}/submissions`, { body: `Work of ${who} for ${assignment}.` }, 201);
    }
    await gradeWork('s1', 'e1', [4, 3]); // 7 / 10
    await gradeWork('s1', 'e2', [5]); // 5 / 10
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  it('1. without a policy the course grade is the unchanged unweighted calculation', async () => {
    assert.deepEqual(await ok('instructor', 'GET', `${A()}/grading-policy`), { status: 'none', version: 0, publishedAt: null, updatedAt: null, totalWeightPercent: 0, categories: [] });
    const data = await book();
    assert.deepEqual([data.policy.status, data.policy.method], ['none', 'points']);
    const s1 = rowOf(data, 's1');
    assert.deepEqual([s1.total.points, s1.total.maxPoints, s1.total.grade20], [20, 30, 13.3]);
    assert.deepEqual([s1.courseGrade.method, s1.courseGrade.grade20, s1.courseGrade.percent, s1.courseGrade.status], ['points', 13.3, 66.7, 'provisional']);
    for (const row of data.items) assert.equal(row.courseGrade.grade20, row.total.grade20, 'courseGrade equals the original total without a policy');
    for (const who of ['s1', 's2'] as const) progressBefore[who] = JSON.stringify(await ok(who, 'GET', `${A()}/progress`));
  });

  it('3. invalid weight totals are rejected; a draft may total anything and never affects grades', async () => {
    problem(await savePolicy('instructor', 'published', [['Quizzes', 40, ['q1']], ['Assignments', 50, ['e1', 'e2']]]), 422, 'GRADE_WEIGHTS_INVALID');
    problem(await savePolicy('instructor', 'published', []), 422, 'GRADE_WEIGHTS_INVALID');
    problem(await savePolicy('instructor', 'published', [['Quizzes', 40, ['q1']], ['Assignments', 70, ['e1', 'e2']]]), 422, 'GRADE_WEIGHTS_INVALID');
    for (const weight of [0, 101, 40.5]) problem(await savePolicy('instructor', 'published', [['Quizzes', weight, ['q1']], ['Assignments', 60, ['e1']]]), 400, 'VALIDATION_ERROR');
    problem(await savePolicy('instructor', 'draft', [[' ', 50, []]]), 400, 'VALIDATION_ERROR');
    const draft = await savePolicy('instructor', 'draft', [['Quizzes', 40, ['q1']], ['Assignments', 50, ['e1', 'e2']]]);
    assert.equal(draft.statusCode, 200, draft.body);
    assert.deepEqual([draft.json().status, draft.json().version, draft.json().totalWeightPercent], ['draft', 1, 90]);
    const data = await book();
    assert.deepEqual([data.policy.status, data.policy.method, rowOf(data, 's1').courseGrade.grade20], ['draft', 'points', 13.3]);
    assert.ok(data.columns.every((column) => column.categoryId === null), 'draft categories are not applied');
  });

  it('4. duplicate memberships, duplicate names, foreign activities and stale versions are rejected', async () => {
    problem(await savePolicy('instructor', 'published', [['Quizzes', 40, ['q1', 'e1']], ['Assignments', 60, ['e1', 'e2']]]), 422, 'GRADE_CATEGORY_ACTIVITY_DUPLICATE');
    problem(await savePolicy('instructor', 'draft', [['Quizzes', 40, ['q1']], ['quizzes', 60, ['e1']]]), 422, 'GRADE_CATEGORY_DUPLICATE');
    problem(await savePolicy('instructor', 'draft', [['Quizzes', 40, ['q1', 'q1']]]), 400, 'VALIDATION_ERROR');
    problem(await savePolicy('instructor', 'draft', [['Quizzes', 40, [randomUUID()]]]), 422, 'GRADE_CATEGORY_ACTIVITY_INVALID');
    const otherCourseQuiz = await makeQuiz(B(), ids.sectionB, 'Foreign', {}, 1, 1, 'instructorB');
    ids.foreignQuiz = otherCourseQuiz;
    problem(await savePolicy('instructor', 'draft', [['Quizzes', 40, [otherCourseQuiz]]]), 422, 'GRADE_CATEGORY_ACTIVITY_INVALID');
    problem(await savePolicy('instructor', 'draft', STANDARD, 0), 409, 'GRADING_POLICY_CONFLICT');
    // Concurrent saves from the same version: exactly one wins.
    const results = await Promise.all([savePolicy('instructor', 'draft', STANDARD, 1), savePolicy('admin', 'draft', STANDARD, 1)]);
    assert.deepEqual(results.map((res) => res.statusCode).sort(), [200, 409]);
    assert.equal((await ok('instructor', 'GET', `${A()}/grading-policy`)).version, 2);
  });

  it('2. a valid weighting policy is published (40 % quizzes, 60 % assignments)', async () => {
    const res = await savePolicy('instructor', 'published', STANDARD);
    assert.equal(res.statusCode, 200, res.body);
    const policy = res.json();
    assert.deepEqual([policy.status, policy.version, policy.totalWeightPercent], ['published', 3, 100]);
    assert.ok(policy.publishedAt);
    assert.deepEqual(policy.categories.map((c: { name: string; weightPercent: number; activityIds: string[] }) => [c.name, c.weightPercent, c.activityIds.length]), [['Quizzes', 40, 1], ['Assignments', 60, 2]]);
    const data = await book();
    assert.deepEqual([data.policy.status, data.policy.method], ['published', 'weighted']);
    assert.ok(data.columns.every((column) => column.categoryId !== null));
  });

  it('5. weighted calculation matches the worked example; historical scores are untouched', async () => {
    const before = JSON.stringify(await query('SELECT id, points, max_points, revision, released_revision FROM grades ORDER BY id'));
    const s1 = rowOf(await book(), 's1');
    assert.deepEqual(s1.courseGrade.categories.map((c) => [c.name, c.points, c.maxPoints, c.percent, c.grade20]), [['Quizzes', 8, 10, 80, 16], ['Assignments', 12, 20, 60, 12]]);
    assert.deepEqual([s1.courseGrade.method, s1.courseGrade.percent, s1.courseGrade.grade20], ['weighted', 68, 13.6]);
    assert.deepEqual([s1.total.grade20, s1.total.points], [13.3, 20], 'the unweighted total is unchanged');
    // An empty category (no activities) is safe and scales the other weights.
    assert.equal((await savePolicy('instructor', 'published', [['Quizzes', 30, ['q1']], ['Assignments', 60, ['e1', 'e2']], ['Labs', 10, []]])).statusCode, 200);
    const scaled = rowOf(await book(), 's1').courseGrade;
    assert.deepEqual([scaled.percent, scaled.grade20, scaled.categories[2]!.percent, scaled.categories[2]!.gradedItems], [66.7, 13.3, null, 0]);
    assert.equal((await savePolicy('instructor', 'published', STANDARD)).statusCode, 200);
    assert.equal(JSON.stringify(await query('SELECT id, points, max_points, revision, released_revision FROM grades ORDER BY id')), before, 'grades never change');
  });

  it('6–8. pending work is excluded (not zero), an earned zero counts, and empty categories stay null', async () => {
    const data = await book();
    const s2 = rowOf(data, 's2');
    assert.deepEqual([cellOf(s2, 'q1').points, cellOf(s2, 'q1').status], [0, 'unreleased']);
    assert.deepEqual([cellOf(s2, 'e1').points, cellOf(s2, 'e1').status], [null, 'needs_grading']);
    assert.deepEqual([cellOf(s2, 'e2').points, cellOf(s2, 'e2').status], [null, 'not_submitted']);
    assert.deepEqual(s2.courseGrade.categories.map((c) => [c.name, c.percent, c.gradedItems]), [['Quizzes', 0, 1], ['Assignments', null, 0]]);
    assert.deepEqual([s2.courseGrade.grade20, s2.courseGrade.percent, s2.courseGrade.gradedItems, s2.courseGrade.pendingItems], [0, 0, 1, 3]);
    assert.deepEqual(s2.counts, { notSubmitted: 1, needsGrading: 1, unreleased: 1, released: 0 });
    const s3 = rowOf(data, 's3');
    assert.deepEqual([s3.courseGrade.grade20, s3.courseGrade.percent, s3.courseGrade.gradedItems, s3.total.grade20], [null, null, 0, null], 'no work is never a zero');
    assert.ok(s3.courseGrade.categories.every((c) => c.percent === null && c.grade20 === null));
  });

  it('14. unreleased results never reach students (grades, course grade, passing status, feedback)', async () => {
    const mine = await request('s1', 'GET', `${A()}/grades/mine`);
    assert.equal(mine.statusCode, 200, mine.body);
    const body = mine.json();
    assert.ok(body.items.every((item: { grade: unknown; passed: unknown; workStatus: string }) => item.grade === null && item.passed === null && item.workStatus === 'submitted'));
    assert.deepEqual([body.courseGrade.grade20, body.courseGrade.percent, body.courseGrade.gradedItems, body.courseGrade.status], [null, null, 0, 'provisional']);
    assert.ok(body.courseGrade.categories.every((c: { points: number; percent: number | null }) => c.points === 0 && c.percent === null));
    assert.doesNotMatch(mine.body, /Synthetic feedback|"points":\s*[1-9]/);
    assert.deepEqual(body.policy.categories.map((c: { name: string; weightPercent: number }) => [c.name, c.weightPercent]), [['Quizzes', 40], ['Assignments', 60]]);
    const summary = await ok('s1', 'GET', `${A()}/activities/${ids.q1}/attempts/mine`);
    assert.deepEqual([summary.passed, summary.releasedPassingScorePercent, summary.gradeReleased], [null, null, false]);
    const submission = await ok('s1', 'GET', `${A()}/activities/${ids.e1}/submissions/mine`);
    assert.deepEqual([submission.submission.gradeStatus, submission.submission.grade], ['pending', null]);
    const s3 = await ok('s3', 'GET', `${A()}/grades/mine`);
    assert.ok(s3.items.every((item: { workStatus: string }) => item.workStatus === 'not_submitted'));
  });

  it('10–12. course authorization: other instructors, the design team, administrators, non-editing instructors and program managers', async () => {
    const reads = [`${A()}/gradebook`, `${A()}/grading-policy`, `${A()}/gradebook/students/${sessions.s1.userId}`, `${A()}/gradebook/export.csv`];
    for (const url of reads) {
      problem(await request('instructorB', 'GET', url), 404, 'NOT_FOUND');
      problem(await request('pm', 'GET', url), 404, 'NOT_FOUND');
      problem(await request('reviewer', 'GET', url), 403, 'FORBIDDEN');
      assert.equal((await request('assistant', 'GET', url)).statusCode, 200, `non-editing instructor reads ${url}`);
      assert.equal((await request('admin', 'GET', url)).statusCode, 200, `administrator reads ${url}`);
      problem(await request(null, 'GET', url), 401, 'UNAUTHENTICATED');
    }
    const item = { activityId: ids.q1, userId: sessions.s1.userId, revision: 1 };
    problem(await request('pm', 'POST', `${A()}/grades/release`, { items: [item] }), 404, 'NOT_FOUND');
    problem(await request('pm', 'GET', `${A()}/grades/mine`), 404, 'NOT_FOUND');
    problem(await request('instructorB', 'POST', `${A()}/grades/release`, { items: [item] }), 404, 'NOT_FOUND');
    problem(await request('pm', 'PUT', `${A()}/grading-policy`, { expectedVersion: 0, status: 'draft', categories: [] }), 404, 'NOT_FOUND');
    // Non-editing instructors: read-only (no policy changes, no release of any kind).
    problem(await savePolicy('assistant', 'published', STANDARD), 403, 'FORBIDDEN');
    problem(await request('assistant', 'POST', `${A()}/grades/release`, { items: [item] }), 403, 'FORBIDDEN');
    problem(await request('assistant', 'POST', `${A()}/activities/${ids.q1}/grades/release`), 403, 'FORBIDDEN');
    problem(await savePolicy('reviewer', 'published', STANDARD), 403, 'FORBIDDEN');
    // Administrators configure (and read) but never release: release needs the course role.
    assert.equal((await savePolicy('admin', 'published', STANDARD)).statusCode, 200);
    problem(await request('admin', 'POST', `${A()}/grades/release`, { items: [item] }), 403, 'FORBIDDEN');
    assert.equal(await count('SELECT count(*)::int AS n FROM grades WHERE released_revision IS NOT NULL'), 0, 'nothing was released');
  });

  it('13. students cannot reach other students’ grades or staff views', async () => {
    for (const url of [`${A()}/gradebook`, `${A()}/grading-policy`, `${A()}/gradebook/students/${sessions.s2.userId}`, `${A()}/gradebook/students/${sessions.s1.userId}`, `${A()}/gradebook/export.csv`]) {
      problem(await request('s1', 'GET', url), 403, 'FORBIDDEN');
    }
    problem(await request('s1', 'POST', `${A()}/grades/release`, { items: [{ activityId: ids.q1, userId: sessions.s1.userId, revision: 1 }] }), 403, 'FORBIDDEN');
    problem(await savePolicy('s1', 'published', STANDARD), 403, 'FORBIDDEN');
    problem(await request('outsider', 'GET', `${A()}/grades/mine`), 404, 'NOT_FOUND');
    const own = await request('s2', 'GET', `${A()}/grades/mine`);
    assert.doesNotMatch(own.body, new RegExp(sessions.s1.userId), 'no other student data');
  });

  it('15. bulk release releases only eligible grades and reports every other item', async () => {
    // Regrading S1's E1 makes revision 1 stale.
    await gradeWork('s1', 'e1', [5, 3]); // now 8 / 10, revision 2
    const releaseUrl = `${A()}/grades/release`;
    const S = (who: Person) => sessions[who].userId;
    problem(await request('instructor', 'POST', releaseUrl, { items: [] }), 400, 'VALIDATION_ERROR');
    problem(await request('instructor', 'POST', releaseUrl, { items: [{ activityId: ids.q1, userId: S('s1'), revision: 1 }, { activityId: ids.q1, userId: S('s1'), revision: 1 }] }), 400, 'VALIDATION_ERROR');
    problem(await request('instructor', 'POST', releaseUrl, { items: [{ activityId: ids.q1, userId: S('s1'), revision: 1 }, { activityId: ids.q1, userId: S('s1'), revision: 2 }] }), 422, 'GRADE_RELEASE_DUPLICATE');
    problem(await request('instructor', 'POST', releaseUrl, { items: [{ activityId: ids.q1, userId: S('s1'), revision: 1 }] }, { origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
    const noCsrf = await app.inject({ method: 'POST', url: `/api/v1${releaseUrl}`, cookies: { ap_session: sessions.instructor.token }, headers: { origin: ORIGIN }, payload: { items: [{ activityId: ids.q1, userId: S('s1'), revision: 1 }] } });
    problem(noCsrf, 403, 'CSRF_TOKEN_INVALID');
    const items = [
      { activityId: ids.q1, userId: S('s1'), revision: 1 },
      { activityId: ids.e1, userId: S('s1'), revision: 1 },
      { activityId: ids.e1, userId: S('s2'), revision: 1 },
      { activityId: ids.e2, userId: S('s3'), revision: 1 },
      { activityId: randomUUID(), userId: S('s1'), revision: 1 },
      { activityId: ids.foreignQuiz, userId: S('outsider'), revision: 1 },
    ];
    const result = await ok('instructor', 'POST', releaseUrl, { items });
    assert.deepEqual(result.results.map((r: { outcome: string }) => r.outcome), ['released', 'stale', 'not_graded', 'not_graded', 'not_found', 'not_found']);
    assert.equal(result.releasedCount, 1);
    assert.equal(await count('SELECT count(*)::int AS n FROM grades WHERE released_revision IS NOT NULL'), 1);
    // Repeating the request is safe: nothing new is released or audited.
    const auditsBefore = await audits('grade.released');
    const again = await ok('instructor', 'POST', releaseUrl, { items });
    assert.deepEqual([again.releasedCount, again.results[0].outcome], [0, 'already_released']);
    assert.equal(await audits('grade.released'), auditsBefore);
    // The quiz release recorded which attempt was released.
    const [row] = await query<{ same: boolean }>('SELECT released_quiz_attempt_id = quiz_attempt_id AS same FROM grades WHERE activity_id = $1 AND user_id = $2', [ids.q1, S('s1')]);
    assert.equal(row!.same, true);
  });

  it('16. concurrent release requests release each grade exactly once', async () => {
    const data = await book();
    const pending = data.items.flatMap((row) =>
      row.cells.filter((cell) => cell.status === 'unreleased' || cell.status === 'changed_since_release').map((cell) => ({ activityId: cell.activityId, userId: row.student.id, revision: cell.revision! })),
    );
    assert.equal(pending.length, 3, 'S1 E1 (rev 2), S1 E2 and S2 Q1');
    const auditsBefore = await audits('grade.released');
    const results = await Promise.all(Array.from({ length: 4 }, () => request('instructor', 'POST', `${A()}/grades/release`, { items: pending })));
    const released = results.map((res) => {
      assert.equal(res.statusCode, 200, res.body);
      return res.json().releasedCount as number;
    });
    assert.equal(released.reduce((a, b) => a + b, 0), 3, `released ${released.join(',')}`);
    assert.equal(await audits('grade.released'), auditsBefore + 3);
    assert.equal(await count('SELECT count(*)::int AS n FROM grades WHERE released_revision = revision'), 4);
  });

  it('9. provisional versus final: final only when every counted grade is released and current', async () => {
    const data = await book();
    const s1 = rowOf(data, 's1');
    // S1: Q1 8/10, E1 8/10, E2 5/10 → 40 × 0.8 + 60 × 0.65 = 71.0 % = 14.2 / 20, all released.
    assert.deepEqual([s1.courseGrade.status, s1.courseGrade.percent, s1.courseGrade.grade20, s1.courseGrade.pendingItems], ['final', 71, 14.2, 0]);
    assert.equal(rowOf(data, 's2').courseGrade.status, 'provisional');
    const mine = await ok('s1', 'GET', `${A()}/grades/mine`);
    assert.deepEqual([mine.courseGrade.status, mine.courseGrade.grade20, mine.courseGrade.method], ['final', 14.2, 'weighted']);
    assert.ok(mine.items.every((item: { workStatus: string }) => item.workStatus === 'released'));
    // A regrade after release makes it provisional again for staff and student, who keeps seeing the released value.
    await gradeWork('s1', 'e2', [9]);
    const staff = rowOf(await book(), 's1').courseGrade;
    assert.deepEqual([staff.status, staff.grade20], ['provisional', 16.6]);
    const student = (await ok('s1', 'GET', `${A()}/grades/mine`)).courseGrade;
    assert.deepEqual([student.status, student.grade20], ['provisional', 14.2]);
    const drill = await ok('instructor', 'GET', `${A()}/gradebook/students/${sessions.s1.userId}`);
    assert.deepEqual([drill.courseGrade.grade20, drill.releasedCourseGrade.grade20], [16.6, 14.2], 'the drilldown shows both');
    const e2 = drill.activities.find((a: { activity: { activityId: string } }) => a.activity.activityId === ids.e2);
    assert.deepEqual([e2.status, e2.grade.points, e2.released.points, e2.grade.revision, e2.released.revision], ['changed_since_release', 9, 5, 2, 1]);
    // Individual release from the drilldown (one item).
    const single = await ok('instructor', 'POST', `${A()}/grades/release`, { items: [{ activityId: ids.e2, userId: sessions.s1.userId, revision: e2.grade.revision }] });
    assert.equal(single.releasedCount, 1);
    assert.equal((await ok('s1', 'GET', `${A()}/grades/mine`)).courseGrade.grade20, 16.6);
  });

  it('17. policy changes and releases are audited', async () => {
    const policyAudits = await query<{ before: unknown; after: { status: string; categories: unknown[] } }>(
      "SELECT metadata->'before' AS before, metadata->'after' AS after FROM audit_log WHERE action = 'grading_policy.updated' AND entity_id = $1 ORDER BY created_at, id",
      [ids.courseA],
    );
    assert.ok(policyAudits.length >= 6);
    assert.equal(policyAudits[0]!.before, null, 'the first save has no previous policy');
    assert.equal(policyAudits.at(-1)!.after.status, 'published');
    assert.ok((await audits('grades.released_selection', ids.courseA)) >= 3);
    const [release] = await query<{ actor: string; after: { via: string; points: number } }>(
      "SELECT actor_user_id AS actor, metadata->'after' AS after FROM audit_log WHERE action = 'grade.released' ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    assert.deepEqual([release!.actor, release!.after.via, release!.after.points], [sessions.instructor.userId, 'selection', 9]);
    assert.equal(await count("SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'grade%' AND metadata::text ~ 'Right|Wrong'"), 0, 'no answer data in audits');
  });

  it('18. CSV export: authorization, stable columns and formula neutralization', async () => {
    problem(await request(null, 'GET', `${A()}/gradebook/export.csv`), 401, 'UNAUTHENTICATED');
    const res = await request('assistant', 'GET', `${A()}/gradebook/export.csv`);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /^text\/csv; charset=utf-8/);
    assert.equal(res.headers['content-disposition'], 'attachment; filename="gradebook-GB-A.csv"');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(res.body.startsWith('﻿'));
    const lines = res.body.slice(1).trimEnd().split('\r\n');
    const parse = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
    const header = parse(lines[0]!);
    assert.deepEqual(header, [
      'student_id', 'student_email', 'student_name',
      'A1 Q1 [quiz] points', 'A1 Q1 [quiz] max_points', 'A1 Q1 [quiz] status',
      'A2 E1 [assignment] points', 'A2 E1 [assignment] max_points', 'A2 E1 [assignment] status',
      'A3 E2 [assignment] points', 'A3 E2 [assignment] max_points', 'A3 E2 [assignment] status',
      'Category Quizzes (40%) percent', 'Category Assignments (60%) percent',
      'course_grade_method', 'course_grade_0_20', 'course_grade_percent', 'course_grade_status',
      'graded_items', 'pending_items', 'released_items', 'unreleased_items', 'needs_grading_items',
    ]);
    assert.equal(lines.length, 4, 'header + three students of this course only');
    const byEmail = new Map(lines.slice(1).map((line) => { const fields = parse(line); return [fields[1]!, fields]; }));
    assert.deepEqual(byEmail.get(EMAILS.s1)!.slice(3), ['8', '10', 'released', '8', '10', 'released', '9', '10', 'released', '80', '85', 'weighted', '16.6', '83', 'final', '3', '0', '3', '0', '0']);
    assert.deepEqual(byEmail.get(EMAILS.s2)!.slice(3, 12), ['0', '10', 'released', '', '10', 'needs_grading', '', '10', 'not_submitted']);
    const s3 = byEmail.get(EMAILS.s3)!;
    assert.equal(s3[2], `'${FORMULA_NAME} Synthetic`, 'formula-like text is neutralized');
    assert.equal(s3[17], 'provisional');
    assert.doesNotMatch(res.body, /Right \d|Wrong \d|Synthetic feedback|outsider/, 'no answer keys, feedback or other courses');
    assert.ok((await audits('gradebook.exported', ids.courseA)) >= 1);
  });

  it('19. historical quiz pass/fail uses the threshold saved with the attempt, everywhere', async () => {
    const quiz = await makeQuiz(B(), ids.sectionB, 'Threshold', { attemptLimit: 3, passingScorePercent: 60, showFeedback: true }, 5, 1, 'instructorB');
    const first = await takeQuiz('outsider', B(), quiz, 3); // 3 / 5 = 60 %: passes at 60
    await ok('instructorB', 'POST', `${B()}/activities/${quiz}/grades/release`);
    // The instructor raises the threshold to 80 % and the quiz is approved again.
    const activity = await ok('instructorB', 'GET', `${B()}/activities/${quiz}`);
    await ok('instructorB', 'PUT', `${B()}/activities/${quiz}`, { title: activity.title, attemptLimit: 3, passingScorePercent: 80, showFeedback: true });
    await ok('instructorB', 'POST', `${B()}/activities/${quiz}/submit`);
    await ok('reviewer', 'POST', `${B()}/activities/${quiz}/review`, { decision: 'approve' });
    const summary = await ok('outsider', 'GET', `${B()}/activities/${quiz}/attempts/mine`);
    assert.deepEqual([summary.passingScorePercent, summary.releasedPassingScorePercent, summary.passed], [80, 60, true], 'not retroactively failed');
    const results = await ok('instructorB', 'GET', `${B()}/activities/${quiz}/results`);
    const attempt = results.items.find((item: { attemptId: string }) => item.attemptId === first);
    assert.deepEqual([attempt.passingScorePercent, attempt.passed], [60, true]);
    const mine = await ok('outsider', 'GET', `${B()}/grades/mine`);
    assert.equal(mine.items.find((item: { activityId: string }) => item.activityId === quiz).passed, true);
    const drill = await ok('instructorB', 'GET', `${B()}/gradebook/students/${sessions.outsider.userId}`);
    const row = drill.activities.find((a: { activity: { activityId: string } }) => a.activity.activityId === quiz);
    assert.deepEqual([row.passingScorePercent, row.passed], [60, true]);
    const feedback = await ok('outsider', 'GET', `${B()}/attempts/${first}/feedback`);
    assert.equal(feedback.passed, true);
    // A new attempt with the same 60 % is judged by 80 % and fails; the released (best, earliest) result still passes.
    await takeQuiz('outsider', B(), quiz, 3);
    await ok('instructorB', 'POST', `${B()}/activities/${quiz}/grades/release`);
    const later = await ok('outsider', 'GET', `${B()}/activities/${quiz}/attempts/mine`);
    assert.deepEqual([later.releasedPassingScorePercent, later.passed], [60, true]);
    const second = (await ok('instructorB', 'GET', `${B()}/activities/${quiz}/results`)).items.find((item: { attemptNumber: number }) => item.attemptNumber === 2);
    assert.deepEqual([second.passingScorePercent, second.passed], [80, false]);
    // The database refuses to change a saved threshold.
    await assert.rejects(query('UPDATE quiz_attempts SET passing_score_percent = 80 WHERE id = $1', [first]), /immutable/);
  });

  it('20. timer: answers are accepted up to the deadline instant and never after (no grace period)', async () => {
    const quiz = await makeQuiz(B(), ids.sectionB, 'Timed', { attemptLimit: 3, timeLimitMinutes: 1 }, 2, 1, 'instructorB');
    const base = new Date(Math.floor(Date.now() / 1000) * 1000);
    const save = (attempt: Attempt, correct: number) => request('outsider', 'PUT', `${B()}/attempts/${attempt.id}/answers`, { answers: answers(attempt, correct) });
    const stored = async (attemptId: string) => (await query<{ n: number }>('SELECT count(*)::int AS n FROM quiz_attempt_answers WHERE attempt_id = $1 AND response IS NOT NULL', [attemptId]))[0]!.n;

    // Attempt 1: a save exactly at the deadline is accepted; one millisecond later it is refused.
    pinned = base;
    const first = await ok<Attempt>('outsider', 'POST', `${B()}/activities/${quiz}/attempts`, undefined, 201);
    const deadline = Date.parse(first.deadlineAt!);
    assert.deepEqual([Date.parse(first.startedAt), deadline - Date.parse(first.startedAt), Date.parse(first.serverTime)], [base.getTime(), 60_000, base.getTime()]);
    pinned = new Date(deadline);
    assert.equal((await save(first, 1)).statusCode, 200, 'accepted at the deadline instant');
    const [answered] = await query<{ at: Date }>('SELECT max(answered_at) AS at FROM quiz_attempt_answers WHERE attempt_id = $1', [first.id]);
    assert.equal(answered!.at.getTime(), deadline, 'stored with the server instant');
    pinned = new Date(deadline + 1);
    problem(await save(first, 2), 409, 'ATTEMPT_EXPIRED');
    const [closed] = await query<{ status: string; closed: boolean; submitted: Date; score: number }>(
      'SELECT status, closed_by_time_limit AS closed, submitted_at AS submitted, score FROM quiz_attempts WHERE id = $1',
      [first.id],
    );
    assert.deepEqual([closed!.status, closed!.closed, closed!.submitted.getTime(), closed!.score], ['submitted', true, deadline, 1], 'graded with the answer saved in time only');

    // Attempt 2: submitting one millisecond before the deadline is a normal submission.
    pinned = new Date(base.getTime() + 120_000);
    const second = await ok<Attempt>('outsider', 'POST', `${B()}/activities/${quiz}/attempts`, undefined, 201);
    pinned = new Date(Date.parse(second.deadlineAt!) - 1);
    const submitted = await ok('outsider', 'POST', `${B()}/attempts/${second.id}/submit`, { answers: answers(second, 2) });
    assert.deepEqual([submitted.status, submitted.closedByTimeLimit, Date.parse(submitted.submittedAt)], ['submitted', false, Date.parse(second.deadlineAt!) - 1]);

    // Attempt 3: the former 10-second grace no longer extends the window, for saves or submits.
    pinned = new Date(base.getTime() + 240_000);
    const third = await ok<Attempt>('outsider', 'POST', `${B()}/activities/${quiz}/attempts`, undefined, 201);
    pinned = new Date(Date.parse(third.deadlineAt!) + 5_000);
    const late = await ok('outsider', 'POST', `${B()}/attempts/${third.id}/submit`, { answers: answers(third, 2) });
    assert.deepEqual([late.closedByTimeLimit, Date.parse(late.submittedAt), await stored(third.id)], [true, Date.parse(third.deadlineAt!), 0], 'late answers are discarded');
    // The browser clock is irrelevant: only the server clock decides.
    pinned = null;
  });

  it('21. question pools keep working: N drawn questions, gradebook maximum N × points', async () => {
    const quiz = await makeQuiz(B(), ids.sectionB, 'Pool', { questionsPerAttempt: 3 }, 5, 2, 'instructorB');
    const attempt = await ok<Attempt>('outsider', 'POST', `${B()}/activities/${quiz}/attempts`, undefined, 201);
    assert.equal(attempt.questions.length, 3);
    await ok('outsider', 'POST', `${B()}/attempts/${attempt.id}/submit`, { answers: answers(attempt, 3) });
    const data = await ok<Book>('instructorB', 'GET', `${B()}/gradebook`);
    assert.equal(data.columns.find((column) => column.activityId === quiz)!.maxPoints, 6);
    const cell = data.items[0]!.cells.find((c) => c.activityId === quiz)!;
    assert.deepEqual([cell.points, cell.maxPoints], [6, 6]);
  });

  it('22. completion progress stays separate from grades and weighting', async () => {
    for (const who of ['s1', 's2'] as const) {
      const now = await ok(who, 'GET', `${A()}/progress`);
      assert.doesNotMatch(JSON.stringify(now), /grade20|courseGrade|"points"/, 'progress carries no grades');
      // Submissions completed earlier stay completed regardless of score, weighting or release.
      const before = JSON.parse(progressBefore[who]!);
      assert.equal(now.completedCount, before.completedCount, `${who}: unchanged by grading policy and releases`);
    }
    const s2 = await ok('s2', 'GET', `${A()}/progress`);
    assert.ok(s2.completedCount >= 2, 'an earned zero still completes the quiz; a submission completes the assignment');
  });
});
