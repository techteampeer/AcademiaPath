/**
 * Student groups and collaborative workspaces (AP-028), against temporary PostgreSQL databases (skipped unless
 * TEST_DATABASE_URL is set). Synthetic users; tests in a describe run in order.
 *
 * Course A (published, program P): instructor, assistant (non-editing instructor), reviewer (design team),
 * students s1, s2, s3. Course B (published): instructorB, outsider (student). Course D (draft): instructor, s1.
 * pm manages program P (program grant, no enrollment).
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { seedDemo } from '../../scripts/seed-demo.js';
import { DEMO_GROUPS } from '../../scripts/demo/groups.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { userCredentials, users } from '../../src/db/schema/index.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const EMAILS = {
  admin: DEV_USERS[0]!.email,
  instructor: DEV_USERS[1]!.email,
  s1: DEV_USERS[2]!.email,
  reviewer: DEV_USERS[3]!.email,
  assistant: 'assistant@academiapath.example',
  s2: 'student2@academiapath.example',
  s3: 'student3@academiapath.example',
  instructorB: 'instructor2@academiapath.example',
  outsider: 'outsider@academiapath.example',
  pm: 'program.manager@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type GroupSummary = { id: string; name: string; description: string | null; archived: boolean; isMember: boolean; memberCount: number; topicCount: number; unreadCount: number; course: { id: string } };
type GroupDetail = {
  group: GroupSummary;
  viewer: { role: string | null; isMember: boolean; canManage: boolean; canRead: boolean; canPost: boolean; canModerate: boolean };
  members: Array<{ id: string; name: string }>;
  recentTopics: Array<{ id: string; title: string; replyCount: number }>;
  membershipChanges: Array<{ kind: string; person: { id: string } | null; actor: { id: string } | null }>;
  candidates: Array<{ id: string }>;
};
type Topic = { id: string; title: string; body: string; group: { id: string; name: string; archived: boolean } | null; canReply: boolean; canEdit: boolean; canModerate: boolean; replyCount: number; pinned: boolean; locked: boolean; hidden: boolean };
type TopicPage = { viewer: { role: string | null; canPost: boolean; canModerate: boolean }; items: Topic[]; nextCursor: string | null };
type Post = { id: string; number: number; parentPostId: string | null; body: string; hidden: boolean; canEdit: boolean };
type PostPage = { items: Array<Post & { replies: Post[] }>; total: number };
type Notification = { id: string; type: string; data: Record<string, string>; link: string; read: boolean };

describe('student groups and group workspaces (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  const sessions = {} as Record<Person, { token: string; csrf: string; userId: string }>;
  const ids = {} as Record<string, string>;

  const requestOn = (target: ReturnType<typeof buildApp>, who: Person | null, method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const session = who ? sessions[who] : null;
    return target.inject({
      method,
      url: `/api/v1${url}`,
      cookies: session ? { ap_session: session.token } : {},
      headers: { origin: ORIGIN, ...(session && method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}), ...headers },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
  };
  const request = (who: Person | null, method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) => requestOn(app, who, method, url, body, headers);
  const ok = async <T = any>(who: Person, method: Method, url: string, body?: unknown, status = 200): Promise<T> => {
    const res = await request(who, method, url, body);
    assert.equal(res.statusCode, status, `${method} ${url} as ${who}: ${res.body}`);
    return (res.body ? res.json() : null) as T;
  };
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };
  const query = (sql: string, params: unknown[] = []) => database.pool.query(sql, params);
  const count = async (sql: string, params: unknown[] = []) => Number((await query(sql, params)).rows[0].n);
  const A = () => `/courses/${ids.courseA}`;
  const uid = (who: Person) => sessions[who].userId;
  const createGroup = (who: Person, name: string, courseId = ids.courseA!, description: string | null = null) => request(who, 'POST', `/courses/${courseId}/groups`, { name, description });
  const addMembers = (who: Person, groupId: string, people: Person[]) => request(who, 'POST', `/groups/${groupId}/members`, { userIds: people.map(uid) });
  const groupTopic = async (who: Person, groupId: string, title: string, body = `Texto de ${title}`) => {
    const res = await request(who, 'POST', `/groups/${groupId}/topics`, { title, body, clientRequestId: randomUUID() });
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as Topic;
  };
  const sendReply = (who: Person, topicId: string, body: string, parentPostId?: string) =>
    request(who, 'POST', `/forum/topics/${topicId}/posts`, { body, clientRequestId: randomUUID(), ...(parentPostId ? { parentPostId } : {}) });
  const reply = async (who: Person, topicId: string, body: string, parentPostId?: string) => {
    const res = await sendReply(who, topicId, body, parentPostId);
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as Post;
  };
  const myGroups = async (who: Person) => (await ok<{ items: GroupSummary[] }>(who, 'GET', '/me/groups')).items;
  const courseGroups = (who: Person, courseId = ids.courseA!) => ok<{ viewer: { canManage: boolean; canViewAll: boolean }; items: GroupSummary[] }>(who, 'GET', `/courses/${courseId}/groups`);
  const notesAbout = async (who: Person, topicId: string) => (await ok<{ items: Notification[] }>(who, 'GET', '/me/notifications?limit=50')).items.filter((n) => n.link.endsWith(`/forum/${topicId}`));
  const login = async (person: Person) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAILS[person], password: PASSWORD }, headers: { origin: ORIGIN } });
    assert.equal(res.statusCode, 200, res.body);
    sessions[person] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
  };
  const rolledBack = async (work: (client: pg.PoolClient) => Promise<void>) => {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await work(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };

  before(async () => {
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const passwordHash = await hashPassword(PASSWORD);
    for (const person of ['assistant', 's2', 's3', 'instructorB', 'outsider', 'pm'] as const) {
      const [user] = await database.db.insert(users).values({ email: EMAILS[person], givenName: 'Test', familyName: person }).returning();
      await database.db.insert(userCredentials).values({ userId: user!.id, passwordHash });
    }
    app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', FORUM_POST_RATE_LIMIT_MAX: '1000' }),
      database: database.db,
    });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) await login(person);
    const program = await ok('admin', 'POST', '/programs', { code: 'GRP', name: 'Grupos' }, 201);
    ids.program = program.id;
    const term = await ok('admin', 'POST', '/terms', { code: '2026-2', name: 'Semestre 2026-2', startsOn: '2026-08-17', endsOn: '2026-12-11' }, 201);
    const template = await ok('admin', 'POST', '/course-templates', { code: 'GRP-T', programId: program.id, title: 'Grupos', sections: [{ title: 'Unidad 1' }] }, 201);
    const course = async (code: string, status = 'published') => (await ok('admin', 'POST', '/courses', { programId: program.id, termId: term.id, templateId: template.templateId, code, status }, 201)).id as string;
    ids.courseA = await course('GRP-A');
    ids.courseB = await course('GRP-B');
    ids.courseD = await course('GRP-D', 'draft');
    const enroll = async (courseId: string, person: Person, role: string) => (await ok('admin', 'POST', `/courses/${courseId}/enrollments`, { email: EMAILS[person], role }, 201)).id as string;
    for (const [person, role] of [['instructor', 'instructor'], ['assistant', 'non_editing_instructor'], ['reviewer', 'design_team'], ['s1', 'student'], ['s2', 'student'], ['s3', 'student']] as const) {
      ids[`enroll_${person}`] = await enroll(ids.courseA, person, role);
    }
    for (const [person, role] of [['instructorB', 'instructor'], ['outsider', 'student']] as const) await enroll(ids.courseB, person, role);
    for (const [person, role] of [['instructor', 'instructor'], ['s1', 'student']] as const) await enroll(ids.courseD, person, role);
    await ok('admin', 'POST', `/programs/${ids.program}/managers`, { email: EMAILS.pm }, 201);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  it('1. instructors and administrators create groups; names are unique among a course’s active groups', async () => {
    const g1 = await ok<GroupDetail>('instructor', 'POST', `${A()}/groups`, { name: 'Grupo 1', description: 'Caso práctico 1' }, 201);
    assert.deepEqual([g1.group.name, g1.group.description, g1.group.archived, g1.group.memberCount, g1.group.course.id], ['Grupo 1', 'Caso práctico 1', false, 0, ids.courseA]);
    assert.deepEqual([g1.viewer.canManage, g1.viewer.canRead, g1.viewer.canModerate], [true, true, true]);
    assert.deepEqual(g1.candidates.map((c) => c.id).sort(), [uid('s1'), uid('s2'), uid('s3')].sort());
    ids.g1 = g1.group.id;
    ids.g2 = (await ok<GroupDetail>('instructor', 'POST', `${A()}/groups`, { name: 'Grupo 2' }, 201)).group.id;
    const byAdmin = await ok<GroupDetail>('admin', 'POST', `${A()}/groups`, { name: 'Grupo 3' }, 201);
    ids.g3 = byAdmin.group.id;
    assert.deepEqual([byAdmin.viewer.canManage, byAdmin.viewer.canRead, byAdmin.viewer.canPost], [true, false, false], 'administrators manage but never read group discussions');
    ids.gB = (await ok<GroupDetail>('instructorB', 'POST', `/courses/${ids.courseB}/groups`, { name: 'Grupo B' }, 201)).group.id;
    problem(await createGroup('instructor', '  grupo 1 '), 409, 'GROUP_NAME_TAKEN');
    problem(await createGroup('instructor', '   '), 400, 'VALIDATION_ERROR');
    problem(await request('instructor', 'POST', `${A()}/groups`, { name: 'x', description: 'y'.repeat(1001) }), 400, 'VALIDATION_ERROR');
    const renamed = await ok<GroupDetail>('instructor', 'PATCH', `/groups/${ids.g2}`, { name: 'Grupo Dos', description: 'Segundo grupo' });
    assert.equal(renamed.group.name, 'Grupo Dos');
    problem(await request('instructor', 'PATCH', `/groups/${ids.g2}`, { name: 'GRUPO 1' }), 409, 'GROUP_NAME_TAKEN');
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE action = 'group.created' AND entity_id = ANY($1)`, [[ids.g1, ids.g2, ids.g3]]), 3);
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE action = 'group.updated' AND entity_id = $1`, [ids.g2]), 1);
  });

  it('2. only active students of the group’s course can join (API and database)', async () => {
    assert.deepEqual(await ok('instructor', 'POST', `/groups/${ids.g1}/members`, { userIds: [uid('s1'), uid('s2')] }), { added: 2, alreadyMembers: 0 });
    assert.deepEqual(await ok('instructor', 'POST', `/groups/${ids.g2}/members`, { userIds: [uid('s3')] }), { added: 1, alreadyMembers: 0 });
    for (const people of [['assistant'], ['instructor'], ['outsider'], ['reviewer'], ['s1', 'outsider']] as Person[][]) {
      problem(await addMembers('instructor', ids.g1!, people), 422, 'MEMBER_NOT_ELIGIBLE');
    }
    problem(await request('instructor', 'POST', `/groups/${ids.g1}/members`, { userIds: [randomUUID()] }), 422, 'MEMBER_NOT_ELIGIBLE');
    await ok('admin', 'PUT', `${A()}/enrollments/${ids.enroll_s3}`, { status: 'inactive' });
    problem(await addMembers('instructor', ids.g3!, ['s3']), 422, 'MEMBER_NOT_ELIGIBLE');
    await ok('admin', 'PUT', `${A()}/enrollments/${ids.enroll_s3}`, { status: 'active' });
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE action = 'group.member_added' AND entity_id = $1`, [ids.g1]), 2);

    const insert = (c: pg.PoolClient, groupId: string, courseId: string, userId: string) =>
      c.query(`INSERT INTO student_group_members (group_id, course_id, user_id, added_by_user_id) VALUES ($1, $2, $3, $4)`, [groupId, courseId, userId, uid('instructor')]);
    await rolledBack(async (c) => {
      // The trigger refuses before the composite foreign key to the course's enrollments would.
      await assert.rejects(insert(c, ids.g3!, ids.courseA!, uid('outsider')), /only active students/);
    });
    await rolledBack(async (c) => {
      await assert.rejects(insert(c, ids.g3!, ids.courseB!, uid('outsider')), /student_group_members_group_fk/);
    });
    await rolledBack(async (c) => {
      await assert.rejects(insert(c, ids.g3!, ids.courseA!, uid('assistant')), /only active students/);
    });
    await rolledBack(async (c) => {
      await assert.rejects(insert(c, ids.g1!, ids.courseA!, uid('s1')), /student_group_members_open_unique/);
    });
    await rolledBack(async (c) => {
      await assert.rejects(c.query('DELETE FROM student_group_members WHERE group_id = $1', [ids.g1]), /never deleted/);
    });
    await rolledBack(async (c) => {
      await assert.rejects(c.query('DELETE FROM student_groups WHERE id = $1', [ids.g1]), /never deleted/);
    });
    await rolledBack(async (c) => {
      await assert.rejects(c.query('UPDATE student_groups SET course_id = $2 WHERE id = $1', [ids.g1, ids.courseB]), /keeps its course/);
    });
  });

  it('3. repeated membership requests are idempotent', async () => {
    assert.deepEqual(await ok('instructor', 'POST', `/groups/${ids.g1}/members`, { userIds: [uid('s1')] }), { added: 0, alreadyMembers: 1 });
    assert.deepEqual(await ok('admin', 'POST', `/groups/${ids.g1}/members`, { userIds: [uid('s1'), uid('s2')] }), { added: 0, alreadyMembers: 2 });
    problem(await request('instructor', 'POST', `/groups/${ids.g1}/members`, { userIds: [uid('s1'), uid('s1')] }), 400, 'VALIDATION_ERROR');
    assert.equal(await count(`SELECT count(*) AS n FROM student_group_members WHERE group_id = $1 AND removed_at IS NULL`, [ids.g1]), 2);
    assert.equal((await ok<GroupDetail>('instructor', 'GET', `/groups/${ids.g1}`)).group.memberCount, 2);
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE action = 'group.member_added' AND entity_id = $1`, [ids.g1]), 2, 'no-op additions are not audited');
  });

  it('4. cross-course memberships and references are denied', async () => {
    problem(await addMembers('instructorB', ids.gB!, ['s1']), 422, 'MEMBER_NOT_ELIGIBLE');
    problem(await addMembers('instructor', ids.gB!, ['outsider']), 404, 'NOT_FOUND');
    problem(await request('s1', 'POST', `/groups/${ids.gB}/topics`, { title: 'x', body: 'y', clientRequestId: randomUUID() }), 404, 'NOT_FOUND');
    await rolledBack(async (c) => {
      // A topic of course A in a group of course B.
      await assert.rejects(
        c.query(`INSERT INTO forum_topics (course_id, group_id, author_user_id, title, body, client_request_id) VALUES ($1, $2, $3, 'x', 'y', gen_random_uuid())`, [ids.courseA, ids.gB, uid('s1')]),
        /forum_topics_group_fk/,
      );
    });
  });

  it('5. students cannot manage groups or memberships', async () => {
    problem(await createGroup('s1', 'Mi grupo'), 403, 'FORBIDDEN');
    for (const [method, url, body] of [
      ['PATCH', `/groups/${ids.g1}`, { name: 'Cambio' }],
      ['POST', `/groups/${ids.g1}/members`, { userIds: [uid('s3')] }],
      ['DELETE', `/groups/${ids.g1}/members/${uid('s2')}`],
      ['POST', `/groups/${ids.g1}/archive`],
      ['POST', `/groups/${ids.g1}/restore`],
    ] as const) {
      problem(await request('s1', method, url, body), 403, 'FORBIDDEN');
      problem(await request('s3', method, url, body), 404, 'NOT_FOUND');
    }
    problem(await request('s1', 'GET', '/admin/groups'), 403, 'FORBIDDEN');
    const asMember = await ok<GroupDetail>('s1', 'GET', `/groups/${ids.g1}`);
    assert.deepEqual([asMember.viewer.isMember, asMember.viewer.canManage, asMember.viewer.canRead, asMember.viewer.canPost], [true, false, true, true]);
    assert.deepEqual([asMember.membershipChanges, asMember.candidates], [[], []], 'members see no management data');
  });

  it('6. instructors manage only their courses’ groups; non-editing instructors never manage', async () => {
    for (const [method, url, body] of [
      ['GET', `/groups/${ids.g1}`],
      ['PATCH', `/groups/${ids.g1}`, { name: 'Cambio' }],
      ['POST', `/groups/${ids.g1}/members`, { userIds: [uid('s3')] }],
      ['POST', `/groups/${ids.g1}/archive`],
    ] as const) {
      problem(await request('instructorB', method, url, body), 404, 'NOT_FOUND');
    }
    problem(await request('instructorB', 'GET', `${A()}/groups`), 404, 'NOT_FOUND');
    problem(await createGroup('instructorB', 'Intruso'), 404, 'NOT_FOUND');
    const nei = await courseGroups('assistant');
    assert.deepEqual([nei.viewer.canManage, nei.viewer.canViewAll], [false, true]);
    assert.equal(nei.items.length, 3);
    problem(await createGroup('assistant', 'Grupo NEI'), 403, 'FORBIDDEN');
    problem(await addMembers('assistant', ids.g1!, ['s3']), 403, 'FORBIDDEN');
    problem(await request('assistant', 'DELETE', `/groups/${ids.g1}/members/${uid('s1')}`), 403, 'FORBIDDEN');
    problem(await request('assistant', 'POST', `/groups/${ids.g1}/archive`), 403, 'FORBIDDEN');
    problem(await request('assistant', 'PATCH', `/groups/${ids.g1}`, { name: 'x' }), 403, 'FORBIDDEN');
    const detail = await ok<GroupDetail>('assistant', 'GET', `/groups/${ids.g1}`);
    assert.deepEqual([detail.viewer.canManage, detail.viewer.canRead, detail.viewer.canPost, detail.viewer.canModerate], [false, true, true, false]);
    assert.ok(detail.membershipChanges.some((c) => c.kind === 'member_added'));
    assert.deepEqual(detail.candidates, [], 'only managers get candidates');
  });

  it('7. students see only their own groups; the design team and program managers see none', async () => {
    assert.deepEqual((await courseGroups('s1')).items.map((g) => g.id), [ids.g1]);
    assert.deepEqual((await myGroups('s1')).map((g) => [g.id, g.isMember]), [[ids.g1, true]]);
    assert.deepEqual((await myGroups('s3')).map((g) => g.id), [ids.g2]);
    assert.deepEqual(await myGroups('instructor'), [], 'staff are not members');
    problem(await request('s1', 'GET', `/groups/${ids.g2}`), 404, 'NOT_FOUND');
    problem(await request('reviewer', 'GET', `${A()}/groups`), 403, 'GROUPS_NOT_AVAILABLE');
    problem(await request('reviewer', 'GET', `/groups/${ids.g1}`), 404, 'NOT_FOUND');
    problem(await request('pm', 'GET', `${A()}/groups`), 404, 'NOT_FOUND');
    problem(await request('pm', 'GET', `/groups/${ids.g1}`), 404, 'NOT_FOUND');
    problem(await request('outsider', 'GET', `/groups/${ids.g1}`), 404, 'NOT_FOUND');
    assert.equal((await courseGroups('admin')).items.length, 3);
    problem(await request('s1', 'GET', `/courses/${ids.courseD}/groups`), 404, 'NOT_FOUND');
    assert.equal((await courseGroups('instructor', ids.courseD)).viewer.canManage, true, 'instructors organize groups of a draft course');
  });

  it('8. group topics are private to the group’s members and the course’s teaching staff', async () => {
    const marker = `privado-${randomUUID()}`;
    const t1 = await groupTopic('s1', ids.g1!, `Plan del grupo ${marker}`, `Texto ${marker}`);
    assert.deepEqual(t1.group, { id: ids.g1, name: 'Grupo 1', archived: false });
    ids.t1 = t1.id;
    ids.t1marker = marker;
    assert.equal((await ok<Topic>('s2', 'GET', `/forum/topics/${t1.id}`)).body, `Texto ${marker}`);
    const r = await reply('assistant', t1.id, 'Respuesta del docente sin edición');
    ids.t1reply = r.id;
    assert.equal((await ok<PostPage>('instructor', 'GET', `/forum/topics/${t1.id}/posts`)).total, 1);
    for (const who of ['s3', 'outsider', 'reviewer', 'pm', 'instructorB', 'admin'] as const) {
      problem(await request(who, 'GET', `/forum/topics/${t1.id}`), 404, 'NOT_FOUND');
      problem(await request(who, 'GET', `/forum/topics/${t1.id}/posts`), 404, 'NOT_FOUND');
      problem(await sendReply(who, t1.id, 'x'), 404, 'NOT_FOUND');
    }
    problem(await request('admin', 'GET', `/groups/${ids.g1}/topics`), 403, 'GROUP_DISCUSSIONS_NOT_AVAILABLE');
    problem(await request('admin', 'POST', `/groups/${ids.g1}/topics`, { title: 'x', body: 'y', clientRequestId: randomUUID() }), 403, 'GROUP_DISCUSSIONS_NOT_AVAILABLE');
    const adminView = await ok<GroupDetail>('admin', 'GET', `/groups/${ids.g1}`);
    assert.deepEqual(adminView.recentTopics, []);
    assert.equal(adminView.group.topicCount, 1, 'administrators see counts only');
    assert.ok(!JSON.stringify(adminView).includes(marker));
    const memberView = await ok<GroupDetail>('s2', 'GET', `/groups/${ids.g1}`);
    assert.deepEqual(memberView.recentTopics.map((t) => [t.id, t.replyCount]), [[t1.id, 1]]);
    for (const who of ['s1', 'instructor', 'admin', 's3'] as const) {
      const forum = await ok<TopicPage>(who, 'GET', `${A()}/forum/topics?limit=50`);
      assert.ok(!forum.items.some((t) => t.id === t1.id), `${who}: never in the course-wide forum`);
    }
    assert.deepEqual((await ok<TopicPage>('s2', 'GET', `/groups/${ids.g1}/topics`)).items.map((t) => t.id), [t1.id]);
  });

  it('9. direct URLs and forged ids do not bypass group authorization', async () => {
    for (const [method, url, body] of [
      ['GET', `/groups/${ids.g1}/topics`],
      ['POST', `/groups/${ids.g1}/topics`, { title: 'x', body: 'y', clientRequestId: randomUUID() }],
      ['PATCH', `/forum/topics/${ids.t1}`, { title: 'x' }],
      ['POST', `/forum/topics/${ids.t1}/moderation`, { action: 'lock' }],
      ['PUT', `/forum/topics/${ids.t1}/read`],
      ['PATCH', `/forum/posts/${ids.t1reply}`, { body: 'x' }],
      ['POST', `/forum/posts/${ids.t1reply}/moderation`, { action: 'hide' }],
      ['GET', `/groups/${randomUUID()}`],
      ['GET', `/groups/${randomUUID()}/topics`],
    ] as const) {
      problem(await request('s3', method, url, body), 404, 'NOT_FOUND');
    }
    // A retry key of a group topic cannot surface it through the course-wide route, and vice versa.
    const clientRequestId = (await query('SELECT client_request_id FROM forum_topics WHERE id = $1', [ids.t1])).rows[0].client_request_id;
    problem(await request('s1', 'POST', `${A()}/forum/topics`, { title: 'x', body: 'y', clientRequestId }), 409, 'IDEMPOTENCY_KEY_REUSED');
    const courseKey = randomUUID();
    await ok('s1', 'POST', `${A()}/forum/topics`, { title: 'Tema del curso', body: 'z', clientRequestId: courseKey }, 201);
    problem(await request('s1', 'POST', `/groups/${ids.g1}/topics`, { title: 'x', body: 'y', clientRequestId: courseKey }), 409, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal((await ok<Topic>('s1', 'POST', `/groups/${ids.g1}/topics`, { title: 'otro', body: 'otro', clientRequestId })).id, ids.t1, 'a retry in the same group returns the topic');
  });

  it('10. removed members lose access immediately; membership history is kept', async () => {
    assert.equal((await notesAbout('s2', ids.t1!)).length, 1, 'the new topic notified the other member');
    assert.deepEqual(await ok('instructor', 'DELETE', `/groups/${ids.g1}/members/${uid('s2')}`), { removed: true });
    problem(await request('s2', 'GET', `/forum/topics/${ids.t1}`), 404, 'NOT_FOUND');
    problem(await request('s2', 'GET', `/groups/${ids.g1}`), 404, 'NOT_FOUND');
    problem(await request('s2', 'GET', `/groups/${ids.g1}/topics`), 404, 'NOT_FOUND');
    problem(await sendReply('s2', ids.t1!, 'Ya no soy miembro'), 404, 'NOT_FOUND');
    assert.deepEqual(await myGroups('s2'), []);
    assert.equal((await notesAbout('s2', ids.t1!)).length, 0, 'their notification about the group is no longer shown');
    const summary = await ok<{ unreadNotifications: number }>('s2', 'GET', '/me/messaging/summary');
    assert.equal(summary.unreadNotifications, (await ok<{ items: Notification[] }>('s2', 'GET', '/me/notifications?limit=50')).items.filter((n) => !n.read).length);
    assert.deepEqual(await ok('instructor', 'DELETE', `/groups/${ids.g1}/members/${uid('s2')}`), { removed: false }, 'idempotent');
    assert.deepEqual(await ok('instructor', 'POST', `/groups/${ids.g1}/members`, { userIds: [uid('s2')] }), { added: 1, alreadyMembers: 0 });
    assert.equal(await count(`SELECT count(*) AS n FROM student_group_members WHERE group_id = $1 AND user_id = $2`, [ids.g1, uid('s2')]), 2, 'a new membership; the old one is kept');
    const changes = (await ok<GroupDetail>('instructor', 'GET', `/groups/${ids.g1}`)).membershipChanges;
    assert.equal(changes.filter((c) => c.person?.id === uid('s2')).map((c) => c.kind).join(','), 'member_added,member_removed,member_added');
    assert.ok(changes.some((c) => c.kind === 'group_created' && c.actor?.id === uid('instructor')));
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE action = 'group.member_removed' AND entity_id = $1`, [ids.g1]), 1);
    assert.equal((await ok<Topic>('s2', 'GET', `/forum/topics/${ids.t1}`)).id, ids.t1, 'access returns with a new membership');
  });

  it('11. a revoked enrollment or a deactivated account loses group access; memberships count as history', async () => {
    await ok('admin', 'PUT', `${A()}/enrollments/${ids.enroll_s1}`, { status: 'inactive' });
    problem(await request('s1', 'GET', `/forum/topics/${ids.t1}`), 404, 'NOT_FOUND');
    problem(await request('s1', 'GET', `/groups/${ids.g1}`), 404, 'NOT_FOUND');
    assert.deepEqual(await myGroups('s1'), []);
    assert.equal((await ok<GroupDetail>('instructor', 'GET', `/groups/${ids.g1}`)).group.memberCount, 1, 'only current members count');
    await ok('admin', 'PUT', `${A()}/enrollments/${ids.enroll_s1}`, { status: 'active' });
    assert.deepEqual((await myGroups('s1')).map((g) => g.id), [ids.g1]);

    await ok('admin', 'POST', `/users/${uid('s2')}/deactivate`);
    assert.equal((await request('s2', 'GET', '/me/groups')).statusCode, 401);
    assert.ok(!(await ok<GroupDetail>('instructor', 'GET', `/groups/${ids.g1}`)).members.some((m) => m.id === uid('s2')));
    await ok('admin', 'POST', `/users/${uid('s2')}/reactivate`);
    await login('s2');

    problem(await request('admin', 'DELETE', `${A()}/enrollments/${ids.enroll_s3}`), 409, 'ENROLLMENT_HAS_HISTORY');
  });

  it('12. archived groups are read-only history; restoring needs a free name', async () => {
    const own = await reply('s2', ids.t1!, 'Mi aporte antes del archivo');
    const archived = await ok<GroupDetail>('instructor', 'POST', `/groups/${ids.g1}/archive`);
    assert.deepEqual([archived.group.archived, archived.viewer.canPost], [true, false]);
    assert.deepEqual((await ok<GroupDetail>('instructor', 'POST', `/groups/${ids.g1}/archive`)).group.archived, true, 'idempotent');
    const asMember = await ok<Topic>('s1', 'GET', `/forum/topics/${ids.t1}`);
    assert.deepEqual([asMember.group?.archived, asMember.canReply, asMember.canEdit], [true, false, false]);
    assert.equal((await ok<GroupDetail>('s1', 'GET', `/groups/${ids.g1}`)).group.archived, true, 'members still read the history');
    problem(await request('s1', 'POST', `/groups/${ids.g1}/topics`, { title: 'x', body: 'y', clientRequestId: randomUUID() }), 409, 'GROUP_ARCHIVED');
    problem(await sendReply('s1', ids.t1!, 'Tarde'), 409, 'GROUP_ARCHIVED');
    problem(await sendReply('instructor', ids.t1!, 'Tarde'), 409, 'GROUP_ARCHIVED');
    problem(await request('s2', 'PATCH', `/forum/posts/${own.id}`, { body: 'Corrección' }), 409, 'GROUP_ARCHIVED');
    problem(await addMembers('instructor', ids.g1!, ['s3']), 409, 'GROUP_ARCHIVED');
    problem(await request('instructor', 'DELETE', `/groups/${ids.g1}/members/${uid('s1')}`), 409, 'GROUP_ARCHIVED');
    problem(await request('instructor', 'PATCH', `/groups/${ids.g1}`, { name: 'Nuevo' }), 409, 'GROUP_ARCHIVED');
    assert.equal((await ok<Topic>('instructor', 'POST', `/forum/topics/${ids.t1}/moderation`, { action: 'pin' })).pinned, true, 'moderation still works');
    await ok('instructor', 'POST', `/forum/topics/${ids.t1}/moderation`, { action: 'unpin' });
    await rolledBack(async (c) => {
      await assert.rejects(c.query(`INSERT INTO student_group_members (group_id, course_id, user_id, added_by_user_id) VALUES ($1, $2, $3, $4)`, [ids.g1, ids.courseA, uid('s3'), uid('instructor')]), /archived group takes no new members/);
    });
    const sameName = await ok<GroupDetail>('instructor', 'POST', `${A()}/groups`, { name: 'Grupo 1' }, 201);
    problem(await request('instructor', 'POST', `/groups/${ids.g1}/restore`), 409, 'GROUP_NAME_TAKEN');
    await ok('instructor', 'PATCH', `/groups/${sameName.group.id}`, { name: 'Grupo 1 (nuevo)' });
    const restored = await ok<GroupDetail>('instructor', 'POST', `/groups/${ids.g1}/restore`);
    assert.deepEqual([restored.group.archived, restored.viewer.canPost], [false, true]);
    assert.equal((await reply('s1', ids.t1!, 'De vuelta')).number, 3);
    for (const action of ['group.archived', 'group.restored']) assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE action = $1 AND entity_id = $2`, [action, ids.g1]), 1, action);
  });

  it('13. group replies keep the forum’s integrity, ordering and editing rules', async () => {
    const t = await groupTopic('s1', ids.g1!, 'Tema concurrente del grupo');
    const posters: Person[] = ['s1', 's2', 'assistant', 'instructor'];
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => sendReply(posters[i % 4]!, t.id, `Concurrente ${i}`)));
    for (const res of results) assert.equal(res.statusCode, 201, res.body);
    const { rows } = await query('SELECT post_number FROM forum_posts WHERE topic_id = $1 ORDER BY post_number', [t.id]);
    assert.deepEqual(rows.map((r) => r.post_number), Array.from({ length: 12 }, (_, i) => i + 1));
    const first = (results[0]!.json() as Post).id;
    const nested = await reply('s2', t.id, 'Respuesta anidada', first);
    assert.equal(nested.parentPostId, first);
    problem(await sendReply('s1', t.id, 'Demasiado profunda', nested.id), 422, 'REPLY_NESTING_LIMIT');
    assert.equal((await ok<Post>('s2', 'PATCH', `/forum/posts/${nested.id}`, { body: 'Respuesta anidada corregida' })).body, 'Respuesta anidada corregida');
    problem(await request('s1', 'PATCH', `/forum/posts/${nested.id}`, { body: 'Ajena' }), 403, 'FORBIDDEN');
    const page = await ok<PostPage>('s1', 'GET', `/forum/topics/${t.id}/posts?limit=50`);
    assert.equal(page.total, 13);
    const top = page.items.map((p) => p.number);
    assert.deepEqual(top, [...top].sort((a, b) => a - b));
  });

  it('14. course-wide forum topics behave as before', async () => {
    const course = await ok<Topic>('s1', 'POST', `${A()}/forum/topics`, { title: 'Tema de todo el curso', body: 'Para todos', clientRequestId: randomUUID() }, 201);
    assert.equal(course.group, null);
    for (const who of ['s3', 'assistant', 'instructor', 'admin'] as const) assert.equal((await ok<Topic>(who, 'GET', `/forum/topics/${course.id}`)).group, null);
    await reply('s3', course.id, 'Respuesta de otro grupo');
    assert.equal((await notesAbout('s1', course.id)).length, 1);
    assert.equal((await ok<Topic>('admin', 'POST', `/forum/topics/${course.id}/moderation`, { action: 'lock' })).locked, true, 'administrators still moderate course-wide topics');
    await ok('admin', 'POST', `/forum/topics/${course.id}/moderation`, { action: 'unlock' });
    const listed = await ok<TopicPage>('s3', 'GET', `${A()}/forum/topics?limit=50`);
    assert.ok(listed.items.some((t) => t.id === course.id) && listed.items.every((t) => t.group === null));
  });

  it('15. group notifications reach only the group’s authorized members', async () => {
    const t = await groupTopic('s1', ids.g1!, 'Aviso al grupo');
    const recipients = async () => (await query(`SELECT u.email FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.dedupe_key = $1`, [`forum:${t.id}`])).rows.map((r) => r.email as string).sort();
    assert.deepEqual(await recipients(), [EMAILS.s2]);
    const [note] = await notesAbout('s2', t.id);
    assert.deepEqual([note!.type, note!.data.groupName, note!.link], ['forum_topic', 'Grupo 1', `/courses/${ids.courseA}/forum/${t.id}`]);
    await reply('s2', t.id, 'Respuesta de un miembro');
    assert.deepEqual(await recipients(), [EMAILS.s1, EMAILS.s2].sort());
    // A removed member hears nothing more about the group.
    await ok('instructor', 'DELETE', `/groups/${ids.g1}/members/${uid('s1')}`);
    const before = (await query(`SELECT event_at FROM notifications n WHERE n.user_id = $1 AND n.dedupe_key = $2`, [uid('s1'), `forum:${t.id}`])).rows[0].event_at;
    await reply('instructor', t.id, 'Respuesta del docente');
    const afterRow = (await query(`SELECT event_at FROM notifications n WHERE n.user_id = $1 AND n.dedupe_key = $2`, [uid('s1'), `forum:${t.id}`])).rows[0].event_at;
    assert.deepEqual(afterRow, before);
    assert.equal((await notesAbout('s1', t.id)).length, 0);
    await ok('instructor', 'POST', `/groups/${ids.g1}/members`, { userIds: [uid('s1')] });
    for (const who of ['s3', 'outsider', 'admin', 'reviewer', 'pm', 'assistant'] as const) assert.equal((await notesAbout(who, t.id)).length, 0, who);
  });

  it('16. unread counts never expose another group’s activity', async () => {
    await ok('s1', 'POST', '/me/notifications/read-all');
    const before = (await myGroups('s1')).map((g) => [g.id, g.unreadCount]);
    const beforeSummary = (await ok<{ unreadNotifications: number }>('s1', 'GET', '/me/messaging/summary')).unreadNotifications;
    const t2 = await groupTopic('s3', ids.g2!, 'Actividad del grupo 2');
    await reply('instructor', t2.id, 'Respuesta en el grupo 2');
    assert.deepEqual((await myGroups('s1')).map((g) => [g.id, g.unreadCount]), before);
    assert.equal((await ok<{ unreadNotifications: number }>('s1', 'GET', '/me/messaging/summary')).unreadNotifications, beforeSummary);
    assert.equal((await courseGroups('s1')).items.find((g) => g.id === ids.g2), undefined);
    const g2 = (await myGroups('s3')).find((g) => g.id === ids.g2)!;
    assert.equal(g2.unreadCount, 1);
    await ok('s3', 'PUT', `/forum/topics/${t2.id}/read`, undefined, 204);
    assert.equal((await myGroups('s3')).find((g) => g.id === ids.g2)!.unreadCount, 0, 'opening the topic clears it');
    const staff = await courseGroups('instructor');
    assert.ok(staff.items.every((g) => g.unreadCount >= 0));
  });

  it('17. moderation in group workspaces: instructors only', async () => {
    const t = await groupTopic('s1', ids.g1!, `Tema a moderar ${randomUUID()}`);
    const r = await reply('s2', t.id, 'Respuesta a ocultar');
    for (const who of ['assistant', 's1', 's2'] as const) {
      problem(await request(who, 'POST', `/forum/topics/${t.id}/moderation`, { action: 'lock' }), 403, 'FORBIDDEN');
      problem(await request(who, 'POST', `/forum/posts/${r.id}/moderation`, { action: 'hide' }), 403, 'FORBIDDEN');
    }
    problem(await request('admin', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'lock' }), 404, 'NOT_FOUND');
    assert.equal((await ok<Topic>('instructor', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'lock' })).locked, true);
    problem(await sendReply('s1', t.id, 'Cerrado'), 409, 'TOPIC_LOCKED');
    await ok('instructor', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'unlock' });
    await ok('instructor', 'POST', `/forum/posts/${r.id}/moderation`, { action: 'hide' });
    assert.equal((await ok<PostPage>('s1', 'GET', `/forum/topics/${t.id}/posts`)).total, 0);
    await ok('instructor', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'hide' });
    problem(await request('s1', 'GET', `/forum/topics/${t.id}`), 404, 'NOT_FOUND');
    assert.ok(!(await ok<TopicPage>('s1', 'GET', `/groups/${ids.g1}/topics?limit=50`)).items.some((x) => x.id === t.id));
    assert.ok((await ok<TopicPage>('instructor', 'GET', `/groups/${ids.g1}/topics?limit=50`)).items.some((x) => x.id === t.id && x.hidden));
    const audit = (await query(`SELECT metadata FROM audit_log WHERE action = 'forum.topic.hidden' AND entity_id = $1`, [t.id])).rows[0].metadata;
    assert.equal(audit.after.groupId, ids.g1);
    assert.ok(!JSON.stringify(audit).includes('Tema a moderar'));
    await ok('instructor', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'restore' });
  });

  it('18. private group content never appears in unauthorized search, lists or counts', async () => {
    const marker = ids.t1marker!;
    const overviewBefore = await ok<{ items: Array<{ course: { id: string }; topicCount: number; replyCount: number }> }>('admin', 'GET', '/admin/forums/courses');
    for (const who of ['s1', 's3', 'instructor', 'assistant', 'admin'] as const) {
      assert.deepEqual((await ok<TopicPage>(who, 'GET', `${A()}/forum/topics?q=${marker}`)).items, [], `${who}: course-wide search`);
    }
    assert.equal((await ok<TopicPage>('s1', 'GET', `/groups/${ids.g1}/topics?q=${marker}`)).items.length, 1, 'members find it in their group');
    problem(await request('s3', 'GET', `/groups/${ids.g1}/topics?q=${marker}`), 404, 'NOT_FOUND');
    await groupTopic('s1', ids.g1!, 'Otro tema privado');
    const overviewAfter = await ok<{ items: Array<{ course: { id: string }; topicCount: number; replyCount: number }> }>('admin', 'GET', '/admin/forums/courses');
    assert.deepEqual(overviewAfter.items.find((i) => i.course.id === ids.courseA), overviewBefore.items.find((i) => i.course.id === ids.courseA), 'group discussions are not counted in the course forum overview');
    const adminGroups = await ok('admin', 'GET', '/admin/groups');
    const rowA = adminGroups.items.find((i: { course: { id: string } }) => i.course.id === ids.courseA);
    assert.deepEqual([rowA.activeGroups, rowA.archivedGroups, rowA.memberships, rowA.studentsWithoutGroup], [4, 0, 3, 0]);
    for (const who of ['s3', 'admin', 'outsider'] as const) {
      for (const url of ['/me/groups', '/me/notifications?limit=50', `${A()}/forum/topics?limit=50`]) {
        const res = await request(who, 'GET', url);
        assert.ok(!res.body.includes(marker), `${who} ${url}`);
      }
    }
    assert.ok(!(await request('admin', 'GET', `${A()}/groups`)).body.includes(marker));
    assert.ok(!(await request('assistant', 'GET', `${A()}/groups`)).body.includes(marker));
  });

  it('19. concurrent membership changes keep membership integrity', async () => {
    const group = (await ok<GroupDetail>('instructor', 'POST', `${A()}/groups`, { name: 'Grupo concurrente' }, 201)).group.id;
    const adds = await Promise.all(Array.from({ length: 10 }, () => addMembers('instructor', group, ['s3'])));
    for (const res of adds) assert.equal(res.statusCode, 200, res.body);
    assert.equal(adds.reduce((sum, res) => sum + res.json().added, 0), 1);
    const mixed = await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? addMembers(i % 4 === 1 ? 'admin' : 'instructor', group, ['s3', 's2']) : request('instructor', 'DELETE', `/groups/${group}/members/${uid('s3')}`))),
    );
    for (const res of mixed) assert.equal(res.statusCode, 200, res.body);
    const rows = (await query(`SELECT user_id, added_at, removed_at FROM student_group_members WHERE group_id = $1 ORDER BY added_at`, [group])).rows;
    for (const person of ['s2', 's3'] as const) {
      const mine = rows.filter((r) => r.user_id === uid(person));
      assert.ok(mine.filter((r) => r.removed_at === null).length <= 1, `${person}: at most one open membership`);
      for (let i = 1; i < mine.length; i++) assert.ok(mine[i - 1]!.removed_at && mine[i - 1]!.removed_at <= mine[i]!.added_at, 'memberships never overlap');
    }
    const removed = mixed.filter((_, i) => i % 2 === 0).filter((res) => res.json().removed).length;
    const s3Rows = rows.filter((r) => r.user_id === uid('s3'));
    assert.equal(s3Rows.filter((r) => r.removed_at !== null).length, removed, 'every successful removal closed exactly one membership');
    assert.equal(s3Rows.length, removed + s3Rows.filter((r) => r.removed_at === null).length);
  });

  it('20. CSRF, Origin, rate limits, audit and logs', async () => {
    const writes = [
      ['POST', `${A()}/groups`, { name: 'x' }],
      ['PATCH', `/groups/${ids.g1}`, { name: 'x' }],
      ['POST', `/groups/${ids.g1}/members`, { userIds: [uid('s3')] }],
      ['DELETE', `/groups/${ids.g1}/members/${uid('s1')}`],
      ['POST', `/groups/${ids.g1}/archive`],
      ['POST', `/groups/${ids.g1}/restore`],
      ['POST', `/groups/${ids.g1}/topics`, { title: 'x', body: 'y', clientRequestId: randomUUID() }],
      ['PUT', `/forum/topics/${ids.t1}/read`],
    ] as const;
    for (const [method, url, body] of writes) {
      const noCsrf = await app.inject({ method, url: `/api/v1${url}`, cookies: { ap_session: sessions.instructor.token }, headers: { origin: ORIGIN }, ...(body ? { payload: body } : {}) });
      problem(noCsrf, 403, 'CSRF_TOKEN_INVALID');
      problem(await request('instructor', method, url, body, { origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
      assert.equal((await request(null, method, url, body)).statusCode, 401);
    }
    assert.deepEqual((await ok<GroupDetail>('instructor', 'GET', `/groups/${ids.g1}`)).group.archived, false);

    const limited = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, FORUM_POST_RATE_LIMIT_MAX: '1' }), database: database.db });
    await limited.ready();
    try {
      const res = await requestOn(limited, 's3', 'POST', `/groups/${ids.g2}/topics`, { title: 'x', body: 'y', clientRequestId: randomUUID() });
      problem(res, 429, 'RATE_LIMITED');
      assert.ok(Number(res.headers['retry-after']) >= 1);
    } finally {
      await limited.close();
    }

    const lines: string[] = [];
    const logged = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, FORUM_POST_RATE_LIMIT_MAX: '1000' }), database: database.db, logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } } });
    await logged.ready();
    const secret = `texto-de-grupo-${randomUUID()}`;
    const created = await requestOn(logged, 's1', 'POST', `/groups/${ids.g1}/topics`, { title: `Título ${secret}`, body: `Texto ${secret}`, clientRequestId: randomUUID() });
    assert.equal(created.statusCode, 201);
    assert.equal((await requestOn(logged, 's2', 'POST', `/forum/topics/${created.json().id}/posts`, { body: `Respuesta ${secret}`, clientRequestId: randomUUID() })).statusCode, 201);
    assert.equal((await requestOn(logged, 'instructor', 'POST', `/forum/topics/${created.json().id}/moderation`, { action: 'hide' })).statusCode, 200);
    await logged.close();
    assert.ok(lines.length > 0 && !lines.join('\n').includes(secret));
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE metadata::text LIKE $1`, [`%${secret}%`]), 0);
    const actions = (await query(`SELECT DISTINCT action FROM audit_log WHERE action LIKE 'group.%' ORDER BY action`)).rows.map((r) => r.action);
    assert.deepEqual(actions, ['group.archived', 'group.created', 'group.member_added', 'group.member_removed', 'group.restored', 'group.updated']);
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE action LIKE 'group.%' AND actor_user_id IS NULL`), 0);
  });
});

describe('demo student groups (demo dataset, PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let root: string;
  const env = () => ({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: join(root, 'documents') });
  const call = async (email: string, method: Method, url: string) => {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD }, headers: { origin: ORIGIN } });
    const res = await app.inject({ method, url: `/api/v1${url}`, cookies: { ap_session: login.cookies.find((c) => c.name === 'ap_session')!.value }, headers: { origin: ORIGIN } });
    return { status: res.statusCode, json: res.body ? res.json() : null };
  };

  before(async () => {
    database = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'ap028-'));
    await seedDemo(database.db, { password: PASSWORD, env: env(), uploadFilesDir: null });
    app = buildApp({ config: { ...loadConfig(env()), loginRateLimit: { max: 1000, windowMs: 60_000 } }, database: database.db });
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('23. seeds two ITIL 4 Foundation groups with private discussions, idempotently', async () => {
    const { rows: [course] } = await database.pool.query(`SELECT id FROM courses WHERE code = $1`, [DEMO_GROUPS.courseCode]);
    const staff = (await call('instructor@academiapath.example', 'GET', `/courses/${course.id}/groups`)).json.items as GroupSummary[];
    assert.deepEqual(staff.map((g) => [g.name, g.memberCount, g.topicCount]).sort(), [['Equipo Alfa', 2, 1], ['Equipo Beta', 1, 1]]);
    const alfa = staff.find((g) => g.name === 'Equipo Alfa')!;
    const beta = staff.find((g) => g.name === 'Equipo Beta')!;
    assert.deepEqual(((await call('student@academiapath.example', 'GET', '/me/groups')).json.items as GroupSummary[]).map((g) => g.name), ['Equipo Alfa']);
    assert.deepEqual(((await call('learner.b@academiapath.example', 'GET', '/me/groups')).json.items as GroupSummary[]).map((g) => g.name), ['Equipo Beta']);
    const alfaTopics = (await call('student@academiapath.example', 'GET', `/groups/${alfa.id}/topics`)).json.items as Topic[];
    assert.equal(alfaTopics.length, 1);
    const posts = (await call('student@academiapath.example', 'GET', `/forum/topics/${alfaTopics[0]!.id}/posts`)).json as PostPage;
    assert.equal(posts.total, 2, 'a student reply and an instructor reply');
    const betaTopic = ((await call('instructor@academiapath.example', 'GET', `/groups/${beta.id}/topics`)).json.items as Topic[])[0]!;
    assert.equal((await call('student@academiapath.example', 'GET', `/forum/topics/${betaTopic.id}`)).status, 404, 'another group cannot see it');
    assert.equal((await call('student@academiapath.example', 'GET', `/groups/${beta.id}`)).status, 404);
    assert.equal((await call('reviewer@academiapath.example', 'GET', `/courses/${course.id}/groups`)).status, 403);
    assert.equal((await call('admin@academiapath.example', 'GET', `/groups/${alfa.id}/topics`)).status, 403);

    const snapshot = async () => (await database.pool.query(`SELECT (SELECT count(*) FROM student_groups) AS g, (SELECT count(*) FROM student_group_members) AS m, (SELECT count(*) FROM forum_topics) AS t, (SELECT count(*) FROM forum_posts) AS p, (SELECT count(*) FROM notifications) AS n, (SELECT count(*) FROM audit_log WHERE action LIKE 'group.%') AS a`)).rows[0];
    const before = await snapshot();
    const again = await seedDemo(database.db, { password: PASSWORD, env: env(), uploadFilesDir: null });
    for (const kind of ['student groups', 'group memberships', 'group topics', 'group replies']) assert.equal(again.counts[kind]?.created, 0, kind);
    assert.deepEqual(await snapshot(), before);
  });
});
