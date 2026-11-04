/**
 * Assignments, rubric grading, grade release and the gradebook against a temporary PostgreSQL
 * database. Skipped unless TEST_DATABASE_URL is set. Synthetic users; random passwords per run.
 * Tests run in order and build on each other.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { and, count, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { assignmentSubmissions, auditLog, grades, userCredentials, users } from '../../src/db/schema/index.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const COOKIE = 'ap_session';
const WEB_ORIGIN = 'http://localhost:3000';
const FEEDBACK = 'Buen análisis; mejora la redacción.';
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const EMAILS = {
  admin: DEV_USERS[0]!.email,
  instructor: DEV_USERS[1]!.email,
  student: DEV_USERS[2]!.email,
  reviewer: DEV_USERS[3]!.email,
  assistant: 'assistant@academiapath.example',
  otherStudent: 'student2@academiapath.example',
  outsider: 'student3@academiapath.example',
  instructorB: 'instructor2@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Session = { token: string; csrfToken: string; userId: string };
type Criterion = { id: string; title: string; maxPoints: number };

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

describe('assignments, grading and gradebook (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  const sessions = new Map<Person, Session>();
  const ids: Record<string, string> = {};
  const id = (key: string) => {
    const value = ids[key];
    assert.ok(value, `missing id ${key}`);
    return value;
  };
  let rubric: Criterion[] = [];

  const session = (person: Person) => {
    const value = sessions.get(person);
    assert.ok(value, `${person} is not signed in`);
    return value;
  };

  const call = (
    who: Person | null,
    method: 'GET' | 'POST' | 'PUT',
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

  const courseUrl = (courseId = id('courseA')) => `/courses/${courseId}`;
  const activityUrl = (activityId: string, courseId = id('courseA')) => `${courseUrl(courseId)}/activities/${activityId}`;
  const submissionsUrl = (activityId: string, courseId?: string) => `${activityUrl(activityId, courseId)}/submissions`;
  const gradeUrl = (submissionId: string, activityId = id('assignment')) => `${submissionsUrl(activityId)}/${submissionId}/grade`;
  const releaseUrl = (activityId: string) => `${activityUrl(activityId)}/grades/release`;

  const assignmentBody = (overrides: object = {}) => ({
    type: 'assignment',
    title: 'Ensayo ITIL',
    instructions: 'Explica el sistema de valor del servicio en 500 palabras.',
    dueAt: at(7 * DAY),
    rubric: [
      { title: 'Contenido', description: 'Ideas correctas y completas', maxPoints: 5 },
      { title: 'Redacción', maxPoints: 4 },
    ],
    ...overrides,
  });
  const create = async (payload: object) =>
    expectStatus(await call('instructor', 'POST', `${courseUrl()}/sections/${id('sectionA')}/activities`, { payload }), 201);
  const publish = async (activityId: string) => {
    expectStatus(await call('instructor', 'POST', `${activityUrl(activityId)}/submit`), 200);
    expectStatus(await call('reviewer', 'POST', `${activityUrl(activityId)}/review`, { payload: { decision: 'approve' } }), 200);
  };
  const scores = (points: [number, number]) => rubric.map((criterion, i) => ({ criterionId: criterion.id, points: points[i]! }));
  const auditCount = async (action: string, entityId: string) =>
    (await database.db.select({ n: count() }).from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId))))[0]?.n ?? 0;
  const myGrades = async (who: Person = 'student') => expectStatus(await call(who, 'GET', `${courseUrl()}/grades/mine`), 200);
  const gradebookRow = async (who: Person, email: string) => {
    const book = expectStatus(await call(who, 'GET', `${courseUrl()}/gradebook`), 200);
    const row = book.items.find((item: { student: { email: string } }) => item.student.email === email);
    assert.ok(row, `no gradebook row for ${email}`);
    return { book, row };
  };

  before(async () => {
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const passwordHash = await hashPassword(PASSWORD);
    for (const person of ['assistant', 'otherStudent', 'outsider', 'instructorB'] as const) {
      const [user] = await database.db.insert(users).values({ email: EMAILS[person], givenName: 'Test', familyName: person }).returning();
      assert.ok(user);
      await database.db.insert(userCredentials).values({ userId: user.id, passwordHash });
    }
    app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: WEB_ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000' }),
      database: database.db,
    });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) {
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
    }

    const program = expectStatus(await call('admin', 'POST', '/programs', { payload: { code: 'ING-SIS', name: 'Ingeniería' } }), 201);
    const term = expectStatus(await call('admin', 'POST', '/terms', { payload: { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' } }), 201);
    const template = expectStatus(
      await call('admin', 'POST', '/course-templates', { payload: { code: 'ITIL-F', programId: program.id, title: 'ITIL', sections: [{ title: 'Evaluación' }] } }),
      201,
    );
    const course = async (code: string) =>
      expectStatus(await call('admin', 'POST', '/courses', { payload: { programId: program.id, termId: term.id, templateId: template.templateId, code, status: 'published' } }), 201)
        .id as string;
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
    await enroll(id('courseB'), 'instructorB', 'instructor');
    ids.sectionA = expectStatus(await call('admin', 'GET', `${courseUrl()}/sections`), 200).items[0].id;
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  it('1–2. an instructor creates an assignment with a points rubric and due date', async () => {
    const assignment = await create(assignmentBody());
    assert.equal(assignment.type, 'assignment');
    assert.equal(assignment.review.status, 'draft');
    assert.equal(assignment.content.totalPoints, 9);
    assert.equal(assignment.content.lateUntil, null);
    assert.ok(Date.parse(assignment.content.dueAt) > Date.now());
    assert.deepEqual(
      assignment.content.rubric.map((c: Criterion & { description: string | null }) => [c.title, c.description, c.maxPoints]),
      [['Contenido', 'Ideas correctas y completas', 5], ['Redacción', null, 4]],
    );
    assert.ok(assignment.content.rubric.every((c: Criterion) => /^[0-9a-f-]{36}$/.test(c.id)), 'server-generated criterion ids');
    ids.assignment = assignment.id;
  });

  it('2. invalid rubrics and deadlines are rejected', async () => {
    const path = `${courseUrl()}/sections/${id('sectionA')}/activities`;
    const invalid = async (payload: object, status = 400, code = 'VALIDATION_ERROR') =>
      expectProblem(await call('instructor', 'POST', path, { payload }), status, code);
    await invalid(assignmentBody({ rubric: [] }));
    await invalid(assignmentBody({ rubric: [{ title: 'Cero', maxPoints: 0 }] }));
    await invalid(assignmentBody({ rubric: [{ title: 'Demasiado', maxPoints: 101 }] }));
    await invalid(assignmentBody({ rubric: [{ title: 'Medio', maxPoints: 2.5 }] }));
    await invalid(assignmentBody({ rubric: Array.from({ length: 21 }, (_, i) => ({ title: `C${i}`, maxPoints: 1 })) }));
    await invalid(assignmentBody({ rubric: [{ title: '   ', maxPoints: 3 }] }));
    await invalid(assignmentBody({ dueAt: 'next friday' }));
    await invalid(assignmentBody({ totalPoints: 9 }));
    await invalid(assignmentBody({ lateUntil: at(-DAY) }), 422, 'INVALID_DUE_DATE');
    await invalid(assignmentBody({ lateUntil: at(60 * DAY) }), 422, 'INVALID_DUE_DATE');
  });

  it('4. students cannot see or submit to a draft assignment', async () => {
    expectProblem(await call('student', 'GET', activityUrl(id('assignment'))), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', `${submissionsUrl(id('assignment'))}/mine`), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'POST', submissionsUrl(id('assignment')), { payload: { body: 'Borrador' } }), 404, 'NOT_FOUND');
    const list = expectStatus(await call('student', 'GET', `${courseUrl()}/sections/${id('sectionA')}/activities`), 200);
    assert.equal(list.items.length, 0);
  });

  it('5–6. the design team approves the assignment; the instructor cannot approve it', async () => {
    expectStatus(await call('instructor', 'POST', `${activityUrl(id('assignment'))}/submit`), 200);
    expectProblem(await call('instructor', 'POST', `${activityUrl(id('assignment'))}/review`, { payload: { decision: 'approve' } }), 403, 'FORBIDDEN');
    expectProblem(await call('assistant', 'POST', `${activityUrl(id('assignment'))}/review`, { payload: { decision: 'approve' } }), 403, 'FORBIDDEN');
    const approved = expectStatus(await call('reviewer', 'POST', `${activityUrl(id('assignment'))}/review`, { payload: { decision: 'approve' } }), 200);
    assert.equal(approved.review.status, 'approved');
    rubric = approved.liveVersion.content.rubric;
    assert.equal(rubric.length, 2);
    const studentView = expectStatus(await call('student', 'GET', activityUrl(id('assignment'))), 200);
    assert.deepEqual(studentView.content.rubric, rubric, 'students see the approved rubric');
  });

  it('7. a student submits text work and the server records the time', async () => {
    const status = expectStatus(await call('student', 'GET', `${submissionsUrl(id('assignment'))}/mine`), 200);
    assert.deepEqual([status.acceptingSubmissions, status.submission], [true, null]);
    expectProblem(
      await call('student', 'POST', submissionsUrl(id('assignment')), { payload: { body: 'Texto', submittedAt: at(-DAY) } }),
      400,
      'VALIDATION_ERROR',
    );
    expectProblem(await call('student', 'POST', submissionsUrl(id('assignment')), { payload: { body: '   ' } }), 400, 'VALIDATION_ERROR');
    const submission = expectStatus(
      await call('student', 'POST', submissionsUrl(id('assignment')), { payload: { body: 'El sistema de valor del servicio describe…' } }),
      201,
    );
    assert.deepEqual([submission.isLate, submission.gradeStatus, submission.grade], [false, 'pending', null]);
    assert.ok(Math.abs(Date.parse(submission.submittedAt) - Date.now()) < 10_000, 'server timestamp');
    ids.submission = submission.id;
  });

  it('11. each student has one final submission, also under concurrent requests', async () => {
    expectProblem(await call('student', 'POST', submissionsUrl(id('assignment')), { payload: { body: 'Otra versión' } }), 409, 'SUBMISSION_EXISTS');
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) => call('otherStudent', 'POST', submissionsUrl(id('assignment')), { payload: { body: `Intento ${i}` } })),
    );
    const created = responses.filter((res) => res.statusCode === 201);
    assert.equal(created.length, 1, responses.map((res) => res.statusCode).join(','));
    for (const res of responses.filter((r) => r.statusCode !== 201)) expectProblem(res, 409, 'SUBMISSION_EXISTS');
    ids.otherSubmission = created[0]!.json().id;
    const [{ n } = { n: 0 }] = await database.db
      .select({ n: count() })
      .from(assignmentSubmissions)
      .where(and(eq(assignmentSubmissions.activityId, id('assignment')), eq(assignmentSubmissions.userId, session('otherStudent').userId)));
    assert.equal(n, 1);
    const isRestrict = (error: unknown) => (error as { code?: string }).code === '23001';
    await assert.rejects(database.pool.query(`UPDATE assignment_submissions SET body = 'cambiado' WHERE id = $1`, [id('submission')]), isRestrict);
    await assert.rejects(database.pool.query(`DELETE FROM assignment_submissions WHERE id = $1`, [id('submission')]), isRestrict);
  });

  it('8–9. students cannot submit to another course or see other submissions', async () => {
    expectProblem(await call('outsider', 'POST', submissionsUrl(id('assignment')), { payload: { body: 'Intruso' } }), 404, 'NOT_FOUND');
    expectProblem(await call('outsider', 'POST', submissionsUrl(id('assignment'), id('courseB')), { payload: { body: 'Intruso' } }), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', submissionsUrl(id('assignment'))), 403, 'FORBIDDEN');
    expectProblem(await call('student', 'GET', `${submissionsUrl(id('assignment'))}/${id('otherSubmission')}`), 403, 'FORBIDDEN');
    const own = expectStatus(await call('otherStudent', 'GET', `${submissionsUrl(id('assignment'))}/mine`), 200);
    assert.equal(own.submission.id, id('otherSubmission'));
    assert.notEqual(own.submission.id, id('submission'));
  });

  it('10. the due date and late-submission window are enforced by the server', async () => {
    const closed = await create(assignmentBody({ title: 'Cerrada', dueAt: at(-DAY) }));
    await publish(closed.id);
    const status = expectStatus(await call('student', 'GET', `${submissionsUrl(closed.id)}/mine`), 200);
    assert.equal(status.acceptingSubmissions, false);
    expectProblem(await call('student', 'POST', submissionsUrl(closed.id), { payload: { body: 'Tarde' } }), 409, 'SUBMISSION_CLOSED');

    const late = await create(assignmentBody({ title: 'Con tolerancia', dueAt: at(-60 * 60 * 1000), lateUntil: at(DAY) }));
    await publish(late.id);
    const lateSubmission = expectStatus(await call('student', 'POST', submissionsUrl(late.id), { payload: { body: 'Entrega tardía' } }), 201);
    assert.equal(lateSubmission.isLate, true, 'accepted in the late window and flagged');

    const ended = await create(assignmentBody({ title: 'Tolerancia vencida', dueAt: at(-3 * DAY), lateUntil: at(-DAY) }));
    await publish(ended.id);
    expectProblem(await call('student', 'POST', submissionsUrl(ended.id), { payload: { body: 'Muy tarde' } }), 409, 'SUBMISSION_CLOSED');
  });

  it('3, 12, 17. an instructor grades against the rubric; invalid scores are rejected; the server computes the grade', async () => {
    const detail = expectStatus(await call('instructor', 'GET', `${submissionsUrl(id('assignment'))}/${id('submission')}`), 200);
    assert.deepEqual([detail.status, detail.grade, detail.scores], ['needs_grading', null, []]);
    assert.deepEqual(detail.rubric, rubric);

    const [content, style] = rubric as [Criterion, Criterion];
    const invalid = async (payload: object, status: number, code: string) =>
      expectProblem(await call('instructor', 'PUT', gradeUrl(id('submission')), { payload }), status, code);
    await invalid({ scores: scores([6, 3]) }, 422, 'INVALID_RUBRIC_SCORES');
    await invalid({ scores: [{ criterionId: content.id, points: 4 }] }, 422, 'INVALID_RUBRIC_SCORES');
    await invalid({ scores: [...scores([4, 3]), { criterionId: '00000000-0000-4000-8000-000000000000', points: 1 }] }, 422, 'INVALID_RUBRIC_SCORES');
    await invalid({ scores: scores([-1, 3]) }, 400, 'VALIDATION_ERROR');
    await invalid({ scores: scores([4, 3]), points: 9 }, 400, 'VALIDATION_ERROR');
    await invalid({ scores: scores([4, 3]), grade20: 20 }, 400, 'VALIDATION_ERROR');
    await invalid({ scores: scores([4, 3]), released: true }, 400, 'VALIDATION_ERROR');

    const graded = expectStatus(await call('instructor', 'PUT', gradeUrl(id('submission')), { payload: { scores: scores([4, 3]), feedback: FEEDBACK } }), 200);
    assert.equal(graded.status, 'unreleased');
    assert.deepEqual([graded.grade.points, graded.grade.maxPoints, graded.grade.grade20, graded.grade.releasedAt], [7, 9, 15.6, null]);
    assert.equal(graded.feedback, FEEDBACK);
    assert.deepEqual(
      graded.scores.map((s: { title: string; points: number; maxPoints: number }) => [s.title, s.points, s.maxPoints]),
      [['Contenido', 4, 5], ['Redacción', 3, 4]],
    );

    // The database enforces criterion maximums and rubric membership too.
    const isCheck = (error: unknown) => (error as { code?: string }).code === '23514';
    await assert.rejects(database.pool.query(`UPDATE assignment_criterion_scores SET points = 6 WHERE criterion_id = $1 AND submission_id = $2`, [content.id, id('submission')]), isCheck);
    await assert.rejects(database.pool.query(`UPDATE assignment_criterion_scores SET max_points = 100, points = 50 WHERE criterion_id = $1 AND submission_id = $2`, [style.id, id('submission')]), isCheck);
    await assert.rejects(
      database.pool.query(`INSERT INTO assignment_criterion_scores (submission_id, criterion_id, points, max_points) VALUES ($1, gen_random_uuid(), 1, 5)`, [id('submission')]),
      isCheck,
    );
  });

  it('13. a non-editing instructor grades but cannot edit assignment content', async () => {
    const graded = expectStatus(await call('assistant', 'PUT', gradeUrl(id('otherSubmission')), { payload: { scores: scores([5, 4]) } }), 200);
    assert.deepEqual([graded.grade.points, graded.grade.grade20, graded.feedback], [9, 20, null]);
    expectProblem(
      await call('assistant', 'PUT', activityUrl(id('assignment')), { payload: { ...assignmentBody(), type: undefined, title: 'Editado' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(await call('assistant', 'POST', `${courseUrl()}/sections/${id('sectionA')}/activities`, { payload: assignmentBody() }), 403, 'FORBIDDEN');
  });

  it('14–16. the design team, students and administrators cannot grade or release (administrators read only)', async () => {
    for (const who of ['reviewer', 'student', 'admin'] as const) {
      expectProblem(await call(who, 'PUT', gradeUrl(id('submission')), { payload: { scores: scores([5, 4]) } }), 403, 'FORBIDDEN');
      expectProblem(await call(who, 'POST', releaseUrl(id('assignment'))), 403, 'FORBIDDEN');
    }
    expectProblem(await call('reviewer', 'GET', `${courseUrl()}/gradebook`), 403, 'FORBIDDEN');
    expectProblem(await call('reviewer', 'GET', submissionsUrl(id('assignment'))), 403, 'FORBIDDEN');
    expectProblem(await call('student', 'GET', `${courseUrl()}/gradebook`), 403, 'FORBIDDEN');
    // Administrators cannot act as a student either, and do not have student grades.
    expectProblem(await call('admin', 'POST', submissionsUrl(id('assignment')), { payload: { body: 'Suplantación' } }), 403, 'FORBIDDEN');
    expectProblem(await call('admin', 'GET', `${submissionsUrl(id('assignment'))}/mine`), 403, 'FORBIDDEN');
    expectProblem(await call('admin', 'GET', `${courseUrl()}/grades/mine`), 403, 'FORBIDDEN');
    expectProblem(await call('instructor', 'GET', `${courseUrl()}/grades/mine`), 403, 'FORBIDDEN');
    // Read-only reports remain available to administrators.
    expectStatus(await call('admin', 'GET', `${courseUrl()}/gradebook`), 200);
    assert.equal(expectStatus(await call('admin', 'GET', submissionsUrl(id('assignment'))), 200).items.length, 2);
  });

  it('18. grades stay hidden from students before release', async () => {
    const mine = await call('student', 'GET', `${submissionsUrl(id('assignment'))}/mine`);
    const status = expectStatus(mine, 200);
    assert.deepEqual([status.submission.gradeStatus, status.submission.grade], ['pending', null]);
    assert.doesNotMatch(mine.body, /Buen análisis|"points"|grade20/);
    const gradesRes = await call('student', 'GET', `${courseUrl()}/grades/mine`);
    const book = expectStatus(gradesRes, 200);
    const item = book.items.find((i: { activityId: string }) => i.activityId === id('assignment'));
    assert.deepEqual([item.status, item.grade], ['pending', null]);
    assert.deepEqual(book.total, { points: 0, maxPoints: 0, grade20: null, gradedItems: 0 });
    assert.doesNotMatch(gradesRes.body, /Buen análisis/);
    const { row, book: staffBook } = await gradebookRow('instructor', EMAILS.student);
    const column = staffBook.columns.findIndex((c: { activityId: string }) => c.activityId === id('assignment'));
    assert.deepEqual([row.cells[column].status, row.cells[column].points], ['unreleased', 7]);
  });

  it('19–20. an instructor releases the assignment grades (once, even concurrently); students see grade and feedback', async () => {
    const releases = await Promise.all(Array.from({ length: 3 }, () => call('instructor', 'POST', releaseUrl(id('assignment')))));
    const counts = releases.map((res) => expectStatus(res, 200).releasedCount as number);
    assert.equal(counts.reduce((a, b) => a + b, 0), 2, `released ${counts.join(',')}`);
    assert.equal(await auditCount('grades.released', id('assignment')), 1, 'one release recorded');
    assert.deepEqual(expectStatus(await call('assistant', 'POST', releaseUrl(id('assignment'))), 200), {
      activityId: id('assignment'),
      releasedCount: 0,
      releasedAt: null,
    });

    const status = expectStatus(await call('student', 'GET', `${submissionsUrl(id('assignment'))}/mine`), 200);
    assert.equal(status.submission.gradeStatus, 'released');
    const { grade } = status.submission;
    assert.deepEqual([grade.points, grade.maxPoints, grade.grade20, grade.feedback], [7, 9, 15.6, FEEDBACK]);
    assert.deepEqual(
      grade.criteria.map((c: { title: string; points: number; maxPoints: number }) => [c.title, c.points, c.maxPoints]),
      [['Contenido', 4, 5], ['Redacción', 3, 4]],
    );
    const book = await myGrades();
    assert.deepEqual(book.total, { points: 7, maxPoints: 9, grade20: 15.6, gradedItems: 1 });
    const other = await myGrades('otherStudent');
    assert.deepEqual(other.total, { points: 9, maxPoints: 9, grade20: 20, gradedItems: 1 }, 'each student sees only their own grade');
  });

  it('regrades stay hidden until released again; concurrent grading is serialized', async () => {
    const beforeCount = await auditCount('assignment.graded', id('submission'));
    const variants: Array<[number, number]> = [[1, 1], [2, 2], [3, 3], [5, 4]];
    const results = await Promise.all(
      variants.map((points) => call('instructor', 'PUT', gradeUrl(id('submission')), { payload: { scores: scores(points), feedback: FEEDBACK } })),
    );
    for (const res of results) assert.equal(res.statusCode, 200, res.body);
    const [grade] = await database.db.select().from(grades).where(eq(grades.submissionId, id('submission')));
    const { rows } = await database.pool.query<{ total: number }>(
      `SELECT sum(points)::int AS total FROM assignment_criterion_scores WHERE submission_id = $1`,
      [id('submission')],
    );
    assert.equal(grade?.points, rows[0]?.total, 'grade total matches the stored rubric scores');
    assert.equal(await auditCount('assignment.graded', id('submission')), beforeCount + variants.length, 'every change audited');

    const { row, book } = await gradebookRow('instructor', EMAILS.student);
    const column = book.columns.findIndex((c: { activityId: string }) => c.activityId === id('assignment'));
    assert.equal(row.cells[column].status, 'changed_since_release');
    const hidden = expectStatus(await call('student', 'GET', `${submissionsUrl(id('assignment'))}/mine`), 200);
    assert.equal(hidden.submission.grade.points, 7, 'students keep seeing the released grade');

    const final = expectStatus(await call('instructor', 'PUT', gradeUrl(id('submission')), { payload: { scores: scores([4, 3]), feedback: 'Versión final.' } }), 200);
    const unchanged = await auditCount('assignment.graded', id('submission'));
    expectStatus(await call('instructor', 'PUT', gradeUrl(id('submission')), { payload: { scores: scores([4, 3]), feedback: 'Versión final.' } }), 200);
    assert.equal(await auditCount('assignment.graded', id('submission')), unchanged, 'an identical regrade changes nothing');
    assert.equal(expectStatus(await call('instructor', 'POST', releaseUrl(id('assignment'))), 200).releasedCount, 1);
    const released = expectStatus(await call('student', 'GET', `${submissionsUrl(id('assignment'))}/mine`), 200);
    assert.deepEqual([released.submission.grade.points, released.submission.grade.feedback], [final.grade.points, 'Versión final.']);
  });

  it('21–23. quiz scores are released from server results, counted once per student, without answer keys', async () => {
    const quiz = await create({ type: 'quiz', title: 'Quiz ITIL', attemptLimit: 3 });
    const questions: Array<{ id: string }> = [];
    for (const prompt of ['¿ITIL es un marco?', '¿ITIL 4 incluye el SVS?']) {
      questions.push(expectStatus(await call('instructor', 'POST', `${activityUrl(quiz.id)}/questions`, { payload: { type: 'true_false', prompt, points: 1, correctAnswer: true } }), 201));
    }
    await publish(quiz.id);
    ids.quiz = quiz.id;
    const takeAttempt = async (choices: [string, string]) => {
      const attempt = expectStatus(await call('student', 'POST', `${activityUrl(quiz.id)}/attempts`), 201);
      const answers = questions.map((q, i) => ({ questionId: q.id, selectedOptionIds: [choices[i]!] }));
      expectStatus(await call('student', 'POST', `${courseUrl()}/attempts/${attempt.id}/submit`, { payload: { answers } }), 200);
      return attempt.id as string;
    };
    await takeAttempt(['false', 'false']);
    const best = await takeAttempt(['true', 'true']);
    const lastAttempt = await takeAttempt(['true', 'false']);

    const rowsForStudent = await database.db
      .select()
      .from(grades)
      .where(and(eq(grades.activityId, quiz.id), eq(grades.userId, session('student').userId)));
    assert.equal(rowsForStudent.length, 1, 'one gradebook entry for three attempts');
    assert.deepEqual([rowsForStudent[0]?.points, rowsForStudent[0]?.quizAttemptId], [2, best], 'the best attempt counts, not the latest');
    const isUnique = (error: unknown) => (error as { code?: string }).code === '23505';
    await assert.rejects(
      database.pool.query(
        `INSERT INTO grades (course_id, activity_id, user_id, enrollment_id, source, quiz_attempt_id, points, max_points, graded_at)
         SELECT course_id, activity_id, user_id, enrollment_id, 'quiz', id, score, max_score, now() FROM quiz_attempts WHERE id = $1`,
        [lastAttempt],
      ),
      isUnique,
    );

    const pending = (await myGrades()).items.find((i: { activityId: string }) => i.activityId === quiz.id);
    assert.deepEqual([pending.status, pending.grade], ['pending', null]);
    assert.equal(expectStatus(await call('student', 'GET', `${activityUrl(quiz.id)}/attempts/mine`), 200).gradeReleased, false);

    assert.equal(expectStatus(await call('instructor', 'POST', releaseUrl(quiz.id)), 200).releasedCount, 1);
    const gradesRes = await call('student', 'GET', `${courseUrl()}/grades/mine`);
    const item = expectStatus(gradesRes, 200).items.find((i: { activityId: string }) => i.activityId === quiz.id);
    assert.deepEqual([item.type, item.status, item.grade.points, item.grade.maxPoints, item.grade.grade20, item.grade.feedback], ['quiz', 'released', 2, 2, 20, null]);
    assert.deepEqual(item.grade.criteria, []);
    assert.doesNotMatch(gradesRes.body, /correctAnswer|isCorrect|optionIds|awardedPoints/);
    const attempt = await call('student', 'GET', `${courseUrl()}/attempts/${best}`);
    assert.equal(expectStatus(attempt, 200).resultsReleased, true);
    assert.doesNotMatch(attempt.body, /isCorrect|correctAnswer|awardedPoints|"score"|maxScore/, 'release shows no per-attempt scores or keys');
    assert.equal(expectStatus(await call('student', 'GET', `${activityUrl(quiz.id)}/attempts/mine`), 200).gradeReleased, true);
  });

  it('24. grades use the 0–20 scale with half-up rounding; the course total sums points', async () => {
    const { book, row } = await gradebookRow('instructor', EMAILS.student);
    assert.equal(book.scaleMax, 20);
    const cell = (activityId: string) => row.cells[book.columns.findIndex((c: { activityId: string }) => c.activityId === activityId)];
    assert.deepEqual([cell(id('assignment')).points, cell(id('assignment')).maxPoints, cell(id('assignment')).grade20], [7, 9, 15.6]);
    assert.deepEqual([cell(id('quiz')).points, cell(id('quiz')).grade20, cell(id('quiz')).status], [2, 20, 'released']);
    // Graded items: assignment 7/9, quiz 2/2 and the late assignment (ungraded, not counted): (7 + 2) / (9 + 2) × 20 = 16.36… → 16.4
    assert.deepEqual(row.total, { points: 9, maxPoints: 11, grade20: 16.4, gradedItems: 2 });
    assert.equal(row.cells.length, book.columns.length);
    const studentBook = await myGrades();
    assert.equal(studentBook.scaleMax, 20);
    assert.deepEqual(studentBook.total, { points: 9, maxPoints: 11, grade20: 16.4, gradedItems: 2 }, 'API values match for staff and student');
    const late = studentBook.items.find((i: { title: string }) => i.title === 'Con tolerancia');
    assert.deepEqual([late.status, late.grade], ['pending', null]);
  });

  it('25. gradebooks and grades are isolated per course', async () => {
    expectProblem(await call('outsider', 'GET', `${courseUrl()}/gradebook`), 404, 'NOT_FOUND');
    expectProblem(await call('outsider', 'GET', `${courseUrl()}/grades/mine`), 404, 'NOT_FOUND');
    expectProblem(await call('instructorB', 'GET', `${courseUrl()}/gradebook`), 404, 'NOT_FOUND');
    expectProblem(await call('instructorB', 'POST', releaseUrl(id('assignment'))), 404, 'NOT_FOUND');
    expectProblem(await call('instructor', 'GET', `${courseUrl(id('courseB'))}/gradebook`), 404, 'NOT_FOUND');
    expectProblem(await call('instructorB', 'PUT', `${courseUrl(id('courseB'))}/activities/${id('assignment')}/submissions/${id('submission')}/grade`, { payload: { scores: scores([1, 1]) } }), 404, 'NOT_FOUND');
    const outsiderBook = expectStatus(await call('outsider', 'GET', `${courseUrl(id('courseB'))}/grades/mine`), 200);
    assert.deepEqual(outsiderBook.items, []);
    const bookB = expectStatus(await call('instructorB', 'GET', `${courseUrl(id('courseB'))}/gradebook`), 200);
    assert.deepEqual([bookB.columns, bookB.items.map((r: { student: { email: string } }) => r.student.email)], [[], [EMAILS.outsider]]);
  });

  it('revising an approved assignment keeps submitted work tied to its original rubric', async () => {
    const revised = expectStatus(
      await call('instructor', 'PUT', activityUrl(id('assignment')), {
        payload: { title: 'Ensayo ITIL (v2)', instructions: 'Nueva consigna', dueAt: at(7 * DAY), rubric: [{ title: 'Único criterio', maxPoints: 10 }] },
      }),
      200,
    );
    assert.equal(revised.review.status, 'draft');
    assert.equal(expectStatus(await call('student', 'GET', activityUrl(id('assignment'))), 200).content.totalPoints, 9, 'students keep the approved version');
    const detail = expectStatus(await call('instructor', 'GET', `${submissionsUrl(id('assignment'))}/${id('submission')}`), 200);
    assert.deepEqual(detail.rubric, rubric, 'the submission keeps the rubric it was submitted against');
    expectStatus(await call('instructor', 'PUT', gradeUrl(id('submission')), { payload: { scores: scores([4, 3]), feedback: 'Versión final.' } }), 200);
  });

  it('26. submissions, grading changes and releases are audited without secrets', async () => {
    const actions = new Set((await database.db.select({ action: auditLog.action }).from(auditLog)).map((row) => row.action));
    for (const action of ['assignment.submitted', 'assignment.graded', 'grades.released', 'grade.recorded']) assert.ok(actions.has(action), action);
    const graded = await database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'assignment.graded'), eq(auditLog.entityId, id('submission'))))
      .orderBy(auditLog.createdAt);
    assert.equal(graded[0]?.metadata.before, null, 'first grading has no previous grade');
    assert.ok(graded.slice(1).every((entry) => entry.metadata.before !== null), 'regrades record the previous grade');
    assert.ok(graded.every((entry) => entry.actorUserId === session('instructor').userId));
    const [release] = await database.db.select().from(auditLog).where(and(eq(auditLog.action, 'grades.released'), eq(auditLog.entityId, id('quiz'))));
    assert.equal((release?.metadata.after as { releasedCount: number }).releasedCount, 1);
    const secrets = [PASSWORD, ...[...sessions.values()].flatMap((s) => [s.token, s.csrfToken])];
    for (const entry of await database.db.select().from(auditLog)) {
      const metadata = JSON.stringify(entry.metadata);
      assert.ok(secrets.every((secret) => !metadata.includes(secret)), `${entry.action} contains a secret`);
      assert.doesNotMatch(metadata, /correctAnswer|isCorrect/, `${entry.action} contains an answer key`);
    }
  });

  it('27. CSRF and Origin protections apply to submissions, grading and release', async () => {
    const open = await create(assignmentBody({ title: 'CSRF' }));
    await publish(open.id);
    expectProblem(await call('student', 'POST', submissionsUrl(open.id), { payload: { body: 'x' }, csrf: null }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await call('student', 'POST', submissionsUrl(open.id), { payload: { body: 'x' }, headers: { origin: 'https://evil.example' } }), 403, 'ORIGIN_NOT_ALLOWED');
    expectProblem(await call('instructor', 'PUT', gradeUrl(id('submission')), { payload: { scores: scores([0, 0]) }, csrf: 'forged' }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await call('instructor', 'POST', releaseUrl(id('assignment')), { headers: { origin: 'https://evil.example' } }), 403, 'ORIGIN_NOT_ALLOWED');
    expectProblem(await call(null, 'POST', releaseUrl(id('assignment'))), 401, 'UNAUTHENTICATED');
    expectProblem(await call(null, 'GET', `${courseUrl()}/gradebook`), 401, 'UNAUTHENTICATED');
    const status = expectStatus(await call('student', 'GET', `${submissionsUrl(open.id)}/mine`), 200);
    assert.equal(status.submission, null, 'forged requests changed nothing');
    const [grade] = await database.db.select().from(grades).where(eq(grades.submissionId, id('submission')));
    assert.equal(grade?.points, 7, 'forged grading changed nothing');
  });
});
