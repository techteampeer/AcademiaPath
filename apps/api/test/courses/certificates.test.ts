/**
 * Course completion certificates (AP-024) and the non-editing instructor role review, against a temporary
 * PostgreSQL database (skipped unless TEST_DATABASE_URL is set). Synthetic users. Tests run in order.
 *
 * Course A (published): lesson L (reading), quiz Q (2 × 5 points) and assignment E (rubric 10). Students:
 * s1 completes everything (Q 10/10, E 7/10, released: 85 %); s2 skips the lesson; s3 completes and is then
 * deactivated; s4 completes but E stays unreleased; s5 completes (concurrency); s6 completes below the
 * minimum. Course B (published) belongs to another instructor; course C is a draft.
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
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const DAY = 24 * 60 * 60 * 1000;

const EMAILS = {
  admin: DEV_USERS[0]!.email,
  instructor: DEV_USERS[1]!.email,
  s1: DEV_USERS[2]!.email,
  reviewer: DEV_USERS[3]!.email,
  assistant: 'assistant@academiapath.example',
  s2: 'student2@academiapath.example',
  s3: 'student3@academiapath.example',
  s4: 'student4@academiapath.example',
  s5: 'student5@academiapath.example',
  s6: 'student6@academiapath.example',
  pm: 'program.manager@academiapath.example',
  instructorB: 'instructor2@academiapath.example',
  outsider: 'outsider@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Session = { token: string; csrf: string; userId: string };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Requirement = { key: string; met: boolean; reason: string | null };
type Eligibility = { eligible: boolean; requirements: Requirement[]; progress: { completedCount: number; totalCount: number }; releasedGrade: { status: string; percent: number | null } };
type Certificate = { id: string; certificateNumber: string; status: string; recipientName: string; courseTitle: string; issuerName: string; policyVersion: number; verificationPath: string; revokedAt: string | null; revocationReason: string | null; history?: Array<{ action: string; actor: { id: string } | null; reason: string | null }> };

describe('course completion certificates (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  const as = {} as Record<Person, Session>;
  const ids = {} as Record<string, string> & { courseA: string; courseB: string; courseC: string; lesson: string; quiz: string; essay: string; enroll_s3: string };
  const certs = {} as Record<string, Certificate>;
  let baseline: { gradebook: string; progress: string };

  const request = (who: Person | null, method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const session = who ? as[who] : null;
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
  const A = () => `/courses/${ids.courseA}`;
  const B = () => `/courses/${ids.courseB}`;
  const C = () => `/courses/${ids.courseC}`;
  const policy = async (who: Person, course: string, rules: Record<string, unknown>) => {
    const current = await ok<{ version: number }>('admin', 'GET', `${course}/certificate-policy`);
    return request(who, 'PUT', `${course}/certificate-policy`, {
      expectedVersion: current.version,
      enabled: true,
      requireCompletion: true,
      requireFinalGrade: true,
      minimumGradePercent: 60,
      issuerName: 'Universidad Sintética',
      ...rules,
    });
  };
  const issue = (who: Person, course: string, student: Person) => request(who, 'POST', `${course}/certificates`, { userId: as[student].userId });
  const mine = (who: Person, course = A()) => ok<{ eligibility: Eligibility | null; policy: { configured: boolean }; certificates: Certificate[] }>(who, 'GET', `${course}/certificates/mine`);
  const unmet = (eligibility: Eligibility) => eligibility.requirements.filter((r) => !r.met).map((r) => `${r.key}:${r.reason}`);

  const approve = async (course: string, activityId: string, instructor: Person = 'instructor') => {
    await ok(instructor, 'POST', `${course}/activities/${activityId}/submit`);
    await ok('reviewer', 'POST', `${course}/activities/${activityId}/review`, { decision: 'approve' });
  };
  type Attempt = { id: string; questions: Array<{ questionId: string; options: Array<{ id: string; text: string }> }> };
  const takeQuiz = async (who: Person, correct: number) => {
    const attempt = await ok<Attempt>(who, 'POST', `${A()}/activities/${ids.quiz}/attempts`, undefined, 201);
    const answers = attempt.questions.map((q, index) => ({ questionId: q.questionId, selectedOptionIds: [q.options.find((o) => o.text.startsWith(index < correct ? 'Right' : 'Wrong'))!.id] }));
    await ok(who, 'POST', `${A()}/attempts/${attempt.id}/submit`, { answers });
  };
  const gradeEssay = async (who: Person, points: number, grader: Person = 'instructor') => {
    const page = await ok<{ items: Array<{ id: string; student: { id: string } }> }>('instructor', 'GET', `${A()}/activities/${ids.essay}/submissions`);
    const submission = page.items.find((item) => item.student.id === as[who].userId)!;
    const detail = await ok<{ rubric: Array<{ id: string }> }>('instructor', 'GET', `${A()}/activities/${ids.essay}/submissions/${submission.id}`);
    return request(grader, 'PUT', `${A()}/activities/${ids.essay}/submissions/${submission.id}/grade`, { scores: [{ criterionId: detail.rubric[0]!.id, points }], feedback: 'Synthetic feedback.' });
  };
  /** Completes the lesson (optional), the quiz and the assignment; the instructor grades the assignment. */
  const work = async (who: Person, options: { lesson?: boolean; quiz: number; essay: number }) => {
    if (options.lesson !== false) await ok(who, 'PUT', `${A()}/activities/${ids.lesson}/completion`);
    await takeQuiz(who, options.quiz);
    await ok(who, 'POST', `${A()}/activities/${ids.essay}/submissions`, { body: `Work of ${who}.` }, 201);
    assert.equal((await gradeEssay(who, options.essay)).statusCode, 200);
  };
  /** Releases a student's current quiz and assignment grades (AP-023 selective release). */
  const release = async (who: Person, activities: string[] = ['quiz', 'essay']) => {
    const book = await ok<{ items: Array<{ student: { id: string }; cells: Array<{ activityId: string; revision: number | null }> }> }>('instructor', 'GET', `${A()}/gradebook?limit=100`);
    const row = book.items.find((item) => item.student.id === as[who].userId)!;
    const items = activities.map((key) => ({ activityId: ids[key]!, userId: as[who].userId, revision: row.cells.find((c) => c.activityId === ids[key])!.revision! }));
    await ok('instructor', 'POST', `${A()}/grades/release`, { items });
  };

  before(async () => {
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const passwordHash = await hashPassword(PASSWORD);
    const extra: Person[] = ['assistant', 's2', 's3', 's4', 's5', 's6', 'pm', 'instructorB', 'outsider'];
    for (const person of extra) {
      const [user] = await database.db.insert(users).values({ email: EMAILS[person], givenName: `Ana ${person}`, familyName: 'Ñúñez' }).returning();
      await database.db.insert(userCredentials).values({ userId: user!.id, passwordHash });
    }
    app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000' }), database: database.db });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAILS[person], password: PASSWORD }, headers: { origin: ORIGIN } });
      assert.equal(res.statusCode, 200, res.body);
      as[person] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
    }
    const program = await ok('admin', 'POST', '/programs', { code: 'CERT', name: 'Programa de Certificados' }, 201);
    const term = await ok('admin', 'POST', '/terms', { code: '2026-2', name: 'Semestre 2026-2', startsOn: '2026-08-17', endsOn: '2026-12-11' }, 201);
    const template = await ok('admin', 'POST', '/course-templates', { code: 'CERT-T', programId: program.id, title: 'Certificados', sections: [{ title: 'Unidad 1' }] }, 201);
    const course = async (code: string, status: string) =>
      (await ok('admin', 'POST', '/courses', { programId: program.id, termId: term.id, templateId: template.templateId, code, status }, 201)).id as string;
    ids.program = program.id;
    ids.courseA = await course('CERT-A', 'published');
    ids.courseB = await course('CERT-B', 'published');
    ids.courseC = await course('CERT-C', 'draft');
    const enroll = async (courseId: string, person: Person, role: string) => (await ok('admin', 'POST', `/courses/${courseId}/enrollments`, { email: EMAILS[person], role }, 201)).id as string;
    for (const [person, role] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['assistant', 'non_editing_instructor'], ['s1', 'student'], ['s2', 'student'], ['s3', 'student'], ['s4', 'student'], ['s5', 'student'], ['s6', 'student']] as const) {
      ids[`enroll_${person}`] = await enroll(ids.courseA, person, role);
    }
    for (const [person, role] of [['instructorB', 'instructor'], ['reviewer', 'design_team'], ['outsider', 'student']] as const) await enroll(ids.courseB, person, role);
    for (const [person, role] of [['instructor', 'instructor'], ['s1', 'student']] as const) await enroll(ids.courseC, person, role);
    await ok('admin', 'POST', `/programs/${program.id}/managers`, { email: EMAILS.pm }, 201);
    const sectionA = (await ok('admin', 'GET', `${A()}/sections`)).items[0].id;

    ids.lesson = (await ok('instructor', 'POST', `${A()}/sections/${sectionA}/activities`, { type: 'page', title: 'Lectura 1', body: 'Contenido sintético.' }, 201)).id;
    await approve(A(), ids.lesson);
    ids.quiz = (await ok('instructor', 'POST', `${A()}/sections/${sectionA}/activities`, { type: 'quiz', title: 'Cuestionario', attemptLimit: 1 }, 201)).id;
    for (let i = 1; i <= 2; i++) {
      await ok('instructor', 'POST', `${A()}/activities/${ids.quiz}/questions`, { type: 'single_choice', prompt: `Pregunta ${i}`, points: 5, options: [{ text: `Right ${i}`, isCorrect: true }, { text: `Wrong ${i}`, isCorrect: false }] }, 201);
    }
    await approve(A(), ids.quiz);
    ids.essay = (await ok('instructor', 'POST', `${A()}/sections/${sectionA}/activities`, {
      type: 'assignment',
      title: 'Ensayo',
      instructions: 'Escribe un análisis.',
      dueAt: new Date(Date.now() + 7 * DAY).toISOString(),
      rubric: [{ title: 'Contenido', maxPoints: 10 }],
    }, 201)).id;
    await approve(A(), ids.essay);

    await work('s1', { quiz: 2, essay: 7 }); // 10/10 + 7/10 = 85 %
    await release('s1');
    await work('s2', { lesson: false, quiz: 2, essay: 8 });
    await release('s2');
    await work('s3', { quiz: 2, essay: 9 });
    await release('s3');
    await work('s4', { quiz: 2, essay: 3 });
    await release('s4', ['quiz']); // the assignment grade (3/10) stays unreleased
    await work('s5', { quiz: 2, essay: 10 });
    await release('s5');
    await work('s6', { quiz: 1, essay: 5 }); // 5/10 + 5/10 = 50 %
    await release('s6');
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  it('16 (role review). non-editing instructors grade by the documented policy, but never release or change content', async () => {
    // Documented in the API contract (gradeAssignmentSubmission) and the demo walkthrough: graders may grade.
    const graded = await gradeEssay('s6', 6, 'assistant');
    assert.equal(graded.statusCode, 200, graded.body);
    assert.deepEqual([graded.json().status, graded.json().grade.points], ['changed_since_release', 6], 'graded; hidden until an instructor releases it');
    problem(await request('assistant', 'POST', `${A()}/activities/${ids.essay}/grades/release`), 403, 'FORBIDDEN');
    problem(await request('assistant', 'POST', `${A()}/grades/release`, { items: [{ activityId: ids.essay, userId: as.s6.userId, revision: 1 }] }), 403, 'FORBIDDEN');
    problem(await request('assistant', 'PUT', `${A()}/grading-policy`, { expectedVersion: 0, status: 'draft', categories: [] }), 403, 'FORBIDDEN');
    problem(await request('assistant', 'PUT', `${A()}/activities/${ids.lesson}`, { title: 'Editado', body: 'Cambio no autorizado.' }), 403, 'FORBIDDEN');
    problem(await request('assistant', 'POST', `${A()}/activities/${ids.lesson}/submit`), 403, 'FORBIDDEN');
    // The administrator role never grades (unchanged); instructors keep every grading permission.
    const page = await ok<{ items: Array<{ id: string; student: { id: string } }> }>('instructor', 'GET', `${A()}/activities/${ids.essay}/submissions`);
    const submission = page.items.find((item) => item.student.id === as.s6.userId)!;
    problem(await request('admin', 'PUT', `${A()}/activities/${ids.essay}/submissions/${submission.id}/grade`, { scores: [] }), 400, 'VALIDATION_ERROR');
    const detail = await ok<{ rubric: Array<{ id: string }> }>('instructor', 'GET', `${A()}/activities/${ids.essay}/submissions/${submission.id}`);
    problem(await request('admin', 'PUT', `${A()}/activities/${ids.essay}/submissions/${submission.id}/grade`, { scores: [{ criterionId: detail.rubric[0]!.id, points: 5 }] }), 403, 'FORBIDDEN');
    assert.equal((await gradeEssay('s6', 5)).statusCode, 200);
    await release('s6', ['essay']);
    baseline = {
      // Columns and student rows (grades, course grades, counts); test 8 changes only the policy header.
      gradebook: JSON.stringify((({ columns, items }) => ({ columns, items }))(await ok('instructor', 'GET', `${A()}/gradebook?limit=100`))),
      progress: JSON.stringify(await ok('instructor', 'GET', `${A()}/progress/students?limit=100`)),
    };
  });

  it('9. without a configured policy nothing is issued, automatically or on request', async () => {
    const own = await mine('s1');
    assert.deepEqual([own.policy.configured, own.eligibility, own.certificates.length], [false, null, 0]);
    problem(await issue('instructor', A(), 's1'), 422, 'CERTIFICATE_NOT_ELIGIBLE');
    assert.equal(await count('SELECT count(*)::int AS n FROM course_certificates'), 0);
    const list = await ok<{ policy: { configured: boolean }; items: Array<{ eligibility: Eligibility }> }>('instructor', 'GET', `${A()}/certificates/eligibility`);
    assert.ok(!list.policy.configured && list.items.every((item) => !item.eligibility.eligible && unmet(item.eligibility).includes('policy_enabled:not_configured')));
  });

  it('policy validation, versions and role boundaries', async () => {
    problem(await policy('instructor', A(), { requireCompletion: false, requireFinalGrade: false, minimumGradePercent: null }), 422, 'CERTIFICATE_POLICY_INVALID');
    problem(await policy('instructor', A(), { requireFinalGrade: false, minimumGradePercent: 60 }), 422, 'CERTIFICATE_POLICY_INVALID');
    for (const bad of [{ minimumGradePercent: 0 }, { minimumGradePercent: 101 }, { minimumGradePercent: 59.5 }, { issuerName: ' ' }]) {
      problem(await policy('instructor', A(), bad), 400, 'VALIDATION_ERROR');
    }
    problem(await policy('assistant', A(), {}), 403, 'FORBIDDEN');
    problem(await policy('reviewer', A(), {}), 403, 'FORBIDDEN');
    problem(await policy('s1', A(), {}), 403, 'FORBIDDEN');
    problem(await policy('pm', A(), {}), 404, 'NOT_FOUND');
    problem(await policy('instructorB', A(), {}), 404, 'NOT_FOUND');
    const saved = await policy('instructor', A(), {});
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual([saved.json().configured, saved.json().version, saved.json().minimumGradePercent], [true, 1, 60]);
    problem(await request('instructor', 'PUT', `${A()}/certificate-policy`, { expectedVersion: 0, enabled: true, requireCompletion: true, requireFinalGrade: true, minimumGradePercent: 60, issuerName: 'X' }), 409, 'CERTIFICATE_POLICY_CONFLICT');
    assert.equal((await policy('admin', A(), {})).json().version, 2, 'administrators may configure');
  });

  it('1, 10. an eligible student receives one certificate; repeated requests return it unchanged', async () => {
    const own = await mine('s1');
    assert.equal(own.eligibility!.eligible, true, JSON.stringify(own.eligibility));
    assert.deepEqual([own.eligibility!.progress.completedCount, own.eligibility!.progress.totalCount, own.eligibility!.releasedGrade.percent], [3, 3, 85]);
    const first = await issue('instructor', A(), 's1');
    assert.equal(first.statusCode, 201, first.body);
    const certificate = first.json() as Certificate;
    certs.s1 = certificate;
    assert.equal(certificate.status, 'issued');
    assert.match(certificate.certificateNumber, /^AP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.match(certificate.verificationPath, /^\/verify\/[A-Za-z0-9_-]{43}$/);
    const [name] = await query<{ full: string }>("SELECT given_name || ' ' || family_name AS full FROM users WHERE id = $1", [as.s1.userId]);
    assert.deepEqual([certificate.recipientName, certificate.courseTitle, certificate.issuerName, certificate.policyVersion], [name!.full, 'Certificados', 'Universidad Sintética', 2]);
    const again = await issue('instructor', A(), 's1');
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().id, certificate.id);
    assert.equal(await count("SELECT count(*)::int AS n FROM course_certificates WHERE user_id = $1 AND status = 'issued'", [as.s1.userId]), 1);
    const row = (await query<{ token: string; id: string }>('SELECT verification_token AS token, id FROM course_certificates WHERE id = $1', [certificate.id]))[0]!;
    assert.notEqual(row.token, row.id);
    assert.ok(!certificate.verificationPath.includes(certificate.id), 'the public token is not the internal id');
  });

  it('11. concurrent issuance creates exactly one certificate', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => issue('instructor', A(), 's5')));
    const statuses = results.map((res) => res.statusCode).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 201]);
    assert.equal(new Set(results.map((res) => res.json().id)).size, 1);
    assert.equal(await count("SELECT count(*)::int AS n FROM course_certificates WHERE user_id = $1", [as.s5.userId]), 1);
    assert.equal(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'certificate.issued' AND metadata->'after'->>'userId' = $1", [as.s5.userId]), 1);
  });

  it('2, 5. incomplete required activities block issuance', async () => {
    const own = await mine('s2');
    assert.equal(own.eligibility!.eligible, false);
    assert.deepEqual(unmet(own.eligibility!), ['activities_completed:incomplete']);
    const res = await issue('instructor', A(), 's2');
    problem(res, 422, 'CERTIFICATE_NOT_ELIGIBLE');
    assert.match(res.json().detail, /activities_completed/);
  });

  it('6, 7, 24. unreleased assessments block issuance; provisional grades never pass; nothing unreleased is revealed', async () => {
    const res = await request('s4', 'GET', `${A()}/certificates/mine`);
    const own = res.json() as { eligibility: Eligibility };
    // Released so far: the quiz only (10/10 = 100 %, provisional). The unreleased 3/10 never counts or shows.
    assert.deepEqual([own.eligibility.releasedGrade.status, own.eligibility.releasedGrade.percent], ['provisional', 100]);
    assert.deepEqual(unmet(own.eligibility), ['final_grade_released:grades_pending', 'minimum_grade:awaiting_final_grade']);
    assert.doesNotMatch(res.body, /"points"|Synthetic feedback|"65|"30/);
    problem(await issue('instructor', A(), 's4'), 422, 'CERTIFICATE_NOT_ELIGIBLE');
    const staff = await ok<{ items: Array<{ student: { id: string }; eligibility: Eligibility }> }>('instructor', 'GET', `${A()}/certificates/eligibility`);
    const row = staff.items.find((item) => item.student.id === as.s4.userId)!;
    assert.deepEqual([row.eligibility.eligible, row.eligibility.releasedGrade.percent], [false, 100], 'staff see the same released-only evaluation');
  });

  it('8. the minimum grade uses the server calculation (AP-023 weighting), compared exactly', async () => {
    assert.deepEqual(unmet((await mine('s6')).eligibility!), ['minimum_grade:below_minimum']);
    problem(await issue('instructor', A(), 's6'), 422, 'CERTIFICATE_NOT_ELIGIBLE');
    // s1: 85 % unweighted. With a published weighting (quiz 30 %, assignment 70 %): 30 × 1 + 70 × 0.7 = 79 %.
    await ok('instructor', 'PUT', `${A()}/grading-policy`, { expectedVersion: 0, status: 'published', categories: [{ name: 'Quizzes', weightPercent: 30, activityIds: [ids.quiz] }, { name: 'Assignments', weightPercent: 70, activityIds: [ids.essay] }] });
    assert.equal((await mine('s1')).eligibility!.releasedGrade.percent, 79);
    assert.equal((await policy('instructor', A(), { minimumGradePercent: 80 })).statusCode, 200);
    assert.deepEqual(unmet((await mine('s1')).eligibility!), ['minimum_grade:below_minimum'], '79 % does not reach 80 %');
    assert.equal((await policy('instructor', A(), { minimumGradePercent: 79 })).statusCode, 200);
    assert.equal((await mine('s1')).eligibility!.eligible, true, '79 % reaches 79 % exactly');
    // Restore the unweighted calculation and the original minimum.
    await ok('instructor', 'PUT', `${A()}/grading-policy`, { expectedVersion: 1, status: 'draft', categories: [] });
    assert.equal((await policy('instructor', A(), { minimumGradePercent: 60 })).statusCode, 200);
  });

  it('4. an inactive enrollment is rejected', async () => {
    assert.equal((await mine('s3')).eligibility!.eligible, true);
    await ok('admin', 'PUT', `${A()}/enrollments/${ids.enroll_s3}`, { status: 'inactive' });
    const staff = await ok<{ items: Array<{ student: { id: string } }> }>('instructor', 'GET', `${A()}/certificates/eligibility`);
    assert.ok(!staff.items.some((item) => item.student.id === as.s3.userId), 'inactive students are not listed');
    const res = await issue('instructor', A(), 's3');
    problem(res, 422, 'CERTIFICATE_NOT_ELIGIBLE');
    assert.match(res.json().detail, /active_enrollment/);
    await ok('admin', 'PUT', `${A()}/enrollments/${ids.enroll_s3}`, { status: 'active' });
  });

  it('3. an unpublished course is rejected', async () => {
    assert.equal((await policy('instructor', C(), { requireFinalGrade: false, minimumGradePercent: null })).statusCode, 200);
    const res = await issue('instructor', C(), 's1');
    problem(res, 422, 'CERTIFICATE_NOT_ELIGIBLE');
    assert.match(res.json().detail, /course_published/);
    problem(await request('s1', 'GET', `${C()}/certificates/mine`), 404, 'NOT_FOUND');
  });

  it('13, 14, 15. students, other courses, the design team and program managers cannot issue', async () => {
    problem(await issue('s2', A(), 's2'), 403, 'FORBIDDEN');
    problem(await issue('s1', A(), 's1'), 403, 'FORBIDDEN');
    problem(await issue('reviewer', A(), 's2'), 403, 'FORBIDDEN');
    problem(await issue('assistant', A(), 's3'), 403, 'FORBIDDEN');
    problem(await issue('pm', A(), 's3'), 404, 'NOT_FOUND');
    problem(await issue('instructorB', A(), 's3'), 404, 'NOT_FOUND');
    problem(await issue('instructor', A(), 'outsider'), 404, 'NOT_FOUND');
    problem(await issue('instructor', B(), 's3'), 404, 'NOT_FOUND');
    problem(await request('instructor', 'POST', `${A()}/certificates`, { userId: as.s3.userId }, { origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
    const noCsrf = await app.inject({ method: 'POST', url: `/api/v1${A()}/certificates`, cookies: { ap_session: as.instructor.token }, headers: { origin: ORIGIN }, payload: { userId: as.s3.userId } });
    problem(noCsrf, 403, 'CSRF_TOKEN_INVALID');
    for (const url of [`${A()}/certificates`, `${A()}/certificates/eligibility`, `${A()}/certificate-policy`]) {
      problem(await request('reviewer', 'GET', url), 403, 'FORBIDDEN');
      problem(await request('pm', 'GET', url), 404, 'NOT_FOUND');
      problem(await request('s1', 'GET', url), 403, 'FORBIDDEN');
      assert.equal((await request('assistant', 'GET', url)).statusCode, 200, `non-editing instructor reads ${url}`);
    }
    problem(await request('reviewer', 'GET', `${A()}/certificates/mine`), 403, 'FORBIDDEN');
    assert.equal(await count("SELECT count(*)::int AS n FROM course_certificates WHERE user_id = $1", [as.s3.userId]), 0);
  });

  it('12. certificates keep their snapshot when the course, the student or the policy changes', async () => {
    const version = (await query<{ version: number }>('SELECT version FROM courses WHERE id = $1', [ids.courseA]))[0]!.version;
    await ok('admin', 'PUT', A(), { version, title: 'Certificados (renombrado)' });
    await ok('admin', 'PUT', `/users/${as.s1.userId}`, { givenName: 'Renamed' });
    assert.equal((await policy('instructor', A(), { issuerName: 'Nueva Institución' })).statusCode, 200);
    const detail = await ok<Certificate>('s1', 'GET', `/certificates/${certs.s1!.id}`);
    assert.deepEqual([detail.courseTitle, detail.recipientName, detail.issuerName, detail.policyVersion], [certs.s1!.courseTitle, certs.s1!.recipientName, 'Universidad Sintética', 2]);
    const verify = await ok('admin', 'GET', `/certificates/verify/${certs.s1!.verificationPath.slice(8)}`);
    assert.equal(verify.courseTitle, 'Certificados');
    await assert.rejects(query("UPDATE course_certificates SET course_title = 'X' WHERE id = $1", [certs.s1!.id]), /only be revoked/);
    await assert.rejects(query('DELETE FROM course_certificates WHERE id = $1', [certs.s1!.id]), /cannot be deleted/);
  });

  it('17, 18. the PDF holds the certificate data only, for the recipient, course staff and administrators', async () => {
    const res = await request('s1', 'GET', `/certificates/${certs.s1!.id}/pdf`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.equal(res.headers['content-disposition'], `attachment; filename="certificate-${certs.s1!.certificateNumber}.pdf"`);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdfjs.getDocument({ data: new Uint8Array(res.rawPayload), verbosity: 0 }).promise;
    const text = (await (await document.getPage(1)).getTextContent()).items.map((item) => ('str' in item ? item.str : '')).join(' ');
    assert.equal(document.numPages, 1);
    for (const expected of ['CERTIFICADO DE FINALIZACIÓN', 'Certificate of Completion', certs.s1!.recipientName, 'Certificados', 'Universidad Sintética', certs.s1!.certificateNumber, certs.s1!.verificationPath, 'Semestre 2026-2 (2026)', 'Programa de Certificados']) {
      assert.ok(text.includes(expected), `PDF contains ${expected}`);
    }
    assert.doesNotMatch(text, /@|renombrado|Renamed|85|\/ 20|%/, 'no e-mail, later changes or grades');
    for (const who of ['assistant', 'admin', 'instructor'] as const) assert.equal((await request(who, 'GET', `/certificates/${certs.s1!.id}/pdf`)).statusCode, 200, who);
    for (const who of ['s2', 'outsider', 'instructorB', 'pm', 'reviewer'] as const) {
      problem(await request(who, 'GET', `/certificates/${certs.s1!.id}/pdf`), 404, 'CERTIFICATE_NOT_FOUND');
      problem(await request(who, 'GET', `/certificates/${certs.s1!.id}`), 404, 'CERTIFICATE_NOT_FOUND');
    }
    problem(await request(null, 'GET', `/certificates/${certs.s1!.id}/pdf`), 401, 'UNAUTHENTICATED');
    problem(await request('s1', 'GET', `/certificates/${randomUUID()}`), 404, 'CERTIFICATE_NOT_FOUND');
  });

  it('19, 20. verification: valid tokens show minimal data; invalid tokens reveal nothing', async () => {
    const token = certs.s1!.verificationPath.slice('/verify/'.length);
    const res = await request(null, 'GET', `/certificates/verify/${token}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['academicPeriod', 'certificateNumber', 'courseTitle', 'issuedAt', 'issuerName', 'recipientName', 'revokedAt', 'signatories', 'status']);
    assert.deepEqual([body.status, body.certificateNumber, body.revokedAt, body.signatories], ['valid', certs.s1!.certificateNumber, null, []]);
    for (const bad of [randomBytes(32).toString('base64url'), 'abc', certs.s1!.id, `${token.slice(0, -1)}!`, "' OR 1=1 --", certs.s1!.certificateNumber]) {
      const miss = await request(null, 'GET', `/certificates/verify/${encodeURIComponent(bad)}`);
      problem(miss, 404, 'CERTIFICATE_NOT_FOUND');
      assert.doesNotMatch(miss.body, /Certificados|Ana|Renamed|course_certificates|select/i);
    }
    const long = await request(null, 'GET', `/certificates/verify/${'a'.repeat(201)}`);
    assert.equal(long.statusCode, 414, 'over-long references are refused by the router before any lookup');
    assert.doesNotMatch(long.body, /Certificados|recipient|course_certificates/);
  });

  it('21, 22, 23. only authorized staff revoke; revoked certificates verify as revoked; everything is audited', async () => {
    const url = `${A()}/certificates/${certs.s1!.id}/revoke`;
    for (const who of ['assistant', 's1', 'reviewer'] as const) problem(await request(who, 'POST', url, { reason: 'No.' }), 403, 'FORBIDDEN');
    problem(await request('instructorB', 'POST', url, { reason: 'No.' }), 404, 'NOT_FOUND');
    problem(await request('instructorB', 'POST', `${B()}/certificates/${certs.s1!.id}/revoke`, { reason: 'No.' }), 404, 'CERTIFICATE_NOT_FOUND');
    problem(await request('instructor', 'POST', url, { reason: '  ' }), 400, 'VALIDATION_ERROR');
    const revoked = await ok<Certificate>('instructor', 'POST', url, { reason: 'Issued in error (synthetic test).' });
    assert.deepEqual([revoked.status, revoked.revocationReason], ['revoked', 'Issued in error (synthetic test).']);
    problem(await request('admin', 'POST', url, { reason: 'Again.' }), 409, 'CERTIFICATE_ALREADY_REVOKED');
    const verify = await ok('admin', 'GET', `/certificates/verify/${certs.s1!.verificationPath.slice(8)}`);
    assert.equal(verify.status, 'revoked');
    assert.ok(verify.revokedAt);
    problem(await request('s1', 'GET', `/certificates/${certs.s1!.id}/pdf`), 409, 'CERTIFICATE_REVOKED');
    await assert.rejects(query("UPDATE course_certificates SET status = 'issued', revoked_at = NULL, revoked_by_user_id = NULL, revocation_reason = NULL WHERE id = $1", [certs.s1!.id]), /revoked certificate cannot change/);
    // A new certificate may be issued after a revocation; the revoked one stays in the history.
    const reissued = await issue('admin', A(), 's1');
    assert.equal(reissued.statusCode, 201, reissued.body);
    assert.notEqual(reissued.json().certificateNumber, certs.s1!.certificateNumber);
    assert.equal(reissued.json().courseTitle, 'Certificados (renombrado)', 'a new certificate uses the current course title');
    assert.deepEqual((await mine('s1')).certificates.map((c) => c.status).sort(), ['issued', 'revoked']);
    // Audit: issuance, revocation (with reason and actor) and policy changes; history for staff only.
    const detail = await ok<Certificate>('admin', 'GET', `/certificates/${certs.s1!.id}`);
    assert.deepEqual(detail.history!.map((event) => event.action), ['certificate.issued', 'certificate.revoked']);
    assert.deepEqual([detail.history![1]!.actor!.id, detail.history![1]!.reason], [as.instructor.userId, 'Issued in error (synthetic test).']);
    assert.equal((await ok<Certificate>('s1', 'GET', `/certificates/${certs.s1!.id}`)).history, undefined, 'students get no audit history');
    assert.ok((await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'certificate_policy.updated' AND entity_id = $1", [ids.courseA])) >= 5);
    assert.equal(await count("SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'certificate%' AND metadata::text ~ $1", [certs.s1!.verificationPath.slice(8)]), 0, 'tokens are never logged');
    // Administrators see every certificate.
    const all = await ok<{ items: Certificate[] }>('admin', 'GET', '/certificates?limit=100');
    assert.equal(all.items.length, await count('SELECT count(*)::int AS n FROM course_certificates'));
    assert.equal((await ok<{ items: Certificate[] }>('admin', 'GET', '/certificates?status=revoked')).items.length, 1);
    problem(await request('instructor', 'GET', '/certificates'), 403, 'FORBIDDEN');
  });

  it('27. progress and gradebook calculations are unchanged by certificates', async () => {
    // Undo the course rename made in test 12 so the comparison only reflects certificate activity.
    const version = (await query<{ version: number }>('SELECT version FROM courses WHERE id = $1', [ids.courseA]))[0]!.version;
    await ok('admin', 'PUT', A(), { version, title: 'Certificados' });
    await ok('admin', 'PUT', `/users/${as.s1.userId}`, { givenName: 'Test' });
    assert.equal(JSON.stringify((({ columns, items }) => ({ columns, items }))(await ok('instructor', 'GET', `${A()}/gradebook?limit=100`))).replace(/"givenName":"[^"]*"/g, ''), baseline.gradebook.replace(/"givenName":"[^"]*"/g, ''));
    assert.equal(JSON.stringify(await ok('instructor', 'GET', `${A()}/progress/students?limit=100`)).replace(/"givenName":"[^"]*"/g, ''), baseline.progress.replace(/"givenName":"[^"]*"/g, ''));
    const my = await ok<{ certificates: Certificate[]; courses: Array<{ courseId: string; certificatesEnabled: boolean; eligible: boolean | null; certificate: { status: string } | null }> }>('s1', 'GET', '/me/certificates');
    const courseA = my.courses.find((c) => c.courseId === ids.courseA)!;
    assert.deepEqual([courseA.certificatesEnabled, courseA.eligible, courseA.certificate!.status], [true, true, 'issued']);
    assert.ok(!my.courses.some((c) => c.courseId === ids.courseC), 'draft courses are not listed');
    problem(await request(null, 'GET', '/me/certificates'), 401, 'UNAUTHENTICATED');
  });
});
