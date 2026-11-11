/**
 * Course discussion forums (AP-027), against temporary PostgreSQL databases (skipped unless TEST_DATABASE_URL
 * is set). Synthetic users; tests in a describe run in order.
 *
 * Course A (published, program P): instructor, assistant (non-editing instructor), reviewer (design team),
 * students s1, s2. Course B (published): instructorB, outsider (student). Course D (draft): instructor, s1.
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
import { DEMO_FORUMS } from '../../scripts/demo/forums.js';
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
  instructorB: 'instructor2@academiapath.example',
  outsider: 'outsider@academiapath.example',
  pm: 'program.manager@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
type PersonRef = { id: string; name: string; role: string | null };
type TopicSummary = { id: string; title: string; excerpt: string; author: PersonRef; mine: boolean; pinned: boolean; locked: boolean; hidden: boolean; replyCount: number; lastReply: { authorName: string; createdAt: string } | null; lastActivityAt: string; editedAt: string | null };
type Topic = TopicSummary & { body: string; course: { id: string }; canReply: boolean; canEdit: boolean; canModerate: boolean; editableUntil: string | null };
type TopicPage = { course: { id: string }; viewer: { role: string | null; canPost: boolean; canModerate: boolean }; items: TopicSummary[]; nextCursor: string | null };
type Post = { id: string; number: number; parentPostId: string | null; author: PersonRef; body: string; hidden: boolean; mine: boolean; canEdit: boolean; editableUntil: string | null; createdAt: string; editedAt: string | null };
type ThreadItem = Post & { replies: Post[] };
type PostPage = { items: ThreadItem[]; nextCursor: number | null; total: number };
type Notification = { id: string; type: string; data: Record<string, string>; link: string; read: boolean; course: { id: string } | null };

describe('course discussion forums (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let pinned: Date | null = null;
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
  const createTopic = (who: Person, title: string, body: string, extra: Record<string, unknown> = {}, courseId = ids.courseA!) =>
    request(who, 'POST', `/courses/${courseId}/forum/topics`, { title, body, clientRequestId: randomUUID(), ...extra });
  const topic = async (who: Person, title: string, body = `Texto de ${title}`, extra: Record<string, unknown> = {}, courseId = ids.courseA!) => {
    const res = await createTopic(who, title, body, extra, courseId);
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as Topic;
  };
  const sendReply = (who: Person, topicId: string, body: string, parentPostId?: string, clientRequestId: string = randomUUID()) =>
    request(who, 'POST', `/forum/topics/${topicId}/posts`, { body, clientRequestId, ...(parentPostId ? { parentPostId } : {}) });
  const reply = async (who: Person, topicId: string, body: string, parentPostId?: string) => {
    const res = await sendReply(who, topicId, body, parentPostId);
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as Post;
  };
  const thread = (who: Person, topicId: string, q = '') => ok<PostPage>(who, 'GET', `/forum/topics/${topicId}/posts?limit=50${q}`);
  const flat = (page: PostPage) => page.items.flatMap((p) => [p, ...p.replies]);
  const list = (who: Person, q = '', courseId = ids.courseA!) => ok<TopicPage>(who, 'GET', `/courses/${courseId}/forum/topics?limit=50${q}`);
  const moderate = (who: Person, topicId: string, action: string) => request(who, 'POST', `/forum/topics/${topicId}/moderation`, { action });
  const moderatePost = (who: Person, postId: string, action: string) => request(who, 'POST', `/forum/posts/${postId}/moderation`, { action });
  const notificationsOf = async (who: Person) => (await ok<{ items: Notification[] }>(who, 'GET', '/me/notifications?limit=50')).items;
  const forumNotes = async (who: Person, topicId: string) => (await notificationsOf(who)).filter((n) => n.link.endsWith(`/forum/${topicId}`));
  const noteRow = async (who: Person, topicId: string) =>
    (await query(`SELECT event_at, read_at, withdrawn_at, data FROM notifications WHERE user_id = $1 AND dedupe_key = $2`, [sessions[who].userId, `forum:${topicId}`])).rows[0] as
      | { event_at: Date; read_at: Date | null; withdrawn_at: Date | null; data: Record<string, string> }
      | undefined;
  const login = async (person: Person) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAILS[person], password: PASSWORD }, headers: { origin: ORIGIN } });
    assert.equal(res.statusCode, 200, res.body);
    sessions[person] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
  };
  /** Runs statements in a transaction that is always rolled back. */
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
    for (const person of ['assistant', 's2', 'instructorB', 'outsider', 'pm'] as const) {
      const [user] = await database.db.insert(users).values({ email: EMAILS[person], givenName: 'Test', familyName: person }).returning();
      await database.db.insert(userCredentials).values({ userId: user!.id, passwordHash });
    }
    app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', FORUM_POST_RATE_LIMIT_MAX: '1000' }),
      database: database.db,
      clock: () => pinned ?? new Date(),
    });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) await login(person);
    const program = await ok('admin', 'POST', '/programs', { code: 'FOR', name: 'Foros' }, 201);
    ids.program = program.id;
    const term = await ok('admin', 'POST', '/terms', { code: '2026-2', name: 'Semestre 2026-2', startsOn: '2026-08-17', endsOn: '2026-12-11' }, 201);
    const template = await ok('admin', 'POST', '/course-templates', { code: 'FOR-T', programId: program.id, title: 'Foros', sections: [{ title: 'Unidad 1' }] }, 201);
    const course = async (code: string, status = 'published') => (await ok('admin', 'POST', '/courses', { programId: program.id, termId: term.id, templateId: template.templateId, code, status }, 201)).id as string;
    ids.courseA = await course('FOR-A');
    ids.courseB = await course('FOR-B');
    ids.courseD = await course('FOR-D', 'draft');
    const enroll = async (courseId: string, person: Person, role: string) => (await ok('admin', 'POST', `/courses/${courseId}/enrollments`, { email: EMAILS[person], role }, 201)).id as string;
    for (const [person, role] of [['instructor', 'instructor'], ['assistant', 'non_editing_instructor'], ['reviewer', 'design_team'], ['s1', 'student'], ['s2', 'student']] as const) {
      ids[`enroll_${person}`] = await enroll(ids.courseA, person, role);
    }
    for (const [person, role] of [['instructorB', 'instructor'], ['outsider', 'student']] as const) await enroll(ids.courseB, person, role);
    for (const [person, role] of [['instructor', 'instructor'], ['s1', 'student']] as const) await enroll(ids.courseD, person, role);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  it('1. a student starts a topic; a retry returns the same topic; it is listed for the course', async () => {
    const clientRequestId = randomUUID();
    const input = { title: '¿Cómo se calcula la nota final?', body: 'Tengo una duda sobre la ponderación de la unidad 2.', clientRequestId };
    const created = await ok<Topic>('s1', 'POST', `${A()}/forum/topics`, input, 201);
    assert.equal(created.title, input.title);
    assert.equal(created.body, input.body);
    assert.equal(created.course.id, ids.courseA);
    assert.deepEqual([created.author.id, created.author.role, created.mine], [sessions.s1.userId, 'student', true]);
    assert.deepEqual([created.pinned, created.locked, created.hidden, created.replyCount, created.lastReply], [false, false, false, 0, null]);
    assert.deepEqual([created.canReply, created.canEdit, created.canModerate], [true, true, false]);
    assert.ok(created.editableUntil && created.editedAt === null);
    ids.t1 = created.id;

    const retried = await ok<Topic>('s1', 'POST', `${A()}/forum/topics`, input, 200);
    assert.equal(retried.id, created.id);
    assert.equal(await count('SELECT count(*) AS n FROM forum_topics WHERE client_request_id = $1', [clientRequestId]), 1);

    for (const bad of [{ ...input, title: '   ', clientRequestId: randomUUID() }, { ...input, body: 'x'.repeat(10_001), clientRequestId: randomUUID() }, { title: 'Sin id', body: 'x' }]) {
      problem(await request('s1', 'POST', `${A()}/forum/topics`, bad), 400, 'VALIDATION_ERROR');
    }
    const listed = await list('s2');
    assert.deepEqual(listed.viewer, { role: 'student', canPost: true, canModerate: false });
    assert.ok(listed.items.some((t) => t.id === ids.t1 && !t.mine));
    assert.equal((await ok<Topic>('s2', 'GET', `/forum/topics/${ids.t1}`)).body, input.body);
  });

  it('2. students reply to the topic and to a reply; the authors are notified', async () => {
    const r1 = await reply('s2', ids.t1!, 'La ponderación está en el sílabo.');
    assert.deepEqual([r1.number, r1.parentPostId, r1.author.role, r1.mine], [1, null, 'student', true]);
    const r2 = await reply('instructor', ids.t1!, 'Exacto: 40 % evaluaciones y 60 % examen final.', r1.id);
    assert.deepEqual([r2.number, r2.parentPostId, r2.author.role], [2, r1.id, 'instructor']);
    ids.r1 = r1.id;
    ids.r2 = r2.id;

    const page = await thread('s1', ids.t1!);
    assert.equal(page.total, 2);
    assert.deepEqual(page.items.map((p) => [p.id, p.replies.map((r) => r.id)]), [[r1.id, [r2.id]]]);
    const summary = (await list('s1')).items.find((t) => t.id === ids.t1)!;
    assert.equal(summary.replyCount, 2);
    assert.deepEqual(summary.lastReply, { authorName: r2.author.name, createdAt: r2.createdAt });

    // The topic's author (s1) and the answered reply's author (s2) are notified; the person replying is not.
    const s1Notes = await forumNotes('s1', ids.t1!);
    assert.equal(s1Notes.length, 1);
    assert.deepEqual([s1Notes[0]!.type, s1Notes[0]!.link, s1Notes[0]!.course?.id], ['forum_reply', `/courses/${ids.courseA}/forum/${ids.t1}`, ids.courseA]);
    assert.equal((await forumNotes('s2', ids.t1!)).length, 1);
    assert.equal((await forumNotes('instructor', ids.t1!)).length, 0);
    assert.equal((await forumNotes('assistant', ids.t1!)).length, 0);
  });

  it('3. concurrent replies get distinct, gap-free numbers and a stable order', async () => {
    const posters: Person[] = ['s1', 's2', 'assistant', 'instructor'];
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => sendReply(posters[i % 4]!, ids.t1!, `Respuesta concurrente ${i}`)));
    for (const res of results) assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(results.map((res) => (res.json() as Post).number).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 3));
    const { rows } = await query('SELECT post_number FROM forum_posts WHERE topic_id = $1 ORDER BY post_number', [ids.t1]);
    assert.deepEqual(rows.map((r) => r.post_number), Array.from({ length: 22 }, (_, i) => i + 1));
    assert.equal(await count('SELECT last_post_number AS n FROM forum_topics WHERE id = $1', [ids.t1]), 22);

    // Reply pages: in number order, no duplicates or gaps, and the same order on every read.
    const pages: ThreadItem[] = [];
    let after: number | null = null;
    do {
      const page: PostPage = await ok<PostPage>('s1', 'GET', `/forum/topics/${ids.t1}/posts?limit=5${after !== null ? `&after=${after}` : ''}`);
      assert.ok(page.items.length <= 5);
      pages.push(...page.items);
      after = page.nextCursor;
    } while (after !== null);
    const numbers = pages.flatMap((p) => [p.number, ...p.replies.map((r) => r.number)]);
    assert.deepEqual([...numbers].sort((a, b) => a - b), Array.from({ length: 22 }, (_, i) => i + 1));
    const top = pages.map((p) => p.number);
    assert.deepEqual(top, [...top].sort((a, b) => a - b));
    assert.deepEqual(await thread('s2', ids.t1!), await thread('s2', ids.t1!));
  });

  it('4. topics paginate: pinned first, then latest activity, without duplicates or gaps', async () => {
    const created: Topic[] = [];
    for (const [who, title] of [['s2', 'Tema 2'], ['assistant', 'Tema 3'], ['instructor', 'Tema 4'], ['s2', 'Tema 5'], ['instructor', 'Tema 6']] as const) {
      created.push(await topic(who, title));
    }
    ids.pinnedTopic = created[0]!.id;
    assert.equal((await ok<Topic>('instructor', 'POST', `/forum/topics/${created[0]!.id}/moderation`, { action: 'pin' })).pinned, true);
    const seen: TopicSummary[] = [];
    let cursor: string | null = null;
    do {
      const page: TopicPage = await ok<TopicPage>('s1', 'GET', `${A()}/forum/topics?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      assert.ok(page.items.length <= 2);
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(new Set(seen.map((t) => t.id)).size, seen.length, 'no duplicates');
    assert.equal(seen.length, await count('SELECT count(*) AS n FROM forum_topics WHERE course_id = $1 AND hidden_at IS NULL', [ids.courseA]));
    assert.equal(seen[0]!.id, created[0]!.id);
    assert.ok(seen[0]!.pinned && seen.slice(1).every((t) => !t.pinned));
    for (let i = 2; i < seen.length; i++) assert.ok(seen[i]!.lastActivityAt <= seen[i - 1]!.lastActivityAt, 'latest activity first');
    assert.equal(seen[1]!.id, created[4]!.id, 'the newest unpinned topic follows the pinned one');

    problem(await request('s1', 'GET', `${A()}/forum/topics?cursor=nope`), 400, 'INVALID_CURSOR');
    const forged = Buffer.from(JSON.stringify(['9|2026-01-01', randomUUID()])).toString('base64url');
    problem(await request('s1', 'GET', `${A()}/forum/topics?cursor=${forged}`), 400, 'INVALID_CURSOR');
    problem(await request('s1', 'GET', `/forum/topics/${ids.t1}/posts?after=-1`), 400, 'VALIDATION_ERROR');
  });

  it('5. replies to replies stay one level deep and inside their topic (API and database)', async () => {
    problem(await sendReply('s1', ids.t1!, 'Demasiado profundo', ids.r2), 422, 'REPLY_NESTING_LIMIT');
    problem(await sendReply('s1', ids.pinnedTopic!, 'Otro tema', ids.r1), 404, 'NOT_FOUND');
    problem(await sendReply('s1', ids.t1!, 'Inexistente', randomUUID()), 404, 'NOT_FOUND');

    const other = (await query('SELECT id, course_id FROM forum_topics WHERE id = $1', [ids.pinnedTopic])).rows[0];
    const { rows: [t1] } = await query('SELECT id, course_id FROM forum_topics WHERE id = $1', [ids.t1]);
    const insert = (client: pg.PoolClient, topicRow: { id: string; course_id: string }, parent: string | null, number: number) =>
      client.query(
        `INSERT INTO forum_posts (course_id, topic_id, parent_post_id, post_number, author_user_id, body, client_request_id) VALUES ($1, $2, $3, $4, $5, 'x', gen_random_uuid())`,
        [topicRow.course_id, topicRow.id, parent, number, sessions.s1.userId],
      );
    const advance = async (client: pg.PoolClient, topicId: string) =>
      Number((await client.query('UPDATE forum_topics SET last_post_number = last_post_number + 1 WHERE id = $1 RETURNING last_post_number AS n', [topicId])).rows[0].n);
    await rolledBack(async (c) => {
      await assert.rejects(insert(c, other, ids.r1!, await advance(c, other.id)), /forum_posts_parent_fk/);
    });
    await rolledBack(async (c) => {
      await assert.rejects(insert(c, t1, ids.r2!, await advance(c, t1.id)), /one level deep/);
    });
    await rolledBack(async (c) => {
      await assert.rejects(insert(c, t1, null, 99), /number its topic just assigned/);
    });
    await rolledBack(async (c) => {
      // A reply's course must be its topic's course.
      await assert.rejects(insert(c, { id: t1.id, course_id: ids.courseB! }, null, await advance(c, t1.id)), /forum_posts_topic_fk/);
    });
    await rolledBack(async (c) => {
      await assert.rejects(c.query('DELETE FROM forum_posts WHERE id = $1', [ids.r1]), /never deleted/);
    });
    await rolledBack(async (c) => {
      await assert.rejects(c.query('DELETE FROM forum_topics WHERE id = $1', [ids.t1]), /never deleted/);
    });
    await rolledBack(async (c) => {
      await assert.rejects(c.query('UPDATE forum_posts SET author_user_id = $2 WHERE id = $1', [ids.r1, sessions.s1.userId]), /keeps its course/);
    });
    await rolledBack(async (c) => {
      await assert.rejects(c.query(`UPDATE forum_posts SET body = 'cambiado' WHERE id = $1`, [ids.r1]), /records when it was edited/);
    });
    await rolledBack(async (c) => {
      await assert.rejects(c.query('UPDATE forum_topics SET last_post_number = 1 WHERE id = $1', [ids.t1]), /reply numbering/);
    });
    await rolledBack(async (c) => {
      await assert.rejects(c.query(`UPDATE forum_posts SET hidden_at = now() WHERE id = $1`, [ids.r1]), /forum_posts_hidden_check/);
    });
  });

  it('6. members of other courses cannot read or write this forum, nor reach it through ids', async () => {
    for (const [method, url, body] of [
      ['GET', `${A()}/forum/topics`],
      ['POST', `${A()}/forum/topics`, { title: 'x', body: 'y', clientRequestId: randomUUID() }],
      ['GET', `/forum/topics/${ids.t1}`],
      ['GET', `/forum/topics/${ids.t1}/posts`],
      ['POST', `/forum/topics/${ids.t1}/posts`, { body: 'x', clientRequestId: randomUUID() }],
      ['PATCH', `/forum/topics/${ids.t1}`, { title: 'x' }],
      ['PATCH', `/forum/posts/${ids.r1}`, { body: 'x' }],
      ['POST', `/forum/topics/${ids.t1}/moderation`, { action: 'lock' }],
      ['POST', `/forum/posts/${ids.r1}/moderation`, { action: 'hide' }],
    ] as const) {
      for (const who of ['outsider', 'instructorB'] as const) problem(await request(who, method, url, body), 404, 'NOT_FOUND');
    }
    const tB = await topic('outsider', 'Tema del curso B', 'Solo para el curso B', {}, ids.courseB);
    ids.tB = tB.id;
    const rB = await reply('instructorB', tB.id, 'Respuesta en B');
    problem(await request('s1', 'GET', `/forum/topics/${tB.id}`), 404, 'NOT_FOUND');
    problem(await sendReply('s1', tB.id, 'Intruso'), 404, 'NOT_FOUND');
    problem(await sendReply('s1', ids.t1!, 'Padre ajeno', rB.id), 404, 'NOT_FOUND');
    assert.ok(!(await list('s1')).items.some((t) => t.id === tB.id));
    assert.ok(!(await notificationsOf('s1')).some((n) => n.course?.id === ids.courseB));
  });

  it('7. a revoked enrollment loses forum access and the course’s forum notifications', async () => {
    assert.equal((await forumNotes('s2', ids.t1!)).length, 1);
    await ok('admin', 'PUT', `${A()}/enrollments/${ids.enroll_s2}`, { status: 'inactive' });
    problem(await request('s2', 'GET', `${A()}/forum/topics`), 404, 'NOT_FOUND');
    problem(await request('s2', 'GET', `/forum/topics/${ids.t1}`), 404, 'NOT_FOUND');
    problem(await request('s2', 'GET', `/forum/topics/${ids.t1}/posts`), 404, 'NOT_FOUND');
    problem(await sendReply('s2', ids.t1!, '¿Sigo aquí?'), 404, 'NOT_FOUND');
    problem(await request('s2', 'PATCH', `/forum/posts/${ids.r1}`, { body: 'Cambio' }), 404, 'NOT_FOUND');
    assert.equal((await forumNotes('s2', ids.t1!)).length, 0, 'hidden while the enrollment is inactive');
    const before = await noteRow('s2', ids.t1!);
    await reply('s1', ids.t1!, 'Respuesta a s2 mientras no tiene acceso', ids.r1);
    assert.deepEqual((await noteRow('s2', ids.t1!))?.event_at, before?.event_at, 'no new notification for someone without access');
    await ok('admin', 'PUT', `${A()}/enrollments/${ids.enroll_s2}`, { status: 'active' });
    assert.equal((await list('s2')).viewer.canPost, true);
    assert.equal((await forumNotes('s2', ids.t1!)).length, 1, 'visible again with the enrollment');
  });

  it('8. deactivated accounts cannot post and are not notified', async () => {
    await ok('admin', 'POST', `/users/${sessions.s1.userId}/deactivate`);
    assert.equal((await sendReply('s1', ids.t1!, 'Cuenta desactivada')).statusCode, 401);
    assert.equal((await createTopic('s1', 'Cuenta desactivada', 'x')).statusCode, 401);
    const before = await noteRow('s1', ids.t1!);
    await reply('s2', ids.t1!, 'Respuesta mientras s1 está desactivada');
    assert.deepEqual((await noteRow('s1', ids.t1!))?.event_at, before?.event_at);
    await ok('admin', 'POST', `/users/${sessions.s1.userId}/reactivate`);
    await login('s1');
    assert.equal((await list('s1')).viewer.canPost, true);
  });

  it('9. students cannot moderate, announce or edit other people’s posts', async () => {
    for (const action of ['pin', 'unpin', 'lock', 'unlock', 'hide', 'restore']) problem(await moderate('s1', ids.t1!, action), 403, 'FORBIDDEN');
    problem(await moderatePost('s1', ids.r1!, 'hide'), 403, 'FORBIDDEN');
    problem(await request('s1', 'PATCH', `/forum/posts/${ids.r1}`, { body: 'Cambio ajeno' }), 403, 'FORBIDDEN');
    problem(await request('s1', 'PATCH', `/forum/topics/${ids.pinnedTopic}`, { title: 'Cambio ajeno' }), 403, 'FORBIDDEN');
    problem(await createTopic('s1', 'Anuncio', 'x', { announce: true }), 403, 'FORBIDDEN');
    problem(await request('s1', 'GET', '/admin/forums/courses'), 403, 'FORBIDDEN');
    assert.equal((await ok<Topic>('s1', 'GET', `/forum/topics/${ids.t1}`)).canModerate, false);
    assert.ok(flat(await thread('s1', ids.t1!)).every((p) => p.mine === (p.author.id === sessions.s1.userId) && (!p.canEdit || p.mine)));
  });

  it('10. instructors pin, lock, hide and restore; administrators moderate but never post; every change is audited', async () => {
    const marker = `moderado-${randomUUID()}`;
    const t = await topic('s2', `Tema ${marker}`, `Texto ${marker}`);
    const r = await reply('s1', t.id, `Respuesta ${marker}`);
    const audits = (action: string, entityId: string) => count(`SELECT count(*) AS n FROM audit_log WHERE action = $1 AND entity_id = $2`, [action, entityId]);

    assert.equal((await ok<Topic>('instructor', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'pin' })).pinned, true);
    assert.equal((await ok<Topic>('instructor', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'pin' })).pinned, true);
    assert.equal(await audits('forum.topic.pinned', t.id), 1, 'repeating the current state changes nothing');
    assert.equal((await ok<Topic>('instructor', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'unpin' })).pinned, false);
    assert.equal((await ok<Topic>('instructor', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'lock' })).locked, true);
    assert.equal((await ok<Topic>('s2', 'GET', `/forum/topics/${t.id}`)).canReply, false);
    assert.equal((await ok<Topic>('instructor', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'unlock' })).locked, false);
    assert.equal((await ok<Topic>('instructor', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'hide' })).hidden, true);
    assert.ok((await list('instructor')).items.some((x) => x.id === t.id && x.hidden));
    problem(await request('s2', 'GET', `/forum/topics/${t.id}`), 404, 'NOT_FOUND');
    assert.equal((await ok<Topic>('instructor', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'restore' })).hidden, false);
    assert.equal((await ok<Topic>('s2', 'GET', `/forum/topics/${t.id}`)).hidden, false);
    assert.equal((await ok<Post>('instructor', 'POST', `/forum/posts/${r.id}/moderation`, { action: 'hide' })).hidden, true);
    assert.equal((await ok<Post>('instructor', 'POST', `/forum/posts/${r.id}/moderation`, { action: 'restore' })).hidden, false);
    problem(await moderate('instructor', t.id, 'archive'), 400, 'VALIDATION_ERROR');
    for (const action of ['pinned', 'unpinned', 'locked', 'unlocked', 'hidden', 'restored']) assert.equal(await audits(`forum.topic.${action}`, t.id), 1, action);
    assert.equal(await audits('forum.post.hidden', r.id), 1);
    assert.equal(await audits('forum.post.restored', r.id), 1);
    const actor = (await query(`SELECT DISTINCT actor_user_id FROM audit_log WHERE entity_id = $1`, [t.id])).rows.map((x) => x.actor_user_id);
    assert.deepEqual(actor, [sessions.instructor.userId]);

    // Administrators: read and moderate as institutional control, never post.
    const asAdmin = await list('admin');
    assert.deepEqual(asAdmin.viewer, { role: null, canPost: false, canModerate: true });
    problem(await createTopic('admin', 'Aviso', 'x'), 403, 'FORBIDDEN');
    problem(await sendReply('admin', t.id, 'x'), 403, 'FORBIDDEN');
    assert.equal((await ok<Topic>('admin', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'lock' })).locked, true);
    const adminAudit = (await query(`SELECT actor_user_id, metadata FROM audit_log WHERE action = 'forum.topic.locked' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1`, [t.id])).rows[0];
    assert.equal(adminAudit.actor_user_id, sessions.admin.userId);
    assert.equal(adminAudit.metadata.after.byAdministrator, true);
    await ok('admin', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'unlock' });
    assert.equal((await ok<Post>('admin', 'POST', `/forum/posts/${r.id}/moderation`, { action: 'hide' })).hidden, true);
    await ok('admin', 'POST', `/forum/posts/${r.id}/moderation`, { action: 'restore' });
    const overview = await ok<{ items: Array<{ course: { id: string }; topicCount: number; replyCount: number; lockedTopicCount: number; hiddenTopicCount: number; hiddenReplyCount: number }> }>('admin', 'GET', '/admin/forums/courses');
    const rowA = overview.items.find((i) => i.course.id === ids.courseA)!;
    assert.equal(rowA.topicCount, await count('SELECT count(*) AS n FROM forum_topics WHERE course_id = $1', [ids.courseA]));
    assert.equal(rowA.replyCount, await count('SELECT count(*) AS n FROM forum_posts WHERE course_id = $1', [ids.courseA]));
    assert.ok(!overview.items.some((i) => i.course.id === ids.courseD), 'published courses only');
    assert.ok(!JSON.stringify(overview).includes(marker), 'counts only');

    // Forum moderation gives administrators no access to private conversations.
    const dm = await ok<{ id: string }>('s1', 'POST', `${A()}/conversations`, { recipientUserId: sessions.instructor.userId }, 201);
    await ok('s1', 'POST', `/conversations/${dm.id}/messages`, { body: 'Consulta privada', clientMessageId: randomUUID() }, 201);
    problem(await request('admin', 'GET', `/conversations/${dm.id}`), 404, 'NOT_FOUND');
    problem(await request('admin', 'GET', `/conversations/${dm.id}/messages`), 404, 'NOT_FOUND');
    problem(await request('admin', 'GET', `${A()}/messaging`), 403, 'MESSAGING_NOT_AVAILABLE');
  });

  it('11. non-editing instructors take part but never moderate, announce or edit other people’s posts', async () => {
    const own = await topic('assistant', 'Tema del docente sin edición');
    await reply('assistant', ids.t1!, 'Aporte del docente sin edición');
    assert.deepEqual((await list('assistant')).viewer, { role: 'non_editing_instructor', canPost: true, canModerate: false });
    for (const action of ['pin', 'lock', 'hide']) problem(await moderate('assistant', own.id, action), 403, 'FORBIDDEN');
    problem(await moderatePost('assistant', ids.r1!, 'hide'), 403, 'FORBIDDEN');
    problem(await request('assistant', 'PATCH', `/forum/posts/${ids.r1}`, { body: 'Corrección ajena' }), 403, 'FORBIDDEN');
    problem(await request('assistant', 'PATCH', `/forum/topics/${ids.t1}`, { body: 'Corrección ajena' }), 403, 'FORBIDDEN');
    problem(await createTopic('assistant', 'Anuncio', 'x', { announce: true }), 403, 'FORBIDDEN');
    // Like students, they never see hidden replies.
    const hidden = await reply('s2', own.id, 'Respuesta que se ocultará');
    await ok('instructor', 'POST', `/forum/posts/${hidden.id}/moderation`, { action: 'hide' });
    assert.ok(!flat(await thread('assistant', own.id)).some((p) => p.id === hidden.id));
    assert.ok(flat(await thread('instructor', own.id)).some((p) => p.id === hidden.id && p.hidden));
  });

  it('12. the design team, program managers and unpublished courses have no forum', async () => {
    await ok('admin', 'POST', `/programs/${ids.program}/managers`, { email: EMAILS.pm }, 201);
    for (const [method, url, body] of [
      ['GET', `${A()}/forum/topics`],
      ['POST', `${A()}/forum/topics`, { title: 'x', body: 'y', clientRequestId: randomUUID() }],
    ] as const) {
      problem(await request('pm', method, url, body), 404, 'NOT_FOUND');
      problem(await request('reviewer', method, url, body), 403, 'FORUM_NOT_AVAILABLE');
    }
    for (const who of ['pm', 'reviewer'] as const) {
      problem(await request(who, 'GET', `/forum/topics/${ids.t1}`), 404, 'NOT_FOUND');
      problem(await request(who, 'GET', `/forum/topics/${ids.t1}/posts`), 404, 'NOT_FOUND');
      problem(await sendReply(who, ids.t1!, 'x'), 404, 'NOT_FOUND');
      problem(await moderate(who, ids.t1!, 'lock'), 404, 'NOT_FOUND');
      problem(await request(who, 'GET', '/admin/forums/courses'), 403, 'FORBIDDEN');
      assert.ok(!(await notificationsOf(who)).some((n) => n.type.startsWith('forum_')));
    }
    problem(await request('instructor', 'GET', `/courses/${ids.courseD}/forum/topics`), 403, 'FORUM_NOT_AVAILABLE');
    problem(await request('admin', 'GET', `/courses/${ids.courseD}/forum/topics`), 403, 'FORUM_NOT_AVAILABLE');
    problem(await request('s1', 'GET', `/courses/${ids.courseD}/forum/topics`), 404, 'NOT_FOUND');
    problem(await createTopic('instructor', 'Borrador', 'x', {}, ids.courseD), 403, 'FORUM_NOT_AVAILABLE');
  });

  it('13. hidden replies and topics do not leak through threads, counts, previews, search, links or notifications', async () => {
    const marker = `oculto-${randomUUID()}`;
    const t = await topic('s1', 'Tema con una respuesta oculta');
    const visible = await reply('assistant', t.id, 'Respuesta visible');
    const bad = await reply('s2', t.id, `Texto inapropiado ${marker}`);
    const child = await reply('s1', t.id, 'Respuesta a la que se ocultará', bad.id);
    assert.equal((await forumNotes('s1', t.id))[0]?.data.postId, bad.id);
    assert.equal((await forumNotes('s2', t.id))[0]?.data.postId, child.id);

    await ok('instructor', 'POST', `/forum/posts/${bad.id}/moderation`, { action: 'hide' });
    for (const who of ['s1', 's2', 'assistant'] as const) {
      const page = await thread(who, t.id);
      assert.deepEqual(flat(page).map((p) => p.id), [visible.id], who);
      assert.equal(page.total, 1);
      const summary = (await list(who)).items.find((x) => x.id === t.id)!;
      assert.equal(summary.replyCount, 1);
      assert.equal(summary.lastReply?.createdAt, visible.createdAt, 'the preview is the latest visible reply');
      assert.equal(summary.lastActivityAt, visible.createdAt, 'the hidden reply no longer moves the topic up');
      assert.equal((await ok<Topic>(who, 'GET', `/forum/topics/${t.id}`)).replyCount, 1);
      assert.deepEqual((await list(who, `&q=${marker}`)).items, [], 'search');
      assert.ok(!JSON.stringify(await list(who)).includes(marker));
    }
    problem(await request('s2', 'PATCH', `/forum/posts/${bad.id}`, { body: 'Editar oculto' }), 404, 'NOT_FOUND');
    problem(await request('s1', 'PATCH', `/forum/posts/${child.id}`, { body: 'Editar bajo oculto' }), 404, 'NOT_FOUND');
    problem(await sendReply('s1', t.id, 'Responder a oculto', bad.id), 404, 'NOT_FOUND');
    problem(await moderatePost('s1', bad.id, 'restore'), 404, 'NOT_FOUND');
    const badRetry = (await query('SELECT client_request_id FROM forum_posts WHERE id = $1', [bad.id])).rows[0].client_request_id as string;
    problem(await sendReply('s2', t.id, `Texto inapropiado ${marker}`, undefined, badRetry), 404, 'NOT_FOUND');
    assert.equal((await forumNotes('s1', t.id)).length, 0, 'the notification about the hidden reply is withdrawn');
    assert.equal((await forumNotes('s2', t.id)).length, 0, 'and the one about a reply under it');
    const staff = await thread('instructor', t.id);
    assert.deepEqual(flat(staff).map((p) => [p.id, p.hidden]), [[visible.id, false], [bad.id, true], [child.id, false]]);
    assert.equal(staff.total, 3);
    assert.equal((await list('instructor', `&q=${marker}`)).items.length, 1);
    problem(await sendReply('instructor', t.id, 'Respuesta a oculto', bad.id), 409, 'POST_HIDDEN');

    await ok('instructor', 'POST', `/forum/posts/${bad.id}/moderation`, { action: 'restore' });
    assert.deepEqual(flat(await thread('s1', t.id)).map((p) => p.id), [visible.id, bad.id, child.id]);
    assert.equal((await forumNotes('s1', t.id)).length, 0, 'restoring does not notify again');

    // A hidden topic disappears with its replies for everyone but moderators.
    await reply('s2', t.id, `Otra respuesta ${marker}`);
    assert.equal((await forumNotes('s1', t.id)).length, 1);
    await ok('instructor', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'hide' });
    for (const who of ['s1', 's2', 'assistant'] as const) {
      assert.ok(!(await list(who)).items.some((x) => x.id === t.id), who);
      assert.deepEqual((await list(who, `&q=${marker}`)).items, []);
      problem(await request(who, 'GET', `/forum/topics/${t.id}`), 404, 'NOT_FOUND');
      problem(await request(who, 'GET', `/forum/topics/${t.id}/posts`), 404, 'NOT_FOUND');
      problem(await sendReply(who, t.id, 'x'), 404, 'NOT_FOUND');
      assert.equal((await forumNotes(who, t.id)).length, 0);
    }
    problem(await request('s1', 'PATCH', `/forum/posts/${child.id}`, { body: 'x' }), 404, 'NOT_FOUND');
    const topicRetry = (await query('SELECT client_request_id FROM forum_topics WHERE id = $1', [t.id])).rows[0].client_request_id as string;
    problem(await request('s1', 'POST', `${A()}/forum/topics`, { title: 'Tema con una respuesta oculta', body: 'x', clientRequestId: topicRetry }), 404, 'NOT_FOUND');
    problem(await sendReply('instructor', t.id, 'x'), 409, 'TOPIC_HIDDEN');
    assert.ok((await ok<{ items: Array<{ course: { id: string }; hiddenTopicCount: number }> }>('admin', 'GET', '/admin/forums/courses')).items.find((i) => i.course.id === ids.courseA)!.hiddenTopicCount >= 1);
    const summary = await ok<{ unreadNotifications: number }>('s1', 'GET', '/me/messaging/summary');
    assert.equal(summary.unreadNotifications, (await notificationsOf('s1')).filter((n) => !n.read).length, 'the badge counts only visible notifications');
    await ok('instructor', 'POST', `/forum/topics/${t.id}/moderation`, { action: 'restore' });
    assert.ok((await list('s1')).items.some((x) => x.id === t.id));
  });

  it('14. locked topics reject replies from participants but not from moderators', async () => {
    await ok('instructor', 'POST', `/forum/topics/${ids.t1}/moderation`, { action: 'lock' });
    problem(await sendReply('s1', ids.t1!, 'Tarde'), 409, 'TOPIC_LOCKED');
    problem(await sendReply('assistant', ids.t1!, 'Tarde'), 409, 'TOPIC_LOCKED');
    problem(await sendReply('s2', ids.t1!, 'Tarde', ids.r1), 409, 'TOPIC_LOCKED');
    const asStudent = await ok<Topic>('s1', 'GET', `/forum/topics/${ids.t1}`);
    assert.deepEqual([asStudent.locked, asStudent.canReply], [true, false]);
    await reply('instructor', ids.t1!, 'Cierro el tema con esta respuesta.');
    await ok('instructor', 'POST', `/forum/topics/${ids.t1}/moderation`, { action: 'unlock' });
    await reply('s1', ids.t1!, 'Gracias por la respuesta.');
  });

  it('15. one notification per person and topic; announcements notify the course once', async () => {
    const t = await topic('s2', 'Tema para notificaciones');
    await reply('s1', t.id, 'Primera');
    await reply('assistant', t.id, 'Segunda');
    const thirdId = randomUUID();
    assert.equal((await sendReply('instructor', t.id, 'Tercera', undefined, thirdId)).statusCode, 201);
    const rows = () => count(`SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND dedupe_key = $2`, [sessions.s2.userId, `forum:${t.id}`]);
    assert.equal(await rows(), 1);
    const [note] = await forumNotes('s2', t.id);
    assert.equal(note!.read, false);
    await ok('s2', 'PUT', `/me/notifications/${note!.id}/read`, undefined, 204);
    // A retried reply notifies nobody again; the topic author's own reply notifies nobody.
    assert.equal((await sendReply('instructor', t.id, 'Tercera', undefined, thirdId)).statusCode, 200);
    await reply('s2', t.id, 'Respuesta del autor');
    assert.equal((await forumNotes('s2', t.id))[0]!.read, true);
    await reply('s1', t.id, 'Cuarta');
    assert.equal(await rows(), 1);
    assert.equal((await forumNotes('s2', t.id))[0]!.read, false, 'refreshed, not duplicated');

    const announced = await topic('instructor', 'Aviso del foro: sesión de repaso', 'Repasaremos la unidad 2.', { announce: true });
    for (const who of ['s1', 's2', 'assistant'] as const) {
      const notes = await forumNotes(who, announced.id);
      assert.equal(notes.length, 1, who);
      assert.equal(notes[0]!.type, 'forum_topic');
    }
    for (const who of ['instructor', 'reviewer', 'outsider', 'instructorB', 'admin', 'pm'] as const) assert.equal((await forumNotes(who, announced.id)).length, 0, who);
    assert.equal(await count(`SELECT count(*) AS n FROM notifications WHERE dedupe_key = $1`, [`forum:${announced.id}`]), 3);
  });

  it('16. forum notifications carry no text and stay private', async () => {
    const secret = `cuerpo-${randomUUID()}`;
    const t = await topic('s1', 'Tema privado de notificaciones', `Texto ${secret}`);
    await reply('s2', t.id, `Respuesta ${secret}`);
    const [note] = await forumNotes('s1', t.id);
    assert.deepEqual(Object.keys(note!.data).sort(), ['authorName', 'courseCode', 'postId', 'topicTitle']);
    assert.equal(note!.data.topicTitle, 'Tema privado de notificaciones');
    assert.ok(!JSON.stringify(note).includes(secret));
    assert.equal(note!.link, `/courses/${ids.courseA}/forum/${t.id}`);
    problem(await request('s2', 'PUT', `/me/notifications/${note!.id}/read`), 404, 'NOT_FOUND');
    problem(await request('outsider', 'PUT', `/me/notifications/${note!.id}/read`), 404, 'NOT_FOUND');
    assert.equal(await count(`SELECT count(*) AS n FROM notifications WHERE data::text LIKE $1`, [`%${secret}%`]), 0);
    const announcement = (await notificationsOf('s1')).find((n) => n.type === 'forum_topic')!;
    assert.deepEqual(Object.keys(announcement.data).sort(), ['authorName', 'courseCode', 'topicTitle']);
  });

  it('17. posting is rate-limited per person, counted in PostgreSQL across instances', async () => {
    const limited = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, FORUM_POST_RATE_LIMIT_MAX: '3' }), database: database.db });
    await limited.ready();
    try {
      // outsider has posted one topic in course B (test 6).
      const first = { body: 'Uno', clientRequestId: randomUUID() };
      assert.equal((await requestOn(limited, 'outsider', 'POST', `/forum/topics/${ids.tB}/posts`, first)).statusCode, 201);
      assert.equal((await requestOn(app, 'outsider', 'POST', `/forum/topics/${ids.tB}/posts`, { body: 'Dos', clientRequestId: randomUUID() })).statusCode, 201);
      const over = await requestOn(limited, 'outsider', 'POST', `/forum/topics/${ids.tB}/posts`, { body: 'Tres', clientRequestId: randomUUID() });
      problem(over, 429, 'RATE_LIMITED');
      assert.ok(Number(over.headers['retry-after']) >= 1);
      problem(await requestOn(limited, 'outsider', 'POST', `/courses/${ids.courseB}/forum/topics`, { title: 'x', body: 'y', clientRequestId: randomUUID() }), 429, 'RATE_LIMITED');
      assert.equal((await requestOn(limited, 'outsider', 'POST', `/forum/topics/${ids.tB}/posts`, first)).statusCode, 200, 'a retry is not a new post');
      assert.equal((await requestOn(limited, 'instructorB', 'POST', `/forum/topics/${ids.tB}/posts`, { body: 'Otro autor', clientRequestId: randomUUID() })).statusCode, 201);
      assert.equal(await count('SELECT count(*) AS n FROM forum_posts WHERE author_user_id = $1', [sessions.outsider.userId]), 2);
    } finally {
      await limited.close();
    }
  });

  it('18. unsafe text is stored and returned literally as plain text', async () => {
    const unsafe = `<script>alert('x')</script><img src=x onerror="alert(1)"> & <b>negrita</b> {{7*7}}`;
    const res = await createTopic('s1', `<i>${unsafe}</i>`, unsafe);
    assert.equal(res.statusCode, 201);
    assert.match(String(res.headers['content-type']), /^application\/json/);
    const t = res.json() as Topic;
    assert.equal(t.title, `<i>${unsafe}</i>`);
    assert.equal(t.body, unsafe);
    assert.equal((await reply('s2', t.id, unsafe)).body, unsafe);
    assert.ok((await list('s1')).items.find((x) => x.id === t.id)!.excerpt.includes('<script>'));
    assert.equal((await forumNotes('s1', t.id))[0]!.data.topicTitle, `<i>${unsafe}</i>`);
  });

  it('19. CSRF and Origin are enforced on every forum write', async () => {
    const writes = [
      ['POST', `${A()}/forum/topics`, { title: 'x', body: 'y', clientRequestId: randomUUID() }],
      ['PATCH', `/forum/topics/${ids.t1}`, { title: 'x' }],
      ['POST', `/forum/topics/${ids.t1}/moderation`, { action: 'pin' }],
      ['POST', `/forum/topics/${ids.t1}/posts`, { body: 'x', clientRequestId: randomUUID() }],
      ['PATCH', `/forum/posts/${ids.r1}`, { body: 'x' }],
      ['POST', `/forum/posts/${ids.r1}/moderation`, { action: 'hide' }],
    ] as const;
    for (const [method, url, body] of writes) {
      const noCsrf = await app.inject({ method, url: `/api/v1${url}`, cookies: { ap_session: sessions.instructor.token }, headers: { origin: ORIGIN }, payload: body });
      problem(noCsrf, 403, 'CSRF_TOKEN_INVALID');
      problem(await request('instructor', method, url, body, { origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
      assert.equal((await request(null, method, url, body)).statusCode, 401);
    }
    assert.equal((await ok<Topic>('s1', 'GET', `/forum/topics/${ids.t1}`)).pinned, false);
  });

  it('20. forum text never reaches the logs or the audit records', async () => {
    const lines: string[] = [];
    const logged = buildApp({
      config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, FORUM_POST_RATE_LIMIT_MAX: '1000' }),
      database: database.db,
      logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
    });
    await logged.ready();
    const secret = `texto-privado-${randomUUID()}`;
    const call = (who: Person, method: Method, url: string, body?: object) =>
      logged.inject({ method, url: `/api/v1${url}`, cookies: { ap_session: sessions[who].token }, headers: { origin: ORIGIN, 'x-csrf-token': sessions[who].csrf }, ...(body ? { payload: body } : {}) });
    const created = await call('s2', 'POST', `${A()}/forum/topics`, { title: `Título ${secret}`, body: `Texto ${secret}`, clientRequestId: randomUUID() });
    assert.equal(created.statusCode, 201);
    const topicId = created.json().id as string;
    const posted = await call('s1', 'POST', `/forum/topics/${topicId}/posts`, { body: `Respuesta ${secret}`, clientRequestId: randomUUID() });
    assert.equal(posted.statusCode, 201);
    for (const action of ['pin', 'lock', 'hide', 'restore', 'unlock']) assert.equal((await call('instructor', 'POST', `/forum/topics/${topicId}/moderation`, { action })).statusCode, 200);
    assert.equal((await call('instructor', 'POST', `/forum/posts/${posted.json().id}/moderation`, { action: 'hide' })).statusCode, 200);
    await logged.close();
    assert.ok(lines.length > 0);
    assert.ok(!lines.join('\n').includes(secret));
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE action LIKE 'forum.%' AND entity_id IN ($1, $2)`, [topicId, posted.json().id]), 6);
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE metadata::text LIKE $1`, [`%${secret}%`]), 0);
  });

  it('edits: own posts only, within the edit window, before anyone replies; recorded as edited', async () => {
    const t = await topic('s1', 'Título inicial', 'Texto inicial');
    const edited = await ok<Topic>('s1', 'PATCH', `/forum/topics/${t.id}`, { title: 'Título corregido' });
    assert.deepEqual([edited.title, edited.body], ['Título corregido', 'Texto inicial']);
    assert.ok(edited.editedAt);
    const r = await reply('s2', t.id, 'Respuesta inicial');
    problem(await request('s1', 'PATCH', `/forum/topics/${t.id}`, { body: 'Cambio tras una respuesta' }), 409, 'EDIT_NOT_ALLOWED');
    assert.equal((await ok<Topic>('s1', 'GET', `/forum/topics/${t.id}`)).canEdit, false);
    const once = await ok<Post>('s2', 'PATCH', `/forum/posts/${r.id}`, { body: 'Respuesta corregida' });
    const twice = await ok<Post>('s2', 'PATCH', `/forum/posts/${r.id}`, { body: 'Respuesta corregida otra vez' });
    assert.ok(once.editedAt && twice.editedAt && twice.editedAt > once.editedAt);
    const child = await reply('s1', t.id, 'Respuesta a la respuesta', r.id);
    problem(await request('s2', 'PATCH', `/forum/posts/${r.id}`, { body: 'Cambio tras una respuesta' }), 409, 'EDIT_NOT_ALLOWED');
    assert.equal((await ok<Post>('s1', 'PATCH', `/forum/posts/${child.id}`, { body: 'Corregida a tiempo' })).body, 'Corregida a tiempo');
    pinned = new Date(Date.now() + 31 * 60_000);
    try {
      problem(await request('s1', 'PATCH', `/forum/posts/${child.id}`, { body: 'Demasiado tarde' }), 409, 'EDIT_WINDOW_CLOSED');
      const mine = flat(await thread('s1', t.id)).find((p) => p.id === child.id)!;
      assert.deepEqual([mine.canEdit, mine.editableUntil], [false, null]);
    } finally {
      pinned = null;
    }
    problem(await request('s1', 'PATCH', `/forum/posts/${child.id}`, { body: '' }), 400, 'VALIDATION_ERROR');
    problem(await request('s1', 'PATCH', `/forum/topics/${t.id}`, {}), 400, 'VALIDATION_ERROR');
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE entity_id IN ($1, $2)`, [t.id, r.id]), 0, 'edits are not moderation');
  });
});

describe('demo course forum (demo dataset, PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
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
    root = await mkdtemp(join(tmpdir(), 'ap027-'));
    await seedDemo(database.db, { password: PASSWORD, env: env(), uploadFilesDir: null });
    app = buildApp({ config: { ...loadConfig(env()), loginRateLimit: { max: 1000, windowMs: 60_000 } }, database: database.db });
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('26. seeds the ITIL 4 Foundation forum (pinned topic, question with answers, locked discussion), idempotently', async () => {
    const { rows: [course] } = await database.pool.query(`SELECT id FROM courses WHERE code = $1`, [DEMO_FORUMS.courseCode]);
    const listing = await call('student@academiapath.example', 'GET', `/courses/${course.id}/forum/topics`);
    assert.equal(listing.status, 200);
    const items = listing.json.items as TopicSummary[];
    assert.deepEqual(items.map((t) => t.title).sort(), DEMO_FORUMS.topics.map((t) => t.title).sort());
    const welcome = items.find((t) => t.title === DEMO_FORUMS.topics[0]!.title)!;
    assert.equal(items[0]!.id, welcome.id, 'the pinned topic comes first');
    assert.deepEqual([welcome.pinned, welcome.author.role], [true, 'instructor']);
    const question = items.find((t) => t.title === DEMO_FORUMS.topics[1]!.title)!;
    assert.deepEqual([question.author.role, question.replyCount, question.locked], ['student', 2, false]);
    const locked = items.find((t) => t.title === DEMO_FORUMS.topics[2]!.title)!;
    assert.deepEqual([locked.locked, locked.replyCount], [true, 2]);
    const posts = (await call('student@academiapath.example', 'GET', `/forum/topics/${question.id}/posts`)).json as PostPage;
    assert.equal(posts.items.length, 1);
    assert.deepEqual([posts.items[0]!.author.role, posts.items[0]!.replies[0]!.author.role], ['instructor', 'student']);
    const notes = (await call('learner.a@academiapath.example', 'GET', '/me/notifications?limit=50')).json.items as Notification[];
    assert.ok(notes.some((n) => n.type === 'forum_topic' && n.link === `/courses/${course.id}/forum/${welcome.id}`));
    assert.equal((await call('reviewer@academiapath.example', 'GET', `/courses/${course.id}/forum/topics`)).status, 403);

    const snapshot = async () => (await database.pool.query(`SELECT (SELECT count(*) FROM forum_topics) AS t, (SELECT count(*) FROM forum_posts) AS p, (SELECT count(*) FROM notifications) AS n, (SELECT count(*) FROM audit_log WHERE action LIKE 'forum.%') AS a`)).rows[0];
    const before = await snapshot();
    const again = await seedDemo(database.db, { password: PASSWORD, env: env(), uploadFilesDir: null });
    assert.equal(again.counts['forum topics']?.created, 0);
    assert.equal(again.counts['forum replies']?.created, 0);
    assert.deepEqual(await snapshot(), before);
  });
});
