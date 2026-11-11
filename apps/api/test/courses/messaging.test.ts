/**
 * Messaging and in-app notifications (AP-026), against temporary PostgreSQL databases (skipped unless
 * TEST_DATABASE_URL is set). Synthetic users; tests in a describe run in order.
 *
 * Course A (published): instructor, assistant (non-editing instructor), reviewer (design team), students s1, s2.
 * Course B (published): instructorB, outsider (student). Course D (draft): instructor, s1.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { seedDemo } from '../../scripts/seed-demo.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { userCredentials, users } from '../../src/db/schema/index.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const RATE_MAX = 25;
const EMAILS = {
  admin: DEV_USERS[0]!.email,
  instructor: DEV_USERS[1]!.email,
  s1: DEV_USERS[2]!.email,
  reviewer: DEV_USERS[3]!.email,
  assistant: 'assistant@academiapath.example',
  s2: 'student2@academiapath.example',
  instructorB: 'instructor2@academiapath.example',
  outsider: 'outsider@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Method = 'GET' | 'POST' | 'PUT';
type Conversation = { id: string; kind: string; counterpart: { id: string; name: string; role: string | null } | null; unreadCount: number; canPost: boolean; canModerate: boolean; locked: boolean; lastMessage: { preview: string | null } | null };
type Message = { id: string; seq: number; body: string | null; hidden: boolean; mine: boolean; sender: { id: string; name: string; role: string | null } };
type MessagePage = { items: Message[]; olderCursor: number | null; latestSeq: number | null; readSeq: number };
type Notification = { id: string; type: string; data: Record<string, string>; link: string; read: boolean; course: { id: string } | null };

describe('messaging and notifications (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let pinned: Date | null = null;
  const sessions = {} as Record<Person, { token: string; csrf: string; userId: string }>;
  const ids = {} as Record<string, string>;

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
  const count = async (sql: string, params: unknown[] = []) => Number((await database.pool.query(sql, params)).rows[0].n);
  const send = (who: Person, conversationId: string, body: string, clientMessageId: string = randomUUID()) =>
    request(who, 'POST', `/conversations/${conversationId}/messages`, { body, clientMessageId });
  const sent = async (who: Person, conversationId: string, body: string) => {
    const res = await send(who, conversationId, body);
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as Message;
  };
  const summary = (who: Person) => ok<{ unreadMessages: number; unreadNotifications: number }>(who, 'GET', '/me/messaging/summary');
  const notificationsOf = async (who: Person, query = '') => (await ok<{ items: Notification[] }>(who, 'GET', `/me/notifications?limit=50${query}`)).items;
  const page = (who: Person, conversationId: string, query = '') => ok<MessagePage>(who, 'GET', `/conversations/${conversationId}/messages${query}`);
  const A = () => `/courses/${ids.courseA}`;
  const login = async (person: Person) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAILS[person], password: PASSWORD }, headers: { origin: ORIGIN } });
    assert.equal(res.statusCode, 200, res.body);
    sessions[person] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
  };

  before(async () => {
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const passwordHash = await hashPassword(PASSWORD);
    for (const person of ['assistant', 's2', 'instructorB', 'outsider'] as const) {
      const [user] = await database.db.insert(users).values({ email: EMAILS[person], givenName: 'Test', familyName: person }).returning();
      await database.db.insert(userCredentials).values({ userId: user!.id, passwordHash });
    }
    app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', MESSAGE_RATE_LIMIT_MAX: String(RATE_MAX) }),
      database: database.db,
      clock: () => pinned ?? new Date(),
    });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) await login(person);
    const program = await ok('admin', 'POST', '/programs', { code: 'MSG', name: 'Mensajería' }, 201);
    const term = await ok('admin', 'POST', '/terms', { code: '2026-2', name: 'Semestre 2026-2', startsOn: '2026-08-17', endsOn: '2026-12-11' }, 201);
    const template = await ok('admin', 'POST', '/course-templates', { code: 'MSG-T', programId: program.id, title: 'Mensajería', sections: [{ title: 'Unidad 1' }] }, 201);
    const course = async (code: string, status = 'published') => (await ok('admin', 'POST', '/courses', { programId: program.id, termId: term.id, templateId: template.templateId, code, status }, 201)).id as string;
    ids.courseA = await course('MSG-A');
    ids.courseB = await course('MSG-B');
    ids.courseD = await course('MSG-D', 'draft');
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

  it('1. contacts follow course roles; only a student and the course teaching staff can open a direct conversation', async () => {
    const forStudent = await ok<{ role: string; contacts: Array<{ id: string; role: string }> }>('s1', 'GET', `${A()}/messaging`);
    assert.equal(forStudent.role, 'student');
    assert.deepEqual(forStudent.contacts.map((c) => c.id).sort(), [sessions.instructor.userId, sessions.assistant.userId].sort());
    const forInstructor = await ok<{ contacts: Array<{ id: string }> }>('instructor', 'GET', `${A()}/messaging`);
    assert.deepEqual(forInstructor.contacts.map((c) => c.id).sort(), [sessions.s1.userId, sessions.s2.userId].sort());

    const opened = await ok<Conversation>('s1', 'POST', `${A()}/conversations`, { recipientUserId: sessions.instructor.userId }, 201);
    assert.equal(opened.kind, 'direct');
    assert.equal(opened.counterpart?.id, sessions.instructor.userId);
    ids.dm = opened.id;
    assert.equal((await ok<Conversation>('s1', 'POST', `${A()}/conversations`, { recipientUserId: sessions.instructor.userId })).id, ids.dm, 'returns the existing one');
    assert.equal((await ok<Conversation>('instructor', 'POST', `${A()}/conversations`, { recipientUserId: sessions.s1.userId })).id, ids.dm, 'one per pair and course');

    for (const [who, recipient] of [['s1', 's2'], ['instructor', 'assistant'], ['s1', 'reviewer'], ['s1', 'instructorB'], ['s1', 's1'], ['s1', 'admin']] as const) {
      problem(await request(who, 'POST', `${A()}/conversations`, { recipientUserId: sessions[recipient].userId }), 422, 'RECIPIENT_NOT_ALLOWED');
    }
    problem(await request('reviewer', 'GET', `${A()}/messaging`), 403, 'MESSAGING_NOT_AVAILABLE');
    problem(await request('admin', 'GET', `${A()}/messaging`), 403, 'MESSAGING_NOT_AVAILABLE');
    problem(await request('outsider', 'GET', `${A()}/messaging`), 404, 'NOT_FOUND');
  });

  it('2. direct messages persist in order, count as unread for the recipient and are marked read', async () => {
    const first = await sent('s1', ids.dm!, 'Hola profesor, tengo una consulta.');
    assert.equal(first.mine, true);
    assert.equal((await summary('instructor')).unreadMessages, 1);
    const listed = (await ok<{ items: Conversation[] }>('instructor', 'GET', '/me/conversations')).items.find((c) => c.id === ids.dm);
    assert.equal(listed?.unreadCount, 1);
    assert.equal(listed?.counterpart?.id, sessions.s1.userId);
    assert.equal(listed?.lastMessage?.preview, 'Hola profesor, tengo una consulta.');
    const reply = await sent('instructor', ids.dm!, 'Claro, dime.');
    assert.ok(reply.seq > first.seq);
    assert.equal((await summary('s1')).unreadMessages, 1);
    assert.equal((await summary('instructor')).unreadMessages, 0, 'replying reads the conversation for the sender');

    await ok('s1', 'PUT', `/conversations/${ids.dm}/read`, { upToSeq: reply.seq }, 204);
    assert.equal((await summary('s1')).unreadMessages, 0);
    await ok('s1', 'PUT', `/conversations/${ids.dm}/read`, { upToSeq: 0 }, 204);
    assert.equal((await page('s1', ids.dm!)).readSeq, reply.seq, 'a read position never moves back');

    // Persists across sessions, in server order.
    await login('s1');
    assert.deepEqual((await page('s1', ids.dm!)).items.map((m) => m.body), ['Hola profesor, tengo una consulta.', 'Claro, dime.']);
    const note = (await notificationsOf('instructor')).find((n) => n.type === 'direct_message');
    assert.ok(note && note.link === `/messages/${ids.dm}` && note.data.senderName && !Object.values(note.data).some((v) => v.includes('consulta')), JSON.stringify(note));
  });

  it('3. non-editing instructors message students; the course conversation is shared by students and teaching staff', async () => {
    const dm = await ok<Conversation>('assistant', 'POST', `${A()}/conversations`, { recipientUserId: sessions.s2.userId }, 201);
    ids.dmAssistant = dm.id;
    await sent('assistant', dm.id, 'Revisé tu entrega.');
    assert.equal((await summary('s2')).unreadMessages, 1);

    const group = await ok<Conversation>('s1', 'POST', `${A()}/course-conversation`, undefined, 201);
    ids.group = group.id;
    assert.equal((await ok<Conversation>('instructor', 'POST', `${A()}/course-conversation`)).id, group.id);
    assert.equal(group.canModerate, false);
    assert.equal((await ok<Conversation>('instructor', 'GET', `/conversations/${group.id}`)).canModerate, true);
    assert.equal((await ok<Conversation>('assistant', 'GET', `/conversations/${group.id}`)).canModerate, false);
    await sent('s2', group.id, 'Pregunta para todos.');
    await sent('s2', group.id, 'Y otra más.');
    for (const who of ['s1', 'instructor', 'assistant'] as const) {
      const notes = (await notificationsOf(who)).filter((n) => n.type === 'course_message');
      assert.equal(notes.length, 1, `${who}: one notification per conversation, refreshed`);
    }
    assert.equal((await notificationsOf('s2')).filter((n) => n.type === 'course_message').length, 0, 'not the sender');
    for (const who of ['reviewer', 'admin', 'outsider', 'instructorB'] as const) problem(await request(who, 'GET', `/conversations/${group.id}/messages`), 404, 'NOT_FOUND');
    assert.equal(await count(`SELECT count(*) AS n FROM notifications WHERE dedupe_key = $1 AND user_id = $2`, [`conversation:${group.id}`, sessions.reviewer.userId]), 0, 'design team not notified');
  });

  it('4. messages are plain text within limits; retries and concurrent sends never duplicate', async () => {
    const unsafe = '<script>alert(1)</script><b>negrita</b>';
    const message = await sent('s1', ids.dm!, unsafe);
    assert.equal((await page('instructor', ids.dm!)).items.at(-1)?.body, unsafe, 'returned as plain text, unchanged');
    for (const body of ['', '   \n ', 'x'.repeat(4001)]) problem(await send('s1', ids.dm!, body), 400, 'VALIDATION_ERROR');
    assert.equal((await send('s1', ids.dm!, 'y'.repeat(4000))).statusCode, 201);

    const key = randomUUID();
    const once = await send('s1', ids.dm!, 'Sólo una vez', key);
    const again = await send('s1', ids.dm!, 'Sólo una vez', key);
    assert.equal(once.statusCode, 201);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().id, once.json().id);
    const racing = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => send('instructor', ids.dm!, 'Carrera', racing)));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 200, 200, 201]);
    assert.equal(await count(`SELECT count(*) AS n FROM messages WHERE client_message_id = $1`, [racing]), 1);
    const parallel = await Promise.all(Array.from({ length: 4 }, (_, i) => send('instructor', ids.dm!, `Paralelo ${i}`)));
    const seqs = parallel.map((r) => r.json().seq as number);
    assert.equal(new Set(seqs).size, 4, 'distinct, server-ordered');
    assert.ok(seqs.every((seq) => seq > message.seq));
  });

  it('5. pagination: latest page, older pages and polling for newer messages', async () => {
    const dm = await ok<Conversation>('assistant', 'POST', `${A()}/conversations`, { recipientUserId: sessions.s1.userId }, 201);
    const bodies = Array.from({ length: 8 }, (_, i) => `m${i + 1}`);
    for (const [i, body] of bodies.entries()) await sent(i % 2 ? 's1' : 'assistant', dm.id, body);
    const latest = await page('s1', dm.id, '?limit=3');
    assert.deepEqual(latest.items.map((m) => m.body), ['m6', 'm7', 'm8']);
    assert.ok(latest.olderCursor !== null);
    const older = await page('s1', dm.id, `?limit=3&before=${latest.olderCursor}`);
    assert.deepEqual(older.items.map((m) => m.body), ['m3', 'm4', 'm5']);
    const oldest = await page('s1', dm.id, `?limit=3&before=${older.olderCursor}`);
    assert.deepEqual(oldest.items.map((m) => m.body), ['m1', 'm2']);
    assert.equal(oldest.olderCursor, null);
    const newer = await page('s1', dm.id, `?after=${older.items[2]!.seq}`);
    assert.deepEqual(newer.items.map((m) => m.body), ['m6', 'm7', 'm8']);
    problem(await request('s1', 'GET', `/conversations/${dm.id}/messages?after=1&before=9`), 400, 'INVALID_QUERY');
    problem(await request('s1', 'GET', `/conversations/${dm.id}/messages?limit=101`), 400, 'VALIDATION_ERROR');
  });

  it('6. sending is rate-limited per person; a retry of an earlier message is not counted', async () => {
    const used = await count(`SELECT count(*) AS n FROM messages WHERE sender_user_id = $1`, [sessions.s2.userId]);
    const firstKey = randomUUID();
    assert.equal((await send('s2', ids.dmAssistant!, 'primero', firstKey)).statusCode, 201);
    for (let i = used + 1; i < RATE_MAX; i += 1) assert.equal((await send('s2', ids.group!, `mensaje ${i}`)).statusCode, 201);
    const limited = await send('s2', ids.group!, 'uno más');
    problem(limited, 429, 'RATE_LIMITED');
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal((await send('s2', ids.dmAssistant!, 'primero', firstKey)).statusCode, 200, 'a retry still returns the first message');
  });

  it('7. moderation: instructors hide and lock; non-editing instructors and students cannot; administrators lock without reading', async () => {
    const target = await sent('s1', ids.group!, 'Mensaje fuera de lugar');
    problem(await request('assistant', 'POST', `/conversations/${ids.group}/messages/${target.id}/hide`), 403, 'FORBIDDEN');
    problem(await request('s1', 'POST', `/conversations/${ids.group}/messages/${target.id}/hide`), 403, 'FORBIDDEN');
    const hidden = await ok<Message>('instructor', 'POST', `/conversations/${ids.group}/messages/${target.id}/hide`);
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.body, null);
    const seen = (await page('s1', ids.group!)).items.find((m) => m.id === target.id);
    assert.deepEqual([seen?.hidden, seen?.body], [true, null]);
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE action = 'message.hidden' AND entity_id = $1`, [target.id]), 1);
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE metadata::text LIKE '%fuera de lugar%'`), 0, 'audit never holds the text');

    problem(await request('assistant', 'POST', `/conversations/${ids.group}/lock`), 403, 'FORBIDDEN');
    problem(await request('reviewer', 'POST', `/conversations/${ids.group}/lock`), 404, 'NOT_FOUND');
    assert.deepEqual(await ok('instructor', 'POST', `/conversations/${ids.group}/lock`), { conversationId: ids.group, locked: true });
    problem(await send('s1', ids.group!, '¿Sigue abierto?'), 409, 'CONVERSATION_LOCKED');
    problem(await send('instructor', ids.group!, 'Cerrado'), 409, 'CONVERSATION_LOCKED');
    assert.ok((await page('s1', ids.group!)).items.length > 0, 'still readable while locked');

    const adminList = await request('admin', 'GET', '/admin/messaging/courses');
    assert.equal(adminList.statusCode, 200);
    const row = adminList.json().items.find((item: { course: { id: string } }) => item.course.id === ids.courseA);
    assert.ok(row.locked && row.messageCount > 0 && row.conversationId === ids.group);
    assert.ok(!adminList.body.includes('Pregunta para todos'), 'no message text in the administrator list');
    problem(await request('s1', 'GET', '/admin/messaging/courses'), 403, 'FORBIDDEN');
    assert.deepEqual(await ok('admin', 'POST', `/conversations/${ids.group}/unlock`), { conversationId: ids.group, locked: false });
    problem(await request('admin', 'GET', `/conversations/${ids.group}/messages`), 404, 'NOT_FOUND');
    problem(await request('instructor', 'POST', `/conversations/${ids.dm}/lock`), 404, 'NOT_FOUND');
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE action IN ('conversation.locked', 'conversation.unlocked') AND entity_id = $1`, [ids.group]), 2);
  });

  it('8. no access across courses or by conversation id', async () => {
    for (const who of ['outsider', 'instructorB', 'reviewer', 'admin'] as const) {
      problem(await request(who, 'GET', `/conversations/${ids.dm}`), 404, 'NOT_FOUND');
      problem(await request(who, 'GET', `/conversations/${ids.dm}/messages`), 404, 'NOT_FOUND');
      problem(await send(who, ids.dm!, 'intruso'), 404, 'NOT_FOUND');
      problem(await request(who, 'PUT', `/conversations/${ids.dm}/read`, { upToSeq: 1 }), 404, 'NOT_FOUND');
    }
    // s2 is in course A but not a participant of s1's direct conversation.
    problem(await request('s2', 'GET', `/conversations/${ids.dm}/messages`), 404, 'NOT_FOUND');
    assert.equal((await summary('outsider')).unreadMessages, 0);
    const s1Note = (await notificationsOf('s1'))[0]!;
    problem(await request('outsider', 'PUT', `/me/notifications/${s1Note.id}/read`), 404, 'NOT_FOUND');
    assert.ok(!(await notificationsOf('outsider')).some((n) => n.course?.id === ids.courseA));
  });

  it('9. losing the enrollment or the account ends access and hides that course’s notifications', async () => {
    assert.ok((await notificationsOf('s2')).some((n) => n.course?.id === ids.courseA));
    await ok('admin', 'PUT', `${A()}/enrollments/${ids.enroll_s2}`, { status: 'inactive' });
    problem(await request('s2', 'GET', `/conversations/${ids.dmAssistant}/messages`), 404, 'NOT_FOUND');
    problem(await request('s2', 'GET', `/conversations/${ids.group}/messages`), 404, 'NOT_FOUND');
    assert.equal((await summary('s2')).unreadMessages, 0);
    assert.equal((await summary('s2')).unreadNotifications, 0);
    assert.ok(!(await notificationsOf('s2')).some((n) => n.course?.id === ids.courseA));
    assert.equal((await ok<Conversation>('assistant', 'GET', `/conversations/${ids.dmAssistant}`)).canPost, false);
    problem(await send('assistant', ids.dmAssistant!, '¿Sigues ahí?'), 409, 'RECIPIENT_UNAVAILABLE');
    assert.ok(!(await ok<{ contacts: Array<{ id: string }> }>('instructor', 'GET', `${A()}/messaging`)).contacts.some((c) => c.id === sessions.s2.userId));
    await ok('admin', 'PUT', `${A()}/enrollments/${ids.enroll_s2}`, { status: 'active' });
    assert.ok((await notificationsOf('s2')).some((n) => n.course?.id === ids.courseA), 'restored with the enrollment');

    await ok('admin', 'POST', `/users/${sessions.s1.userId}/deactivate`);
    assert.equal((await request('s1', 'GET', '/me/messaging/summary')).statusCode, 401);
    problem(await send('instructor', ids.dm!, '¿Hola?'), 409, 'RECIPIENT_UNAVAILABLE');
    assert.ok(!(await ok<{ contacts: Array<{ id: string }> }>('instructor', 'GET', `${A()}/messaging`)).contacts.some((c) => c.id === sessions.s1.userId));
    await ok('admin', 'POST', `/users/${sessions.s1.userId}/reactivate`);
    await login('s1');
  });

  it('10. unpublished courses have no messaging', async () => {
    problem(await request('s1', 'GET', `/courses/${ids.courseD}/messaging`), 404, 'NOT_FOUND');
    problem(await request('instructor', 'GET', `/courses/${ids.courseD}/messaging`), 403, 'MESSAGING_NOT_AVAILABLE');
    problem(await request('instructor', 'POST', `/courses/${ids.courseD}/conversations`, { recipientUserId: sessions.s1.userId }), 403, 'MESSAGING_NOT_AVAILABLE');
  });

  it('11. CSRF and Origin are enforced on every write', async () => {
    const noCsrf = (url: string, method: Method, body?: unknown) =>
      app.inject({ method, url: `/api/v1${url}`, cookies: { ap_session: sessions.s1.token }, headers: { origin: ORIGIN }, ...(body ? { payload: body as object } : {}) });
    problem(await noCsrf(`/conversations/${ids.dm}/messages`, 'POST', { body: 'x', clientMessageId: randomUUID() }), 403, 'CSRF_TOKEN_INVALID');
    problem(await noCsrf(`/conversations/${ids.dm}/read`, 'PUT', { upToSeq: 1 }), 403, 'CSRF_TOKEN_INVALID');
    problem(await noCsrf('/me/notifications/read-all', 'POST'), 403, 'CSRF_TOKEN_INVALID');
    problem(await noCsrf(`${A()}/conversations`, 'POST', { recipientUserId: sessions.instructor.userId }), 403, 'CSRF_TOKEN_INVALID');
    problem(await request('s1', 'POST', `/conversations/${ids.dm}/messages`, { body: 'x', clientMessageId: randomUUID() }, { origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
  });

  it('12. announcement notifications: on publication, hidden until a scheduled time, withdrawn on archive, never duplicated', async () => {
    const draft = await ok<{ id: string }>('instructor', 'POST', `${A()}/announcements`, { title: 'Aviso de prueba', body: 'Texto' }, 201);
    assert.ok(!(await notificationsOf('s1')).some((n) => n.data.title === 'Aviso de prueba'), 'drafts notify nobody');
    await ok('instructor', 'POST', `/announcements/${draft.id}/publish`, {});
    await ok('instructor', 'POST', `/announcements/${draft.id}/publish`, {});
    const notes = (await notificationsOf('s1')).filter((n) => n.type === 'announcement' && n.data.title === 'Aviso de prueba');
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.link, `/announcements/${draft.id}`);
    assert.ok(!(await notificationsOf('instructor')).some((n) => n.type === 'announcement'), 'not the author');
    assert.ok((await notificationsOf('assistant')).some((n) => n.data.title === 'Aviso de prueba'));

    const now = Date.now();
    const scheduled = await ok<{ id: string }>('instructor', 'POST', `${A()}/announcements`, { title: 'Programado', body: 'Más tarde' }, 201);
    await ok('instructor', 'POST', `/announcements/${scheduled.id}/publish`, { publishAt: new Date(now + 2 * 3_600_000).toISOString() });
    assert.ok(!(await notificationsOf('s1')).some((n) => n.data.title === 'Programado'), 'hidden until the publication time');
    pinned = new Date(now + 3 * 3_600_000);
    assert.ok((await notificationsOf('s1')).some((n) => n.data.title === 'Programado'), 'visible once the server clock reaches it');
    pinned = null;
    await ok('instructor', 'POST', `/announcements/${draft.id}/archive`);
    assert.ok(!(await notificationsOf('s1')).some((n) => n.data.title === 'Aviso de prueba'), 'withdrawn on archive');

    const institution = await ok<{ id: string }>('admin', 'POST', '/announcements', { title: 'Aviso institucional', body: 'Para todos' }, 201);
    await ok('admin', 'POST', `/announcements/${institution.id}/publish`, {});
    for (const who of ['s1', 'outsider', 'instructorB', 'reviewer'] as const) assert.ok((await notificationsOf(who)).some((n) => n.data.title === 'Aviso institucional'), who);
    assert.ok(!(await notificationsOf('admin')).some((n) => n.data.title === 'Aviso institucional'));
  });

  it('13. the notification center: own notifications only, pages, unread filter, mark read and mark all read', async () => {
    const all = await notificationsOf('s1');
    assert.ok(all.length >= 3);
    const first = await ok<{ items: Notification[]; nextCursor: string | null }>('s1', 'GET', '/me/notifications?limit=2');
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const next = await ok<{ items: Notification[] }>('s1', 'GET', `/me/notifications?limit=2&cursor=${first.nextCursor}`);
    assert.ok(!next.items.some((n) => first.items.some((m) => m.id === n.id)));
    const before = (await summary('s1')).unreadNotifications;
    const unread = await notificationsOf('s1', '&unread=true');
    assert.equal(unread.length, before);
    await ok('s1', 'PUT', `/me/notifications/${unread[0]!.id}/read`, undefined, 204);
    await ok('s1', 'PUT', `/me/notifications/${unread[0]!.id}/read`, undefined, 204);
    assert.equal((await summary('s1')).unreadNotifications, before - 1);
    assert.equal((await ok<{ updated: number }>('s1', 'POST', '/me/notifications/read-all')).updated, before - 1);
    assert.equal((await summary('s1')).unreadNotifications, 0);
    problem(await request('s2', 'PUT', `/me/notifications/${unread[0]!.id}/read`), 404, 'NOT_FOUND');
  });

  it('14. message text never reaches the logs', async () => {
    const lines: string[] = [];
    const logged = buildApp({
      config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN }),
      database: database.db,
      logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
    });
    await logged.ready();
    const secret = `texto-privado-${randomUUID()}`;
    const res = await logged.inject({
      method: 'POST',
      url: `/api/v1/conversations/${ids.dm}/messages`,
      cookies: { ap_session: sessions.instructor.token },
      headers: { origin: ORIGIN, 'x-csrf-token': sessions.instructor.csrf },
      payload: { body: secret, clientMessageId: randomUUID() },
    });
    assert.equal(res.statusCode, 201);
    await logged.close();
    assert.ok(lines.length > 0);
    assert.ok(!lines.join('\n').includes(secret));
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE metadata::text LIKE $1`, [`%${secret}%`]), 0);
  });
});

describe('notifications from grades, certificates and demo messages (demo dataset, PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let root: string;
  const env = () => ({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: join(root, 'documents') });
  const call = async (email: string, method: Method, url: string, body?: unknown) => {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD }, headers: { origin: ORIGIN } });
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: { ap_session: login.cookies.find((c) => c.name === 'ap_session')!.value },
      headers: { origin: ORIGIN, ...(method !== 'GET' ? { 'x-csrf-token': login.json().csrfToken } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, json: res.body ? res.json() : null };
  };
  const notes = async (email: string) => (await call(email, 'GET', '/me/notifications?limit=50')).json.items as Notification[];

  before(async () => {
    database = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'ap026-'));
    await seedDemo(database.db, { password: PASSWORD, env: env(), uploadFilesDir: null });
    app = buildApp({ config: { ...loadConfig(env()), loginRateLimit: { max: 1000, windowMs: 60_000 } }, database: database.db });
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('15. released grades notify the student, without values; unreleased work notifies nobody; a rerun adds nothing', async () => {
    const learner = await notes('learner.a@academiapath.example');
    const grades = learner.filter((n) => n.type === 'grade_released');
    assert.ok(grades.length >= 2, JSON.stringify(learner));
    for (const n of grades) {
      assert.deepEqual(Object.keys(n.data).sort(), ['activityTitle', 'courseCode']);
      assert.match(n.link, /^\/courses\/[0-9a-f-]{36}\/grades$/);
    }
    // learner.a's Project Management assignment was graded after the release: still unreleased.
    const pmf = grades.filter((n) => n.data.courseCode === 'PMF-2026-2-A');
    assert.ok(!pmf.some((n) => (n.data.activityTitle ?? '').startsWith('Draft a one-page')), JSON.stringify(pmf));
    const before = Number((await database.pool.query('SELECT count(*) AS n FROM notifications')).rows[0].n);
    await seedDemo(database.db, { password: PASSWORD, env: env(), uploadFilesDir: null });
    assert.equal(Number((await database.pool.query('SELECT count(*) AS n FROM notifications')).rows[0].n), before, 'a rerun creates no notification');
  });

  it('16. demo conversations notify their recipients; the instructor’s reply is unread for the demo student', async () => {
    const student = await notes('student@academiapath.example');
    assert.ok(student.some((n) => n.type === 'direct_message' && n.data.courseCode === 'ITIL4-F-2026-2-A'));
    assert.ok(student.some((n) => n.type === 'course_message'));
    assert.ok(student.some((n) => n.type === 'announcement'));
    const summary = (await call('student@academiapath.example', 'GET', '/me/messaging/summary')).json;
    assert.ok(summary.unreadMessages >= 1 && summary.unreadNotifications >= 1, JSON.stringify(summary));
    assert.ok(!(await notes('reviewer@academiapath.example')).some((n) => n.type === 'direct_message' || n.type === 'course_message'), 'design team: no messaging notifications');
  });

  it('17. an issued certificate notifies its student once', async () => {
    const courseId = (await database.pool.query("SELECT id FROM courses WHERE code = 'ITIL4-F-2026-2-A'")).rows[0].id as string;
    const learnerEmail = 'learner.a@academiapath.example';
    const progress = (await call(learnerEmail, 'GET', `/courses/${courseId}/progress`)).json;
    for (const section of progress.sections) {
      const detail = (await call(learnerEmail, 'GET', `/courses/${courseId}/sections/${section.sectionId}/progress`)).json;
      for (const activity of detail.activities) {
        if (!activity.completed && activity.completion === 'manual') assert.equal((await call(learnerEmail, 'PUT', `/courses/${courseId}/activities/${activity.activityId}/completion`)).status, 200);
      }
    }
    const instructor = 'instructor@academiapath.example';
    assert.equal((await call(instructor, 'PUT', `/courses/${courseId}/certificate-policy`, { expectedVersion: 0, enabled: true, requireCompletion: true, requireFinalGrade: false, minimumGradePercent: null, issuerName: 'AcademiaPath' })).status, 200);
    const learnerId = (await database.pool.query('SELECT id FROM users WHERE email = $1', [learnerEmail])).rows[0].id as string;
    const issued = await call(instructor, 'POST', `/courses/${courseId}/certificates`, { userId: learnerId });
    assert.equal(issued.status, 201, JSON.stringify(issued.json));
    assert.equal((await call(instructor, 'POST', `/courses/${courseId}/certificates`, { userId: learnerId })).status, 200);
    const certs = (await notes(learnerEmail)).filter((n) => n.type === 'certificate_issued');
    assert.equal(certs.length, 1);
    assert.equal(certs[0]!.link, `/certificates/${issued.json.id}`);
    assert.deepEqual(Object.keys(certs[0]!.data).sort(), ['courseCode', 'courseTitle']);
  });
});

