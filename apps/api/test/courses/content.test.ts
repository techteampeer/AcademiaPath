/**
 * Course content, review and publication scenarios against a temporary PostgreSQL database.
 * Skipped unless TEST_DATABASE_URL is set. All users are synthetic; passwords are random per run.
 * Tests run in order and build on each other.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { and, asc, count, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { activities, auditLog, userCredentials, users } from '../../src/db/schema/index.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const COOKIE = 'ap_session';
const WEB_ORIGIN = 'http://localhost:3000';

const EMAILS = {
  admin: DEV_USERS[0]!.email,
  instructor: DEV_USERS[1]!.email,
  student: DEV_USERS[2]!.email,
  reviewer: DEV_USERS[3]!.email,
  assistant: 'assistant@academiapath.example',
  otherDesigner: 'designer2@academiapath.example',
  otherInstructor: 'instructor2@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Session = { token: string; csrfToken: string; userId: string };

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

describe('course content review and publication (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  const sessions = new Map<Person, Session>();
  const ids: Record<string, string> = {};

  const session = (person: Person) => {
    const value = sessions.get(person);
    assert.ok(value, `${person} is not signed in`);
    return value;
  };

  const call = (
    who: Person | null,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    options: { payload?: object; csrf?: string | null } = {},
  ) => {
    const current = who ? session(who) : null;
    const csrf = options.csrf === undefined ? current?.csrfToken : options.csrf;
    return app.inject({
      method,
      url: `/api/v1${url}`,
      ...(options.payload ? { payload: options.payload } : {}),
      cookies: current ? { [COOKIE]: current.token } : {},
      headers: method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {},
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

  const activityUrl = (courseId: string, activityId: string) => `/courses/${courseId}/activities/${activityId}`;
  const sectionActivitiesUrl = (courseId: string, sectionId: string) => `/courses/${courseId}/sections/${sectionId}/activities`;
  const create = async (who: Person, courseId: string, sectionId: string, payload: object) =>
    expectStatus(await call(who, 'POST', sectionActivitiesUrl(courseId, sectionId), { payload }), 201);
  const submit = async (who: Person, courseId: string, activityId: string) =>
    expectStatus(await call(who, 'POST', `${activityUrl(courseId, activityId)}/submit`), 200);
  const review = (who: Person, courseId: string, activityId: string, payload: object) =>
    call(who, 'POST', `${activityUrl(courseId, activityId)}/review`, { payload });
  const titlesFor = async (who: Person, courseId: string, sectionId: string) =>
    expectStatus(await call(who, 'GET', sectionActivitiesUrl(courseId, sectionId)), 200).items.map((a: { title: string }) => a.title);

  before(async () => {
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const passwordHash = await hashPassword(PASSWORD);
    for (const person of ['assistant', 'otherDesigner', 'otherInstructor'] as const) {
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

    // Academic structure through the real API (administrator).
    const program = expectStatus(await call('admin', 'POST', '/programs', { payload: { code: 'ING-SIS', name: 'Ingeniería de Sistemas' } }), 201);
    const term = expectStatus(
      await call('admin', 'POST', '/terms', { payload: { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' } }),
      201,
    );
    const template = expectStatus(
      await call('admin', 'POST', '/course-templates', {
        payload: {
          code: 'ITIL-F',
          programId: program.id,
          title: 'ITIL Fundamentals',
          sections: [{ title: 'Introduction' }, { title: 'Instructor notes', isVisible: false }, { title: 'Unit 2' }],
        },
      }),
      201,
    );
    const course = (code: string, status: string) =>
      call('admin', 'POST', '/courses', { payload: { programId: program.id, termId: term.id, templateId: template.templateId, code, status } });
    ids.courseA = expectStatus(await course('ITIL-A', 'published'), 201).id;
    ids.courseB = expectStatus(await course('ITIL-B', 'published'), 201).id;
    ids.courseC = expectStatus(await course('ITIL-C', 'draft'), 201).id;
    const enroll = async (courseId: string, person: Person, role: string) =>
      expectStatus(await call('admin', 'POST', `/courses/${courseId}/enrollments`, { payload: { email: EMAILS[person], role } }), 201);
    await enroll(ids.courseA!, 'instructor', 'instructor');
    await enroll(ids.courseA!, 'reviewer', 'design_team');
    await enroll(ids.courseA!, 'assistant', 'non_editing_instructor');
    await enroll(ids.courseA!, 'student', 'student');
    await enroll(ids.courseB!, 'otherDesigner', 'design_team');
    await enroll(ids.courseB!, 'otherInstructor', 'instructor');
    await enroll(ids.courseC!, 'instructor', 'instructor');
    await enroll(ids.courseC!, 'student', 'student');

    const sectionIds = async (courseId: string) =>
      expectStatus(await call('admin', 'GET', `/courses/${courseId}/sections`), 200).items.map((s: { id: string }) => s.id);
    [ids.introA, ids.hiddenA, ids.unit2A] = await sectionIds(ids.courseA!);
    [ids.introB] = await sectionIds(ids.courseB!);
    [ids.introC] = await sectionIds(ids.courseC!);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  it('1. instructor creates a text lesson as a draft', async () => {
    const lesson = await create('instructor', ids.courseA!, ids.introA!, {
      type: 'page',
      title: 'What is ITIL?',
      body: 'ITIL is a framework for IT service management.\nIt focuses on value.',
    });
    assert.equal(lesson.type, 'page');
    assert.equal(lesson.review.status, 'draft');
    assert.equal(lesson.liveVersion, null);
    assert.equal(lesson.content.body, 'ITIL is a framework for IT service management.\nIt focuses on value.');
    assert.equal(lesson.position, 0);
    ids.lesson = lesson.id;
  });

  it('2. instructor creates an external link resource', async () => {
    const link = await create('instructor', ids.courseA!, ids.introA!, {
      type: 'link',
      title: 'ITIL glossary',
      url: 'https://www.axelos.com/itil-glossary',
      description: 'Official glossary of ITIL terms.',
    });
    assert.equal(link.type, 'link');
    assert.equal(link.review.status, 'draft');
    assert.deepEqual(link.content, { url: 'https://www.axelos.com/itil-glossary', description: 'Official glossary of ITIL terms.', kind: 'website' });
    assert.equal(link.position, 1, 'appended after the lesson');
    ids.link = link.id;
  });

  it('3. drafts are invisible to students', async () => {
    assert.deepEqual(await titlesFor('student', ids.courseA!, ids.introA!), []);
    expectProblem(await call('student', 'GET', activityUrl(ids.courseA!, ids.lesson!)), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', activityUrl(ids.courseA!, ids.link!)), 404, 'NOT_FOUND');
  });

  it('4. instructor submits the lesson for review', async () => {
    const submitted = await submit('instructor', ids.courseA!, ids.lesson!);
    assert.equal(submitted.review.status, 'submitted');
    assert.equal(submitted.review.submittedByUserId, session('instructor').userId);
    assert.ok(submitted.review.submittedAt);
    expectProblem(await call('instructor', 'POST', `${activityUrl(ids.courseA!, ids.lesson!)}/submit`), 409, 'INVALID_REVIEW_STATE');
    expectProblem(
      await call('instructor', 'PUT', activityUrl(ids.courseA!, ids.lesson!), { payload: { title: 'Changed', body: 'Changed' } }),
      409,
      'ACTIVITY_UNDER_REVIEW',
    );
  });

  it('5. instructor cannot approve (their own) content', async () => {
    expectProblem(await review('instructor', ids.courseA!, ids.lesson!, { decision: 'approve' }), 403, 'FORBIDDEN');
    const lesson = expectStatus(await call('instructor', 'GET', activityUrl(ids.courseA!, ids.lesson!)), 200);
    assert.equal(lesson.review.status, 'submitted');
  });

  it('6. design team approves assigned content', async () => {
    const approved = expectStatus(await review('reviewer', ids.courseA!, ids.lesson!, { decision: 'approve' }), 200);
    assert.equal(approved.review.status, 'approved');
    assert.equal(approved.review.reviewedByUserId, session('reviewer').userId);
    assert.equal(approved.liveVersion.title, 'What is ITIL?');
    assert.deepEqual(approved.liveVersion.content, approved.content);
  });

  it('7. design team returns content with a comment', async () => {
    await submit('instructor', ids.courseA!, ids.link!);
    expectProblem(await review('reviewer', ids.courseA!, ids.link!, { decision: 'return' }), 422, 'REVIEW_COMMENT_REQUIRED');
    expectProblem(await review('reviewer', ids.courseA!, ids.link!, { decision: 'return', comment: '   ' }), 400, 'VALIDATION_ERROR');
    const returned = expectStatus(
      await review('reviewer', ids.courseA!, ids.link!, { decision: 'return', comment: 'Please link the Spanish version.' }),
      200,
    );
    assert.equal(returned.review.status, 'returned');
    assert.equal(returned.review.comment, 'Please link the Spanish version.');
    assert.equal(returned.liveVersion, null);
  });

  it('8. returned content can be revised and resubmitted', async () => {
    const revised = expectStatus(
      await call('instructor', 'PUT', activityUrl(ids.courseA!, ids.link!), {
        payload: { title: 'Glosario ITIL', url: 'https://www.axelos.com/es/itil-glossary', description: 'Glosario oficial.' },
      }),
      200,
    );
    assert.equal(revised.review.status, 'returned', 'stays returned until resubmitted');
    assert.equal(revised.content.url, 'https://www.axelos.com/es/itil-glossary');
    assert.equal((await submit('instructor', ids.courseA!, ids.link!)).review.status, 'submitted');
    assert.equal(expectStatus(await review('reviewer', ids.courseA!, ids.link!, { decision: 'approve', comment: 'Thanks!' }), 200).review.status, 'approved');
  });

  it('9. students see approved content (the live version only)', async () => {
    const list = expectStatus(await call('student', 'GET', sectionActivitiesUrl(ids.courseA!, ids.introA!)), 200);
    assert.deepEqual(list.items.map((a: { title: string }) => a.title), ['What is ITIL?', 'Glosario ITIL']);
    for (const item of list.items) {
      assert.equal(item.review, null, 'no review metadata for students');
      assert.equal(item.liveVersion, null);
    }
    const lesson = expectStatus(await call('student', 'GET', activityUrl(ids.courseA!, ids.lesson!)), 200);
    assert.equal(lesson.content.body, 'ITIL is a framework for IT service management.\nIt focuses on value.');
  });

  it('10. students cannot see unapproved content', async () => {
    ids.draft = (await create('instructor', ids.courseA!, ids.introA!, { type: 'page', title: 'Draft notes', body: 'Not ready.' })).id;
    ids.pending = (await create('instructor', ids.courseA!, ids.introA!, { type: 'page', title: 'Pending lesson', body: 'Awaiting review.' })).id;
    await submit('instructor', ids.courseA!, ids.pending!);
    assert.deepEqual(await titlesFor('student', ids.courseA!, ids.introA!), ['What is ITIL?', 'Glosario ITIL']);
    expectProblem(await call('student', 'GET', activityUrl(ids.courseA!, ids.draft!)), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', activityUrl(ids.courseA!, ids.pending!)), 404, 'NOT_FOUND');
    assert.deepEqual(await titlesFor('instructor', ids.courseA!, ids.introA!), ['What is ITIL?', 'Glosario ITIL', 'Draft notes', 'Pending lesson']);
  });

  it('11. students cannot modify content or review decisions', async () => {
    expectProblem(await call('student', 'PUT', activityUrl(ids.courseA!, ids.lesson!), { payload: { title: 'Hacked', body: 'Hacked' } }), 403, 'FORBIDDEN');
    expectProblem(await call('student', 'POST', sectionActivitiesUrl(ids.courseA!, ids.introA!), { payload: { type: 'page', title: 'X', body: 'Y' } }), 403, 'FORBIDDEN');
    expectProblem(await call('student', 'POST', `${activityUrl(ids.courseA!, ids.draft!)}/submit`), 403, 'FORBIDDEN');
    expectProblem(await review('student', ids.courseA!, ids.pending!, { decision: 'approve' }), 403, 'FORBIDDEN');
  });

  it('12. non-editing instructors can read but not modify, submit or review', async () => {
    assert.equal(expectStatus(await call('assistant', 'GET', activityUrl(ids.courseA!, ids.draft!)), 200).review.status, 'draft');
    expectProblem(await call('assistant', 'PUT', activityUrl(ids.courseA!, ids.draft!), { payload: { title: 'X', body: 'Y' } }), 403, 'FORBIDDEN');
    expectProblem(await call('assistant', 'POST', sectionActivitiesUrl(ids.courseA!, ids.introA!), { payload: { type: 'page', title: 'X', body: 'Y' } }), 403, 'FORBIDDEN');
    expectProblem(await call('assistant', 'POST', `${activityUrl(ids.courseA!, ids.draft!)}/submit`), 403, 'FORBIDDEN');
    expectProblem(await review('assistant', ids.courseA!, ids.pending!, { decision: 'approve' }), 403, 'FORBIDDEN');
  });

  it('13. design team from another course cannot approve', async () => {
    expectProblem(await review('otherDesigner', ids.courseA!, ids.pending!, { decision: 'approve' }), 404, 'NOT_FOUND');
    expectProblem(await review('otherDesigner', ids.courseB!, ids.pending!, { decision: 'approve' }), 404, 'NOT_FOUND');
    const pending = expectStatus(await call('reviewer', 'GET', activityUrl(ids.courseA!, ids.pending!)), 200);
    assert.equal(pending.review.status, 'submitted', 'still waiting for review');
  });

  it('14. cross-course access is denied', async () => {
    expectProblem(await call('otherInstructor', 'GET', activityUrl(ids.courseA!, ids.lesson!)), 404, 'NOT_FOUND');
    expectProblem(await call('otherInstructor', 'GET', activityUrl(ids.courseB!, ids.lesson!)), 404, 'NOT_FOUND');
    expectProblem(await call('otherInstructor', 'GET', sectionActivitiesUrl(ids.courseA!, ids.introA!)), 404, 'NOT_FOUND');
    expectProblem(
      await call('otherInstructor', 'PUT', activityUrl(ids.courseB!, ids.draft!), { payload: { title: 'X', body: 'Y' } }),
      404,
      'NOT_FOUND',
    );
    // Even an administrator cannot address an activity through a different course.
    expectProblem(await call('admin', 'GET', activityUrl(ids.courseB!, ids.lesson!)), 404, 'NOT_FOUND');
    expectProblem(await call('admin', 'GET', sectionActivitiesUrl(ids.courseB!, ids.introA!)), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', sectionActivitiesUrl(ids.courseB!, ids.introB!)), 404, 'NOT_FOUND');
  });

  it('15. content in hidden sections stays inaccessible to students', async () => {
    const hidden = await create('instructor', ids.courseA!, ids.hiddenA!, { type: 'page', title: 'Answer key', body: 'Staff only.' });
    await submit('instructor', ids.courseA!, hidden.id);
    expectStatus(await review('reviewer', ids.courseA!, hidden.id, { decision: 'approve' }), 200);
    expectProblem(await call('student', 'GET', sectionActivitiesUrl(ids.courseA!, ids.hiddenA!)), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', activityUrl(ids.courseA!, hidden.id)), 404, 'NOT_FOUND');
    assert.deepEqual(await titlesFor('assistant', ids.courseA!, ids.hiddenA!), ['Answer key']);
  });

  it('16. content in draft courses stays inaccessible to students', async () => {
    const lesson = await create('instructor', ids.courseC!, ids.introC!, { type: 'page', title: 'Draft course lesson', body: 'Hidden.' });
    await submit('instructor', ids.courseC!, lesson.id);
    expectStatus(await review('admin', ids.courseC!, lesson.id, { decision: 'approve' }), 200);
    expectProblem(await call('student', 'GET', activityUrl(ids.courseC!, lesson.id)), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', sectionActivitiesUrl(ids.courseC!, ids.introC!)), 404, 'NOT_FOUND');
  });

  it('17. unsafe URLs are rejected', async () => {
    const countBefore = (await database.db.select({ n: count() }).from(activities))[0]?.n;
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://example.com/file',
      '/relative/path',
      'https://user:secret@example.com/',
      'https://exa mple.com/',
      'example.com',
    ]) {
      expectProblem(
        await call('instructor', 'POST', sectionActivitiesUrl(ids.courseA!, ids.unit2A!), { payload: { type: 'link', title: 'Bad', url } }),
        422,
        'INVALID_URL',
      );
    }
    expectProblem(
      await call('instructor', 'PUT', activityUrl(ids.courseA!, ids.link!), { payload: { title: 'Bad', url: 'javascript:alert(1)' } }),
      422,
      'INVALID_URL',
    );
    assert.equal((await database.db.select({ n: count() }).from(activities))[0]?.n, countBefore, 'nothing was stored');
  });

  it('18. lesson content is stored and returned as inert text', async () => {
    const payload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    const lesson = await create('instructor', ids.courseA!, ids.unit2A!, { type: 'page', title: '<b>Bold?</b>', body: payload });
    await submit('instructor', ids.courseA!, lesson.id);
    expectStatus(await review('reviewer', ids.courseA!, lesson.id, { decision: 'approve' }), 200);
    const res = await call('student', 'GET', activityUrl(ids.courseA!, lesson.id));
    assert.match(String(res.headers['content-type']), /^application\/json/);
    const read = expectStatus(res, 200);
    assert.equal(read.content.body, payload, 'returned verbatim as a JSON string');
    assert.equal(read.title, '<b>Bold?</b>');
    ids.xss = lesson.id;
  });

  it('19. editing approved content does not expose the unreviewed revision', async () => {
    const revised = expectStatus(
      await call('instructor', 'PUT', activityUrl(ids.courseA!, ids.lesson!), {
        payload: { title: 'What is ITIL 4?', body: 'Unreviewed revision.' },
      }),
      200,
    );
    assert.equal(revised.review.status, 'draft');
    assert.equal(revised.liveVersion.title, 'What is ITIL?', 'live version unchanged');
    const studentView = expectStatus(await call('student', 'GET', activityUrl(ids.courseA!, ids.lesson!)), 200);
    assert.equal(studentView.title, 'What is ITIL?');
    assert.equal(studentView.content.body, 'ITIL is a framework for IT service management.\nIt focuses on value.');
    assert.ok((await titlesFor('student', ids.courseA!, ids.introA!)).includes('What is ITIL?'));

    await submit('instructor', ids.courseA!, ids.lesson!);
    expectStatus(await review('reviewer', ids.courseA!, ids.lesson!, { decision: 'approve' }), 200);
    const published = expectStatus(await call('student', 'GET', activityUrl(ids.courseA!, ids.lesson!)), 200);
    assert.deepEqual([published.title, published.content.body], ['What is ITIL 4?', 'Unreviewed revision.']);
  });

  it('20. every content change and review transition is audited', async () => {
    const entries = await database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'activity'), eq(auditLog.entityId, ids.lesson!)))
      .orderBy(asc(auditLog.createdAt));
    assert.deepEqual(
      entries.map((e) => e.action),
      ['activity.created', 'activity.submitted', 'activity.approved', 'activity.updated', 'activity.submitted', 'activity.approved'],
    );
    const actors = entries.map((e) => e.actorUserId);
    const [instructorId, reviewerId] = [session('instructor').userId, session('reviewer').userId];
    assert.deepEqual(actors, [instructorId, instructorId, reviewerId, instructorId, instructorId, reviewerId]);
    const statuses = entries.map((e) => [
      (e.metadata.before as { reviewStatus?: string } | null)?.reviewStatus ?? null,
      (e.metadata.after as { reviewStatus: string }).reviewStatus,
    ]);
    assert.deepEqual(statuses, [
      [null, 'draft'],
      ['draft', 'submitted'],
      ['submitted', 'approved'],
      ['approved', 'draft'],
      ['draft', 'submitted'],
      ['submitted', 'approved'],
    ]);
    const update = entries[3]!;
    assert.equal((update.metadata.before as { title: string }).title, 'What is ITIL?');
    assert.equal((update.metadata.after as { title: string }).title, 'What is ITIL 4?');

    const [returned] = await database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'activity.returned'), eq(auditLog.entityId, ids.link!)));
    assert.equal((returned?.metadata.after as { comment: string }).comment, 'Please link the Spanish version.');
    assert.equal(returned?.actorUserId, reviewerId);

    const all = await database.db.select().from(auditLog).where(eq(auditLog.entityType, 'activity'));
    const secrets = [PASSWORD, ...[...sessions.values()].flatMap((s) => [s.token, s.csrfToken])];
    for (const entry of all) {
      assert.ok(entry.actorUserId && entry.createdAt instanceof Date && 'before' in entry.metadata && 'after' in entry.metadata);
      assert.ok(secrets.every((secret) => !JSON.stringify(entry.metadata).includes(secret)), 'no secrets in audit data');
    }
  });

  it('blocks self-approval by reviewers and requires matching content types', async () => {
    const own = await create('reviewer', ids.courseA!, ids.unit2A!, { type: 'page', title: 'Reviewer draft', body: 'Written by the reviewer.' });
    await submit('reviewer', ids.courseA!, own.id);
    expectProblem(await review('reviewer', ids.courseA!, own.id, { decision: 'approve' }), 403, 'SELF_REVIEW_NOT_ALLOWED');
    assert.equal(expectStatus(await review('admin', ids.courseA!, own.id, { decision: 'approve' }), 200).review.status, 'approved');

    expectProblem(
      await call('instructor', 'PUT', activityUrl(ids.courseA!, ids.draft!), { payload: { title: 'X', url: 'https://example.edu/' } }),
      422,
      'CONTENT_TYPE_MISMATCH',
    );
    expectProblem(
      await call('instructor', 'POST', sectionActivitiesUrl(ids.courseA!, ids.unit2A!), { payload: { type: 'page', title: '   ', body: 'x' } }),
      400,
      'VALIDATION_ERROR',
    );
    expectProblem(
      await call('instructor', 'POST', sectionActivitiesUrl(ids.courseA!, ids.unit2A!), { payload: { type: 'quiz', title: 'Q', body: 'x' } }),
      400,
      'VALIDATION_ERROR',
    );
    expectProblem(await call('instructor', 'POST', sectionActivitiesUrl(ids.courseA!, randomUUID()), { payload: { type: 'page', title: 'X', body: 'Y' } }), 404, 'NOT_FOUND');
  });

  it('requires authentication and CSRF on content endpoints', async () => {
    const endpoints: Array<['GET' | 'POST' | 'PUT', string]> = [
      ['GET', sectionActivitiesUrl(ids.courseA!, ids.introA!)],
      ['POST', sectionActivitiesUrl(ids.courseA!, ids.introA!)],
      ['GET', activityUrl(ids.courseA!, ids.lesson!)],
      ['PUT', activityUrl(ids.courseA!, ids.lesson!)],
      ['POST', `${activityUrl(ids.courseA!, ids.lesson!)}/submit`],
      ['POST', `${activityUrl(ids.courseA!, ids.lesson!)}/review`],
    ];
    for (const [method, url] of endpoints) {
      expectProblem(await call(null, method, url, { payload: method === 'GET' ? undefined : {} }), 401, 'UNAUTHENTICATED');
    }
    expectProblem(
      await call('instructor', 'POST', sectionActivitiesUrl(ids.courseA!, ids.introA!), { payload: { type: 'page', title: 'X', body: 'Y' }, csrf: null }),
      403,
      'CSRF_TOKEN_INVALID',
    );
    expectProblem(await call('reviewer', 'POST', `${activityUrl(ids.courseA!, ids.pending!)}/review`, { payload: { decision: 'approve' }, csrf: 'forged' }), 403, 'CSRF_TOKEN_INVALID');
    const pending = await database.db.select({ status: activities.reviewStatus }).from(activities).where(eq(activities.id, ids.pending!));
    assert.equal(pending[0]?.status, 'submitted', 'forged review had no effect');
  });
});
