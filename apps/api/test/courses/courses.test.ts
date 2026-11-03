/**
 * End-to-end academic structure and enrollment scenarios against a temporary PostgreSQL database.
 * Skipped unless TEST_DATABASE_URL is set. All users are synthetic (the guarded dev seed plus
 * test-only accounts on the reserved .example domain); passwords are random per run.
 * Tests run in order and build on each other, following the administrator-to-student workflow.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { count, eq, inArray } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import {
  auditLog,
  courseTemplateSections,
  courseTemplateVersions,
  courses,
  sections,
  userCredentials,
  users,
} from '../../src/db/schema/index.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const COOKIE = 'ap_session';
const WEB_ORIGIN = 'http://localhost:3000';

const EMAILS = {
  admin: DEV_USERS[0]!.email,
  instructor: DEV_USERS[1]!.email,
  student: DEV_USERS[2]!.email,
  otherStudent: 'student2@academiapath.example',
  otherInstructor: 'instructor2@academiapath.example',
  designer: 'designer@academiapath.example',
  assistant: 'assistant@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Session = { token: string; csrfToken: string; userId: string };

function expectProblem(res: LightMyRequestResponse, status: number, code: string) {
  assert.equal(res.statusCode, status, res.body);
  assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
  const problem = res.json();
  assert.equal(problem.type, 'about:blank');
  assert.equal(problem.title, STATUS_CODES[status]);
  assert.equal(problem.status, status);
  assert.equal(problem.code, code);
}

function expectStatus(res: LightMyRequestResponse, status: number) {
  assert.equal(res.statusCode, status, res.body);
  return res.json();
}

describe('academic structure and enrollment API (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  const sessions = new Map<Person, Session>();
  const ids: Record<string, string> = {};

  const session = (person: Person) => {
    const value = sessions.get(person);
    assert.ok(value, `${person} is not signed in`);
    return value;
  };

  /** Signed request. POSTs carry the session's CSRF token unless `csrf` is overridden (null omits it). */
  const call = (
    who: Person | null,
    method: 'GET' | 'POST',
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
      headers: { ...(method === 'POST' && csrf ? { 'x-csrf-token': csrf } : {}), ...options.headers },
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
    const value = { token, csrfToken: body.csrfToken as string, userId: body.user.id as string };
    sessions.set(person, value);
    return { ...value, user: body.user };
  };

  const codesOf = (body: { items: Array<{ code: string }> }) => body.items.map((item) => item.code).sort();

  before(async () => {
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const passwordHash = await hashPassword(PASSWORD);
    for (const person of ['otherStudent', 'otherInstructor', 'designer', 'assistant'] as const) {
      const [user] = await database.db
        .insert(users)
        .values({ email: EMAILS[person], givenName: 'Test', familyName: person })
        .returning();
      assert.ok(user);
      await database.db.insert(userCredentials).values({ userId: user.id, passwordHash });
    }
    app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: WEB_ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000' }),
      database: database.db,
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  it('1. administrator authenticates', async () => {
    const { user } = await login('admin');
    assert.equal(user.systemRole, 'administrator');
    assert.equal(expectStatus(await call('admin', 'GET', '/me'), 200).user.systemRole, 'administrator');
  });

  it('2. administrator creates programs', async () => {
    const ing = expectStatus(
      await call('admin', 'POST', '/programs', { payload: { code: 'ING-SIS', name: 'Ingeniería de Sistemas' } }),
      201,
    );
    assert.equal(ing.isActive, true);
    assert.equal(ing.description, null);
    ids.programIng = ing.id;
    ids.programAdm = expectStatus(
      await call('admin', 'POST', '/programs', { payload: { code: 'ADM', name: 'Administración', description: 'Business' } }),
      201,
    ).id;
    expectProblem(await call('admin', 'POST', '/programs', { payload: { code: 'ING-SIS', name: 'Dup' } }), 409, 'PROGRAM_CODE_TAKEN');
    expectProblem(await call('admin', 'POST', '/programs', { payload: { code: 'bad code!', name: 'X' } }), 400, 'VALIDATION_ERROR');
    assert.deepEqual(codesOf(expectStatus(await call('admin', 'GET', '/programs'), 200)), ['ADM', 'ING-SIS']);
  });

  it('3. administrator creates terms', async () => {
    const term = expectStatus(
      await call('admin', 'POST', '/terms', {
        payload: { code: '2026-2', name: 'Semestre 2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' },
      }),
      201,
    );
    assert.deepEqual([term.startsOn, term.endsOn], ['2026-08-17', '2026-12-11']);
    ids.term1 = term.id;
    ids.term2 = expectStatus(
      await call('admin', 'POST', '/terms', {
        payload: { code: '2027-1', name: 'Semestre 2027-I', startsOn: '2027-03-15', endsOn: '2027-07-10' },
      }),
      201,
    ).id;
    expectProblem(
      await call('admin', 'POST', '/terms', { payload: { code: 'BAD', name: 'Bad', startsOn: '2026-12-01', endsOn: '2026-08-01' } }),
      422,
      'INVALID_TERM_DATES',
    );
    expectProblem(
      await call('admin', 'POST', '/terms', { payload: { code: '2026-2', name: 'Dup', startsOn: '2026-08-17', endsOn: '2026-12-11' } }),
      409,
      'TERM_CODE_TAKEN',
    );
    assert.deepEqual(codesOf(expectStatus(await call('admin', 'GET', '/terms'), 200)), ['2026-2', '2027-1']);
  });

  it('4. administrator creates a versioned template and keeps earlier versions', async () => {
    const v1 = expectStatus(
      await call('admin', 'POST', '/course-templates', {
        payload: {
          code: 'ITIL-F',
          programId: ids.programIng,
          title: 'ITIL Fundamentals',
          sections: [
            { title: 'Introduction', summary: 'Course overview' },
            { title: 'Instructor notes', isVisible: false },
            { title: 'Service value system' },
          ],
        },
      }),
      201,
    );
    assert.equal(v1.version, 1);
    assert.deepEqual(
      v1.sections.map((s: { title: string; position: number; isVisible: boolean }) => [s.title, s.position, s.isVisible]),
      [
        ['Introduction', 0, true],
        ['Instructor notes', 1, false],
        ['Service value system', 2, true],
      ],
    );
    ids.template = v1.templateId;
    ids.templateV1 = v1.id;

    const v2 = expectStatus(
      await call('admin', 'POST', '/course-templates', {
        payload: {
          code: 'ITIL-F',
          programId: ids.programIng,
          title: 'ITIL Fundamentals (v2)',
          sections: [{ title: 'Introduction' }, { title: 'Practices' }],
        },
      }),
      201,
    );
    assert.equal(v2.version, 2);
    assert.equal(v2.templateId, ids.template);
    ids.templateV2 = v2.id;

    // Version 1 is preserved unchanged.
    const [storedV1] = await database.db.select().from(courseTemplateVersions).where(eq(courseTemplateVersions.id, ids.templateV1!));
    assert.equal(storedV1?.title, 'ITIL Fundamentals');
    const v1Sections = await database.db
      .select()
      .from(courseTemplateSections)
      .where(eq(courseTemplateSections.templateVersionId, ids.templateV1!));
    assert.equal(v1Sections.length, 3);

    expectProblem(
      await call('admin', 'POST', '/course-templates', {
        payload: { code: 'ITIL-F', programId: ids.programAdm, title: 'Wrong program', sections: [] },
      }),
      422,
      'TEMPLATE_PROGRAM_MISMATCH',
    );
    ids.templateAdm = expectStatus(
      await call('admin', 'POST', '/course-templates', {
        payload: { code: 'ADM-101', programId: ids.programAdm, title: 'Intro to Management', sections: [{ title: 'Week 1' }] },
      }),
      201,
    ).templateId;

    const list = expectStatus(await call('admin', 'GET', '/course-templates'), 200);
    const itil = list.items.find((t: { code: string }) => t.code === 'ITIL-F');
    assert.equal(itil.latestVersion.version, 2);
    assert.equal(itil.title, 'ITIL Fundamentals (v2)');
  });

  it('5. administrator creates courses from the template', async () => {
    const courseA = expectStatus(
      await call('admin', 'POST', '/courses', {
        payload: {
          programId: ids.programIng,
          termId: ids.term1,
          templateId: ids.template,
          templateVersion: 1,
          code: 'ITIL-2026-2-A',
          status: 'published',
        },
      }),
      201,
    );
    assert.equal(courseA.templateVersionId, ids.templateV1);
    assert.equal(courseA.title, 'ITIL Fundamentals');
    assert.equal(courseA.status, 'published');
    assert.equal(courseA.viewerRole, null);
    ids.courseA = courseA.id;

    const courseB = expectStatus(
      await call('admin', 'POST', '/courses', {
        payload: { programId: ids.programIng, termId: ids.term1, templateId: ids.template, code: 'ITIL-2026-2-B', status: 'published' },
      }),
      201,
    );
    assert.equal(courseB.templateVersionId, ids.templateV2, 'defaults to the latest version');
    ids.courseB = courseB.id;

    const courseC = expectStatus(
      await call('admin', 'POST', '/courses', {
        payload: { programId: ids.programIng, termId: ids.term1, templateId: ids.template, templateVersion: 1, code: 'ITIL-2026-2-C' },
      }),
      201,
    );
    assert.equal(courseC.status, 'draft', 'courses are drafts by default');
    ids.courseC = courseC.id;
  });

  it('6. template sections are copied into each course', async () => {
    const page = expectStatus(await call('admin', 'GET', `/courses/${ids.courseA}/sections`), 200);
    assert.deepEqual(
      page.items.map((s: { title: string; position: number; isVisible: boolean }) => [s.title, s.position, s.isVisible]),
      [
        ['Introduction', 0, true],
        ['Instructor notes', 1, false],
        ['Service value system', 2, true],
      ],
    );
    assert.equal(page.items[0].summary, 'Course overview');
    const templateSectionIds = (
      await database.db.select({ id: courseTemplateSections.id }).from(courseTemplateSections)
    ).map((row) => row.id);
    assert.ok(page.items.every((s: { id: string }) => !templateSectionIds.includes(s.id)), 'copies are new rows');
    const [{ n } = { n: 0 }] = await database.db.select({ n: count() }).from(sections).where(eq(sections.courseId, ids.courseB!));
    assert.equal(n, 2, 'course B copied version 2 (2 sections)');
  });

  it('7. administrator enrolls users with course roles', async () => {
    const enrollment = expectStatus(
      await call('admin', 'POST', `/courses/${ids.courseA}/enrollments`, {
        payload: { email: EMAILS.student.toUpperCase(), role: 'student' },
      }),
      201,
    );
    assert.equal(enrollment.role, 'student');
    assert.equal(enrollment.status, 'active');
    assert.equal(enrollment.user.email, EMAILS.student);
    ids.studentId = enrollment.user.id;

    const enroll = async (course: string, person: Person, role: string) =>
      expectStatus(await call('admin', 'POST', `/courses/${course}/enrollments`, { payload: { email: EMAILS[person], role } }), 201);
    await enroll(ids.courseA!, 'instructor', 'instructor');
    await enroll(ids.courseA!, 'designer', 'design_team');
    await enroll(ids.courseA!, 'assistant', 'non_editing_instructor');
    await enroll(ids.courseB!, 'otherInstructor', 'instructor');
    await enroll(ids.courseB!, 'otherStudent', 'student');
    await enroll(ids.courseC!, 'instructor', 'instructor');
    // By user id: the student is also enrolled in the draft course C.
    expectStatus(
      await call('admin', 'POST', `/courses/${ids.courseC}/enrollments`, { payload: { userId: ids.studentId, role: 'student' } }),
      201,
    );
  });

  it('8. student logs in', async () => {
    const { user } = await login('student');
    assert.equal(user.systemRole, 'user');
  });

  it('9. student sees only their enrolled, published course and visible sections', async () => {
    const list = expectStatus(await call('student', 'GET', '/courses'), 200);
    assert.deepEqual(codesOf(list), ['ITIL-2026-2-A']);
    assert.equal(list.items[0].viewerRole, 'student');
    assert.equal(expectStatus(await call('student', 'GET', `/courses/${ids.courseA}`), 200).viewerRole, 'student');
    const visible = expectStatus(await call('student', 'GET', `/courses/${ids.courseA}/sections`), 200);
    assert.deepEqual(
      visible.items.map((s: { title: string }) => s.title),
      ['Introduction', 'Service value system'],
      'hidden sections are not shown to students',
    );
  });

  it('10. student cannot see an unrelated course (indistinguishable from a missing one)', async () => {
    const missing = await call('student', 'GET', `/courses/${randomUUID()}`);
    expectProblem(missing, 404, 'NOT_FOUND');
    for (const path of [`/courses/${ids.courseB}`, `/courses/${ids.courseB}/sections`, `/courses/${ids.courseB}/enrollments`]) {
      const res = await call('student', 'GET', path);
      expectProblem(res, 404, 'NOT_FOUND');
      assert.equal(res.body, missing.body);
    }
  });

  it('does not expose draft courses to enrolled students', async () => {
    for (const path of [`/courses/${ids.courseC}`, `/courses/${ids.courseC}/sections`, `/courses/${ids.courseC}/enrollments`]) {
      expectProblem(await call('student', 'GET', path), 404, 'NOT_FOUND');
    }
    assert.equal(expectStatus(await call('admin', 'GET', `/courses/${ids.courseC}`), 200).status, 'draft');
  });

  it('11. student cannot create courses, templates or academic structures', async () => {
    const attempts: Array<[string, object]> = [
      ['/courses', { programId: ids.programIng, termId: ids.term1, templateId: ids.template, code: 'HACK-1' }],
      ['/course-templates', { code: 'HACK-T', title: 'Hack', sections: [] }],
      ['/programs', { code: 'HACK-P', name: 'Hack' }],
      ['/terms', { code: 'HACK', name: 'Hack', startsOn: '2026-01-01', endsOn: '2026-02-01' }],
    ];
    for (const [path, payload] of attempts) {
      expectProblem(await call('student', 'POST', path, { payload }), 403, 'FORBIDDEN');
    }
    for (const path of ['/programs', '/terms', '/course-templates']) {
      expectProblem(await call('student', 'GET', path), 403, 'FORBIDDEN');
    }
    const [{ n } = { n: 0 }] = await database.db.select({ n: count() }).from(courses).where(eq(courses.code, 'HACK-1'));
    assert.equal(n, 0);
  });

  it("12. student cannot enroll users or read other students' enrollments", async () => {
    expectProblem(
      await call('student', 'POST', `/courses/${ids.courseA}/enrollments`, { payload: { email: EMAILS.otherStudent, role: 'student' } }),
      403,
      'FORBIDDEN',
    );
    expectProblem(
      await call('student', 'POST', `/courses/${ids.courseA}/enrollments`, { payload: { userId: ids.studentId, role: 'instructor' } }),
      403,
      'FORBIDDEN',
    );
    const own = expectStatus(await call('student', 'GET', `/courses/${ids.courseA}/enrollments`), 200);
    assert.equal(own.items.length, 1, 'students see only their own enrollment');
    assert.equal(own.items[0].user.id, ids.studentId);
    assert.equal(own.items[0].role, 'student');
  });

  it('13. an instructor of another course cannot access this course', async () => {
    await login('otherInstructor');
    for (const path of [`/courses/${ids.courseA}`, `/courses/${ids.courseA}/sections`, `/courses/${ids.courseA}/enrollments`]) {
      expectProblem(await call('otherInstructor', 'GET', path), 404, 'NOT_FOUND');
    }
    assert.deepEqual(codesOf(expectStatus(await call('otherInstructor', 'GET', '/courses'), 200)), ['ITIL-2026-2-B']);
    const roster = expectStatus(await call('otherInstructor', 'GET', `/courses/${ids.courseB}/enrollments`), 200);
    assert.deepEqual(roster.items.map((e: { role: string }) => e.role).sort(), ['instructor', 'student']);
    expectProblem(
      await call('otherInstructor', 'POST', `/courses/${ids.courseB}/enrollments`, { payload: { email: EMAILS.student, role: 'student' } }),
      403,
      'FORBIDDEN',
    );
  });

  it('course staff access only assigned courses and cannot perform administrator actions', async () => {
    await login('instructor');
    await login('designer');
    await login('assistant');

    // Staff see their assigned courses, including drafts; students never do.
    assert.deepEqual(codesOf(expectStatus(await call('instructor', 'GET', '/courses'), 200)), ['ITIL-2026-2-A', 'ITIL-2026-2-C']);
    assert.deepEqual(codesOf(expectStatus(await call('designer', 'GET', '/courses'), 200)), ['ITIL-2026-2-A']);

    for (const [person, role] of [
      ['designer', 'design_team'],
      ['assistant', 'non_editing_instructor'],
      ['instructor', 'instructor'],
    ] as const) {
      assert.equal(expectStatus(await call(person, 'GET', `/courses/${ids.courseA}`), 200).viewerRole, role);
      assert.equal(expectStatus(await call(person, 'GET', `/courses/${ids.courseA}/sections`), 200).items.length, 3, 'staff see hidden sections');
      assert.equal(expectStatus(await call(person, 'GET', `/courses/${ids.courseA}/enrollments`), 200).items.length, 4, 'staff see the roster');
      expectProblem(await call(person, 'GET', `/courses/${ids.courseB}`), 404, 'NOT_FOUND');
      expectProblem(await call(person, 'POST', '/programs', { payload: { code: `P-${person}`, name: 'X' } }), 403, 'FORBIDDEN');
      expectProblem(
        await call(person, 'POST', `/courses/${ids.courseA}/enrollments`, { payload: { email: EMAILS.otherStudent, role: 'student' } }),
        403,
        'FORBIDDEN',
      );
      expectProblem(
        await call(person, 'POST', '/course-templates', { payload: { code: `T-${person}`, title: 'X', sections: [] } }),
        403,
        'FORBIDDEN',
      );
    }
  });

  it('14. duplicate enrollments are rejected', async () => {
    expectProblem(
      await call('admin', 'POST', `/courses/${ids.courseA}/enrollments`, { payload: { email: EMAILS.student, role: 'instructor' } }),
      409,
      'ENROLLMENT_EXISTS',
    );
    const roster = expectStatus(await call('admin', 'GET', `/courses/${ids.courseA}/enrollments`), 200);
    const studentRows = roster.items.filter((e: { user: { id: string } }) => e.user.id === ids.studentId);
    assert.equal(studentRows.length, 1);
    assert.equal(studentRows[0].role, 'student', 'role unchanged');
  });

  it('15. invalid course, template, term and enrollment combinations are rejected', async () => {
    const before = (await database.db.select({ n: count() }).from(courses))[0]?.n;
    const base = { programId: ids.programIng, termId: ids.term1, templateId: ids.template, code: 'ITIL-NEW' };
    const cases: Array<[object, number, string]> = [
      [{ ...base, templateId: ids.templateAdm }, 422, 'TEMPLATE_PROGRAM_MISMATCH'],
      [{ ...base, termId: randomUUID() }, 422, 'TERM_NOT_FOUND'],
      [{ ...base, templateId: randomUUID() }, 422, 'TEMPLATE_NOT_FOUND'],
      [{ ...base, programId: randomUUID() }, 422, 'PROGRAM_NOT_FOUND'],
      [{ ...base, templateVersion: 99 }, 422, 'TEMPLATE_VERSION_NOT_FOUND'],
      [{ ...base, code: 'ITIL-2026-2-A' }, 409, 'COURSE_CODE_TAKEN'],
      [{ ...base, status: 'archived' }, 400, 'VALIDATION_ERROR'],
    ];
    for (const [payload, status, code] of cases) {
      expectProblem(await call('admin', 'POST', '/courses', { payload }), status, code);
    }
    const after = (await database.db.select({ n: count() }).from(courses))[0]?.n;
    assert.equal(after, before, 'rejected requests created no courses');

    // The same code is allowed in a different term.
    ids.courseD = expectStatus(
      await call('admin', 'POST', '/courses', { payload: { ...base, termId: ids.term2, code: 'ITIL-2026-2-A' } }),
      201,
    ).id;

    // Database-level guards back the API checks.
    const isPgError = (code: string) => (error: unknown) => {
      let current: unknown = error;
      while (current && typeof current === 'object') {
        if ((current as { code?: string }).code === code) return true;
        current = (current as { cause?: unknown }).cause;
      }
      return false;
    };
    await assert.rejects(
      database.pool.query(
        `INSERT INTO courses (term_id, program_id, template_id, template_version_id, code, title) VALUES ($1, $2, $3, NULL, 'DB-1', 'x')`,
        [ids.term1, ids.programIng, ids.templateAdm],
      ),
      isPgError('23514'),
      'trigger rejects a template from another program',
    );
    await assert.rejects(
      database.pool.query(
        `INSERT INTO courses (term_id, program_id, template_id, template_version_id, code, title) VALUES ($1, $2, $3, $4, 'DB-2', 'x')`,
        [ids.term1, ids.programIng, ids.template, (await database.db.select().from(courseTemplateVersions).where(eq(courseTemplateVersions.templateId, ids.templateAdm!)))[0]?.id],
      ),
      isPgError('23503'),
      'composite foreign key rejects a version of another template',
    );

    // Enrollment input errors.
    expectProblem(
      await call('admin', 'POST', `/courses/${ids.courseA}/enrollments`, { payload: { email: 'nobody@academiapath.example', role: 'student' } }),
      422,
      'USER_NOT_FOUND',
    );
    expectProblem(
      await call('admin', 'POST', `/courses/${ids.courseA}/enrollments`, { payload: { email: EMAILS.otherStudent, userId: ids.studentId, role: 'student' } }),
      400,
      'VALIDATION_ERROR',
    );
    expectProblem(
      await call('admin', 'POST', `/courses/${ids.courseA}/enrollments`, { payload: { email: EMAILS.otherStudent, role: 'administrator' } }),
      400,
      'VALIDATION_ERROR',
    );
    expectProblem(
      await call('admin', 'POST', `/courses/${randomUUID()}/enrollments`, { payload: { email: EMAILS.otherStudent, role: 'student' } }),
      404,
      'NOT_FOUND',
    );
    expectProblem(await call('admin', 'GET', '/courses/not-a-uuid'), 400, 'VALIDATION_ERROR');
  });

  it('16. unauthenticated requests are denied on every endpoint', async () => {
    const endpoints: Array<['GET' | 'POST', string]> = [
      ['GET', '/programs'],
      ['POST', '/programs'],
      ['GET', '/terms'],
      ['POST', '/terms'],
      ['GET', '/course-templates'],
      ['POST', '/course-templates'],
      ['GET', '/courses'],
      ['POST', '/courses'],
      ['GET', `/courses/${ids.courseA}`],
      ['GET', `/courses/${ids.courseA}/enrollments`],
      ['POST', `/courses/${ids.courseA}/enrollments`],
      ['GET', `/courses/${ids.courseA}/sections`],
    ];
    for (const [method, path] of endpoints) {
      expectProblem(await call(null, method, path, { payload: method === 'POST' ? {} : undefined }), 401, 'UNAUTHENTICATED');
    }
  });

  it('17. state-changing requests require CSRF and an allowed origin', async () => {
    const payload = { code: 'CSRF-P', name: 'CSRF test' };
    expectProblem(await call('admin', 'POST', '/programs', { payload, csrf: null }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await call('admin', 'POST', '/programs', { payload, csrf: session('student').csrfToken }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(
      await call('admin', 'POST', '/programs', { payload, headers: { origin: 'https://evil.example' } }),
      403,
      'ORIGIN_NOT_ALLOWED',
    );
    expectProblem(
      await call('admin', 'POST', `/courses/${ids.courseA}/enrollments`, { payload: { email: EMAILS.otherStudent, role: 'student' }, csrf: 'forged' }),
      403,
      'CSRF_TOKEN_INVALID',
    );
    assert.ok(!codesOf(expectStatus(await call('admin', 'GET', '/programs'), 200)).includes('CSRF-P'));
    expectStatus(await call('admin', 'POST', '/programs', { payload, headers: { origin: WEB_ORIGIN } }), 201);
  });

  it('18. academic structure, course and enrollment changes are audited', async () => {
    const adminId = session('admin').userId;
    const entries = await database.db
      .select()
      .from(auditLog)
      .where(
        inArray(auditLog.action, [
          'program.created',
          'term.created',
          'course_template.created',
          'course_template.version_created',
          'course.created',
          'enrollment.created',
        ]),
      );
    const counts = Object.fromEntries(
      [...new Set(entries.map((e) => e.action))].map((action) => [action, entries.filter((e) => e.action === action).length]),
    );
    assert.deepEqual(counts, {
      'program.created': 3,
      'term.created': 2,
      'course_template.created': 2,
      'course_template.version_created': 1,
      'course.created': 4,
      'enrollment.created': 8,
    });
    for (const entry of entries) {
      assert.equal(entry.actorUserId, adminId, `${entry.action} records the actor`);
      assert.ok(entry.entityId, `${entry.action} records the object`);
      assert.ok(entry.createdAt instanceof Date, `${entry.action} records the time`);
      assert.ok('before' in entry.metadata && 'after' in entry.metadata, `${entry.action} records before/after`);
      const serialized = JSON.stringify(entry.metadata);
      for (const secret of [PASSWORD, '$argon2', ...[...sessions.values()].flatMap((s) => [s.token, s.csrfToken])]) {
        assert.ok(!serialized.includes(secret), `${entry.action} contains no credentials or tokens`);
      }
      assert.ok(!/"(password|passwordHash|token|csrfToken)"/i.test(serialized), 'no secret fields');
    }

    const version = entries.find((e) => e.action === 'course_template.version_created');
    assert.deepEqual(version?.metadata.before, { title: 'ITIL Fundamentals', description: null, latestVersion: 1 });
    assert.equal((version?.metadata.after as { version: number }).version, 2);

    const courseEntry = entries.find((e) => e.action === 'course.created' && e.entityId === ids.courseA);
    assert.deepEqual(
      [courseEntry?.metadata.before, (courseEntry?.metadata.after as { templateVersion: number; sectionCount: number }).templateVersion],
      [null, 1],
    );
    const enrollmentEntry = entries.find(
      (e) => e.action === 'enrollment.created' && (e.metadata.after as { userId: string }).userId === ids.studentId && (e.metadata.after as { courseId: string }).courseId === ids.courseA,
    );
    assert.deepEqual(enrollmentEntry?.metadata, {
      before: null,
      after: { courseId: ids.courseA, userId: ids.studentId, role: 'student', status: 'active' },
    });
  });

  it('paginates lists with bounded limits and opaque cursors', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const page = expectStatus(await call('admin', 'GET', `/courses${query}`), 200);
      assert.ok(page.items.length <= 2);
      seen.push(...page.items.map((c: { id: string }) => c.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(seen.length, 4);
    assert.equal(new Set(seen).size, 4, 'no duplicates across pages');

    const firstSections = expectStatus(await call('admin', 'GET', `/courses/${ids.courseA}/sections?limit=2`), 200);
    const restSections = expectStatus(
      await call('admin', 'GET', `/courses/${ids.courseA}/sections?limit=2&cursor=${firstSections.nextCursor}`),
      200,
    );
    assert.deepEqual(
      [...firstSections.items, ...restSections.items].map((s: { position: number }) => s.position),
      [0, 1, 2],
    );
    assert.equal(restSections.nextCursor, null);

    expectProblem(await call('admin', 'GET', '/programs?limit=101'), 400, 'VALIDATION_ERROR');
    expectProblem(await call('admin', 'GET', '/programs?limit=0'), 400, 'VALIDATION_ERROR');
    expectProblem(await call('admin', 'GET', '/programs?cursor=garbage'), 400, 'INVALID_CURSOR');
  });
});
