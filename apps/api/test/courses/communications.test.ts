/**
 * Announcements and the academic calendar (AP-025), against a temporary PostgreSQL database (skipped unless
 * TEST_DATABASE_URL is set). Synthetic users and a controlled API server clock. Tests run in order.
 *
 * Course A: instructor, non-editing instructor (assistant), design team (reviewer), students s1 and s2.
 * Course B: instructorB and outsider. A program manager holds a grant for the courses' program.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
const HOUR = 3_600_000;
const EMAILS = {
  admin: DEV_USERS[0]!.email,
  instructor: DEV_USERS[1]!.email,
  s1: DEV_USERS[2]!.email,
  reviewer: DEV_USERS[3]!.email,
  assistant: 'assistant@academiapath.example',
  s2: 'student2@academiapath.example',
  pm: 'program.manager@academiapath.example',
  instructorB: 'instructor2@academiapath.example',
  outsider: 'outsider@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Announcement = { id: string; status: string; pinned: boolean; read: boolean; title: string; body: string; publishAt: string | null; course: { id: string } | null };
type Page = { items: Announcement[]; nextCursor: string | null };
type Event = { id: string; status: string; startsAt: string; endsAt: string; startDate: string | null; endDate: string | null; timeZone: string; allDay: boolean };
type Calendar = { timeZone: string; events: Event[]; dueDates: Array<{ activityId: string; title: string; dueAt: string }> };

describe('announcements and academic calendar (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let pinned: Date | null = null;
  const sessions = {} as Record<Person, { token: string; csrf: string; userId: string }>;
  const ids = {} as Record<'courseA' | 'courseB' | 'welcome' | 'otherB' | 'draftB' | 'scheduled' | 'pinned' | 'reviewEvent' | 'termEnd' | 'kolkata' | 'allDay' | 'unsafe' | 'enroll_s2', string> & Record<string, string>;

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
  const A = () => `/courses/${ids.courseA}`;
  const B = () => `/courses/${ids.courseB}`;
  const unread = async (who: Person) => (await ok<{ unreadCount: number }>(who, 'GET', '/me/announcements/unread-count')).unreadCount;
  const feedIds = async (who: Person) => (await ok<Page>(who, 'GET', '/me/announcements?limit=100')).items.map((item) => item.id);
  const courseIds = async (who: Person, course = A(), query = '') => (await ok<Page>(who, 'GET', `${course}/announcements?limit=100${query}`)).items.map((item) => item.id);
  const announce = async (who: Person, course: string, title: string, extra: Record<string, unknown> = {}) =>
    ok<Announcement>(who, 'POST', `${course}/announcements`, { title, body: `${title} body`, ...extra }, 201);
  const publish = (who: Person, id: string, publishAt?: string) => ok<Announcement>(who, 'POST', `/announcements/${id}/publish`, publishAt ? { publishAt } : {});

  before(async () => {
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const passwordHash = await hashPassword(PASSWORD);
    for (const person of ['assistant', 's2', 'pm', 'instructorB', 'outsider'] as const) {
      const [user] = await database.db.insert(users).values({ email: EMAILS[person], givenName: 'Test', familyName: person }).returning();
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
      sessions[person] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
    }
    const program = await ok('admin', 'POST', '/programs', { code: 'COM', name: 'Comunicaciones' }, 201);
    const term = await ok('admin', 'POST', '/terms', { code: '2026-2', name: 'Semestre 2026-2', startsOn: '2026-08-17', endsOn: '2026-12-11' }, 201);
    const template = await ok('admin', 'POST', '/course-templates', { code: 'COM-T', programId: program.id, title: 'Comunicaciones', sections: [{ title: 'Unidad 1' }] }, 201);
    const course = async (code: string) => (await ok('admin', 'POST', '/courses', { programId: program.id, termId: term.id, templateId: template.templateId, code, status: 'published' }, 201)).id as string;
    ids.courseA = await course('COM-A');
    ids.courseB = await course('COM-B');
    const enroll = async (courseId: string, person: Person, role: string) => (await ok('admin', 'POST', `/courses/${courseId}/enrollments`, { email: EMAILS[person], role }, 201)).id as string;
    for (const [person, role] of [['instructor', 'instructor'], ['assistant', 'non_editing_instructor'], ['reviewer', 'design_team'], ['s1', 'student'], ['s2', 'student']] as const) {
      ids[`enroll_${person}`] = await enroll(ids.courseA, person, role);
    }
    for (const [person, role] of [['instructorB', 'instructor'], ['outsider', 'student'], ['reviewer', 'design_team']] as const) await enroll(ids.courseB, person, role);
    await ok('admin', 'POST', `/programs/${program.id}/managers`, { email: EMAILS.pm }, 201);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  it('1, 2, 4. an instructor creates and publishes; students see published announcements only, never drafts', async () => {
    const draft = await announce('instructor', A(), 'Bienvenida');
    assert.deepEqual([draft.status, draft.publishAt, draft.read], ['draft', null, false]);
    ids.welcome = draft.id;
    problem(await request('s1', 'GET', `/announcements/${draft.id}`), 404, 'NOT_FOUND');
    assert.deepEqual(await courseIds('s1'), []);
    assert.deepEqual([await unread('s1'), (await feedIds('s1')).length], [0, 0]);
    problem(await request('s1', 'PUT', `/announcements/${draft.id}/read`), 404, 'NOT_FOUND');
    // Staff readers (instructor, non-editing instructor) see drafts; the design team does not.
    assert.deepEqual(await courseIds('assistant'), [draft.id]);
    assert.deepEqual(await courseIds('reviewer'), []);
    const edited = await ok<Announcement>('instructor', 'PUT', `/announcements/${draft.id}`, { body: 'Bienvenidos al curso.\nRevisen el sílabo.' });
    assert.equal(edited.body, 'Bienvenidos al curso.\nRevisen el sílabo.');
    const published = await publish('instructor', draft.id);
    assert.equal(published.status, 'published');
    assert.deepEqual(await courseIds('s1'), [draft.id]);
    assert.deepEqual(await courseIds('reviewer'), [draft.id]);
    assert.equal((await ok<Announcement>('s1', 'GET', `/announcements/${draft.id}`)).title, 'Bienvenida');
    assert.deepEqual([await unread('s1'), await feedIds('s1')], [1, [draft.id]]);
    assert.equal((await publish('instructor', draft.id)).publishAt, published.publishAt, 'publishing again changes nothing');
  });

  it('3, 10. other courses’ announcements are not reachable, and counts include only the caller’s courses', async () => {
    const other = await announce('instructorB', B(), 'Solo curso B');
    await publish('instructorB', other.id);
    ids.otherB = other.id;
    for (const url of [`/announcements/${other.id}`]) problem(await request('s1', 'GET', url), 404, 'NOT_FOUND');
    problem(await request('s1', 'GET', `${B()}/announcements`), 404, 'NOT_FOUND');
    problem(await request('s1', 'PUT', `/announcements/${other.id}/read`), 404, 'NOT_FOUND');
    assert.ok(!(await feedIds('s1')).includes(other.id));
    assert.equal(await unread('s1'), 1);
    assert.deepEqual(await feedIds('outsider'), [other.id]);
    assert.equal(await unread('outsider'), 1);
    const hidden = await announce('instructorB', B(), 'Borrador B');
    assert.equal(await unread('outsider'), 1, 'drafts are never counted');
    ids.draftB = hidden.id;
  });

  it('5, 6. scheduled announcements stay invisible until the server time reaches them', async () => {
    // A whole second just ahead of the real clock, so earlier publications are already visible.
    const base = new Date(Math.ceil(Date.now() / 1000) * 1000 + 1000);
    pinned = base;
    const scheduled = await announce('instructor', A(), 'Examen parcial');
    const publishAt = new Date(base.getTime() + HOUR).toISOString();
    problem(await request('instructor', 'POST', `/announcements/${scheduled.id}/publish`, { publishAt: new Date(base.getTime() - 1000).toISOString() }), 422, 'PUBLISH_AT_INVALID');
    problem(await request('instructor', 'POST', `/announcements/${scheduled.id}/publish`, { publishAt: '2026-11-13T10:00:00' }), 400, 'VALIDATION_ERROR');
    const result = await publish('instructor', scheduled.id, publishAt);
    assert.equal(result.status, 'scheduled');
    ids.scheduled = scheduled.id;
    const invisible = async () => {
      problem(await request('s1', 'GET', `/announcements/${scheduled.id}`), 404, 'NOT_FOUND');
      assert.ok(!(await courseIds('s1')).includes(scheduled.id));
      assert.ok(!(await feedIds('s1')).includes(scheduled.id));
      assert.equal(await unread('s1'), 1);
    };
    await invisible();
    assert.deepEqual(await courseIds('instructor', A(), '&status=scheduled'), [scheduled.id]);
    pinned = new Date(Date.parse(publishAt) - 1);
    await invisible();
    pinned = new Date(publishAt);
    assert.equal((await ok<Announcement>('s1', 'GET', `/announcements/${scheduled.id}`)).status, 'published', 'visible at the exact publication time');
    assert.equal(await unread('s1'), 2);
    // Unscheduling only applies before publication.
    problem(await request('instructor', 'POST', `/announcements/${scheduled.id}/unschedule`), 409, 'ANNOUNCEMENT_NOT_SCHEDULED');
    pinned = null;
    const later = await announce('instructor', A(), 'Recordatorio');
    await publish('instructor', later.id, new Date(Date.now() + 2 * HOUR).toISOString());
    assert.equal((await ok<Announcement>('instructor', 'POST', `/announcements/${later.id}/unschedule`)).status, 'draft');
  });

  it('8. pinned announcements come first, then the newest; pages continue in the same order', async () => {
    const created: string[] = [];
    for (const [index, title] of ['Uno', 'Dos', 'Tres'].entries()) {
      pinned = new Date(Date.now() + (index + 1) * 60_000);
      const item = await announce('instructor', A(), title);
      await publish('instructor', item.id);
      created.push(item.id);
    }
    pinned = new Date(Date.now() + 10 * 60_000);
    await ok('instructor', 'PUT', `/announcements/${created[0]}`, { pinned: true });
    const order = await courseIds('s1');
    // The scheduled announcement (an hour ahead) is not visible yet at this server time.
    assert.deepEqual(order, [created[0], created[2], created[1], ids.welcome]);
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const next: Page = await ok<Page>('s1', 'GET', `${A()}/announcements?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      paged.push(...next.items.map((item) => item.id));
      cursor = next.nextCursor;
    } while (cursor);
    assert.deepEqual(paged, order, 'pagination keeps the same order');
    problem(await request('s1', 'GET', `${A()}/announcements?cursor=abc`), 400, 'INVALID_CURSOR');
    ids.pinned = created[0]!;
  });

  it('9. read marks persist across sessions and repeated marks change nothing', async () => {
    const before = await unread('s1');
    for (let i = 0; i < 3; i++) assert.equal((await request('s1', 'PUT', `/announcements/${ids.welcome}/read`)).statusCode, 204);
    assert.equal(await unread('s1'), before - 1);
    assert.equal(await count('SELECT count(*)::int AS n FROM announcement_reads WHERE announcement_id = $1', [ids.welcome]), 1);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAILS.s1, password: PASSWORD }, headers: { origin: ORIGIN } });
    sessions.s1 = { token: login.cookies.find((c) => c.name === 'ap_session')!.value, csrf: login.json().csrfToken, userId: login.json().user.id };
    assert.equal((await ok<Announcement>('s1', 'GET', `/announcements/${ids.welcome}`)).read, true, 'still read in a new session');
    assert.equal(await unread('s2'), before, 'read marks are per user');
  });

  it('7. archived announcements leave every student list and cannot change', async () => {
    const archived = await ok<Announcement>('instructor', 'POST', `/announcements/${ids.pinned}/archive`);
    assert.deepEqual([archived.status, archived.pinned], ['archived', false]);
    problem(await request('s1', 'GET', `/announcements/${ids.pinned}`), 404, 'NOT_FOUND');
    assert.ok(!(await courseIds('s1')).includes(ids.pinned));
    assert.ok(!(await feedIds('s1')).includes(ids.pinned));
    assert.deepEqual(await courseIds('assistant', A(), '&status=archived'), [ids.pinned]);
    problem(await request('instructor', 'PUT', `/announcements/${ids.pinned}`, { title: 'X' }), 409, 'ANNOUNCEMENT_ARCHIVED');
    problem(await request('instructor', 'POST', `/announcements/${ids.pinned}/publish`, {}), 409, 'ANNOUNCEMENT_ARCHIVED');
    await assert.rejects(database.pool.query('DELETE FROM announcements WHERE id = $1', [ids.pinned]), /archived, never deleted/);
  });

  it('11. a deactivated enrollment loses access to the course’s announcements and events at once', async () => {
    const event = await ok<Event>('instructor', 'POST', `${A()}/calendar/events`, { title: 'Sesión de repaso', allDay: false, startsAt: new Date(Date.now() + 24 * HOUR).toISOString(), endsAt: new Date(Date.now() + 26 * HOUR).toISOString(), status: 'published' }, 201);
    ids.reviewEvent = event.id;
    const visibleBefore = await feedIds('s2');
    assert.ok(visibleBefore.includes(ids.welcome) && (await unread('s2')) > 0);
    await ok('admin', 'PUT', `${A()}/enrollments/${ids.enroll_s2}`, { status: 'inactive' });
    problem(await request('s2', 'GET', `${A()}/announcements`), 404, 'NOT_FOUND');
    problem(await request('s2', 'GET', `/announcements/${ids.welcome}`), 404, 'NOT_FOUND');
    problem(await request('s2', 'GET', `/calendar/events/${event.id}`), 404, 'NOT_FOUND');
    problem(await request('s2', 'GET', `/me/calendar?courseId=${ids.courseA}`), 404, 'NOT_FOUND');
    assert.deepEqual([await feedIds('s2'), await unread('s2')], [[], 0]);
    assert.ok(!(await ok<Calendar>('s2', 'GET', '/me/calendar')).events.some((e) => e.id === event.id));
    await ok('admin', 'PUT', `${A()}/enrollments/${ids.enroll_s2}`, { status: 'active' });
    assert.ok((await feedIds('s2')).includes(ids.welcome));
  });

  it('12, 13, 14. non-editing instructors, the design team and program managers cannot write; administrators can', async () => {
    const event = { title: 'X', allDay: true, startDate: '2026-11-20', endDate: '2026-11-20', status: 'published' };
    for (const who of ['assistant', 'reviewer', 's1'] as const) {
      problem(await request(who, 'POST', `${A()}/announcements`, { title: 'X', body: 'Y' }), 403, 'FORBIDDEN');
      problem(await request(who, 'PUT', `/announcements/${ids.welcome}`, { title: 'X' }), 403, 'FORBIDDEN');
      problem(await request(who, 'POST', `/announcements/${ids.welcome}/archive`), 403, 'FORBIDDEN');
      problem(await request(who, 'POST', `${A()}/calendar/events`, event), 403, 'FORBIDDEN');
      problem(await request(who, 'POST', `/calendar/events/${ids.reviewEvent}/cancel`), 403, 'FORBIDDEN');
    }
    problem(await request('assistant', 'POST', `/announcements/${ids.scheduled}/publish`, {}), 403, 'FORBIDDEN');
    problem(await request('pm', 'POST', `${A()}/announcements`, { title: 'X', body: 'Y' }), 404, 'NOT_FOUND');
    problem(await request('pm', 'GET', `${A()}/announcements`), 404, 'NOT_FOUND');
    problem(await request('pm', 'POST', `${A()}/calendar/events`, event), 404, 'NOT_FOUND');
    for (const who of ['instructor', 'assistant', 's1', 'pm'] as const) {
      problem(await request(who, 'POST', '/announcements', { title: 'X', body: 'Y' }), 403, 'FORBIDDEN');
      problem(await request(who, 'POST', '/calendar/events', event), 403, 'FORBIDDEN');
    }
    // Administrators: institution-wide content, and course content through the override.
    const institutional = await ok<Announcement>('admin', 'POST', '/announcements', { title: 'Cierre del semestre', body: 'Las notas finales se publican el 11 de diciembre.' }, 201);
    // A draft institution announcement does not exist for non-administrators (404, nothing leaks).
    problem(await request('instructor', 'POST', `/announcements/${institutional.id}/publish`, {}), 404, 'NOT_FOUND');
    problem(await request('s1', 'GET', `/announcements/${institutional.id}`), 404, 'NOT_FOUND');
    await publish('admin', institutional.id);
    problem(await request('instructor', 'POST', `/announcements/${institutional.id}/archive`), 403, 'FORBIDDEN');
    for (const who of ['s1', 'outsider', 'assistant'] as const) assert.ok((await feedIds(who)).includes(institutional.id), who);
    assert.ok((await ok<Page>('outsider', 'GET', '/announcements')).items.some((item) => item.id === institutional.id));
    const course = await announce('admin', A(), 'Aviso administrativo');
    assert.equal((await publish('admin', course.id)).status, 'published');
    const termEnd = await ok<Event>('admin', 'POST', '/calendar/events', { title: 'Fin del semestre', allDay: true, startDate: '2026-12-11', endDate: '2026-12-11', status: 'published' }, 201);
    ids.termEnd = termEnd.id;
  });

  it('15, 16. event times: validated on the server, explicit time zones, all-day dates', async () => {
    const post = (body: Record<string, unknown>) => request('instructor', 'POST', `${A()}/calendar/events`, { title: 'Prueba', status: 'hidden', ...body });
    problem(await post({ allDay: false, startsAt: '2026-11-13T19:00:00-05:00', endsAt: '2026-11-13T18:00:00-05:00' }), 422, 'EVENT_TIME_INVALID');
    problem(await post({ allDay: false, startsAt: '2026-11-13T19:00:00-05:00', endsAt: '2026-11-13T19:00:00-05:00' }), 422, 'EVENT_TIME_INVALID');
    problem(await post({ allDay: false, startsAt: '2026-11-13T19:00:00', endsAt: '2026-11-13T20:00:00' }), 400, 'VALIDATION_ERROR');
    problem(await post({ allDay: false, startsAt: '2026-11-13T19:00:00-05:00', endsAt: '2026-11-13T20:00:00-05:00', timeZone: 'Mars/Olympus' }), 422, 'INVALID_TIME_ZONE');
    problem(await post({ allDay: true, startDate: '2026-11-14', endDate: '2026-11-13' }), 422, 'EVENT_TIME_INVALID');
    problem(await post({ allDay: true, startDate: '2026-02-30', endDate: '2026-03-01' }), 422, 'EVENT_TIME_INVALID');
    problem(await post({ allDay: true, startDate: '2026-11-13', endDate: '2026-11-13', startsAt: '2026-11-13T19:00:00Z' }), 400, 'VALIDATION_ERROR');
    problem(await post({ allDay: false, startsAt: '2026-11-13T19:00:00Z', endsAt: '2027-11-15T19:00:00Z' }), 422, 'EVENT_TIME_INVALID');
    // A timed event sent with an offset is stored as the UTC instant; the time zone is kept for display.
    const timed = await ok<Event>('instructor', 'POST', `${A()}/calendar/events`, { title: 'Clase en vivo', allDay: false, startsAt: '2026-11-13T19:00:00-05:00', endsAt: '2026-11-13T20:30:00-05:00', status: 'published' }, 201);
    assert.deepEqual([timed.startsAt, timed.endsAt, timed.timeZone, timed.startDate], ['2026-11-14T00:00:00.000Z', '2026-11-14T01:30:00.000Z', 'America/Lima', null]);
    // All-day: the dates in the event's time zone (default the institution's, America/Lima).
    const allDay = await ok<Event>('instructor', 'POST', `${A()}/calendar/events`, { title: 'Feriado', allDay: true, startDate: '2026-12-08', endDate: '2026-12-08', status: 'published' }, 201);
    assert.deepEqual([allDay.startsAt, allDay.endsAt, allDay.startDate, allDay.endDate], ['2026-12-08T05:00:00.000Z', '2026-12-09T05:00:00.000Z', '2026-12-08', '2026-12-08']);
    const kolkata = await ok<Event>('instructor', 'POST', `${A()}/calendar/events`, { title: 'Webinar', allDay: true, startDate: '2026-12-09', endDate: '2026-12-10', timeZone: 'Asia/Kolkata', status: 'hidden' }, 201);
    assert.deepEqual([kolkata.startsAt, kolkata.endsAt], ['2026-12-08T18:30:00.000Z', '2026-12-10T18:30:00.000Z']);
    // Range queries use the instants: Lima 13 November contains the 19:00 class (stored as 14 November UTC).
    const day = await ok<Calendar>('s1', 'GET', `${A()}/calendar?from=2026-11-13T00:00:00-05:00&to=2026-11-14T00:00:00-05:00`);
    // Test 11's review session is scheduled 24 hours from now, so on 12 November 2026 it also falls on this day:
    // only the events created here are compared.
    assert.deepEqual(day.events.map((e) => e.id).filter((id) => id !== ids.reviewEvent), [timed.id]);
    assert.equal(day.timeZone, 'America/Lima');
    problem(await request('s1', 'GET', `${A()}/calendar?from=2026-11-14T00:00:00Z&to=2026-11-13T00:00:00Z`), 422, 'RANGE_INVALID');
    problem(await request('s1', 'GET', `${A()}/calendar?from=2026-01-01T00:00:00Z&to=2027-06-01T00:00:00Z`), 422, 'RANGE_INVALID');
    ids.kolkata = kolkata.id;
    ids.allDay = allDay.id;
  });

  it('17. hidden events never leak; cancelled events stay visible as cancelled; published events are never deleted', async () => {
    const range = 'from=2026-12-01T00:00:00Z&to=2026-12-31T00:00:00Z';
    problem(await request('s1', 'GET', `/calendar/events/${ids.kolkata}`), 404, 'NOT_FOUND');
    assert.ok(!(await ok<Calendar>('s1', 'GET', `${A()}/calendar?${range}`)).events.some((e) => e.id === ids.kolkata));
    assert.ok(!(await ok<Calendar>('s1', 'GET', `/me/calendar?${range}`)).events.some((e) => e.id === ids.kolkata));
    assert.ok((await ok<Calendar>('assistant', 'GET', `${A()}/calendar?${range}`)).events.some((e) => e.id === ids.kolkata), 'non-editing instructors read hidden events');
    const institution = await ok<{ items: Event[] }>('s1', 'GET', `/calendar/events?${range}`);
    assert.deepEqual(institution.items.map((e) => e.id), [ids.termEnd]);
    // Cancel a published event: kept and shown as cancelled; it cannot be deleted or edited.
    const cancelled = await ok<Event>('instructor', 'POST', `/calendar/events/${ids.allDay}/cancel`);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await ok<Event>('s1', 'GET', `/calendar/events/${ids.allDay}`)).status, 'cancelled');
    problem(await request('instructor', 'DELETE', `/calendar/events/${ids.allDay}`), 409, 'EVENT_WAS_PUBLISHED');
    problem(await request('instructor', 'PUT', `/calendar/events/${ids.allDay}`, { title: 'X', allDay: true, startDate: '2026-12-08', endDate: '2026-12-08', status: 'published' }), 409, 'EVENT_CANCELLED');
    await assert.rejects(database.pool.query('DELETE FROM calendar_events WHERE id = $1', [ids.allDay]), /can only be cancelled/);
    // Publishing then hiding keeps it undeletable; a never-published event can be deleted (audited).
    await ok('instructor', 'PUT', `/calendar/events/${ids.kolkata}`, { title: 'Webinar internacional', allDay: true, startDate: '2026-12-09', endDate: '2026-12-10', timeZone: 'Asia/Kolkata', status: 'hidden' });
    assert.equal((await request('instructor', 'DELETE', `/calendar/events/${ids.kolkata}`)).statusCode, 204);
    assert.equal(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'calendar_event.deleted' AND entity_id = $1", [ids.kolkata]), 1);
  });

  it('18. cross-course event and announcement changes are denied', async () => {
    const event = { title: 'Ajeno', allDay: true, startDate: '2026-11-25', endDate: '2026-11-25', status: 'published' };
    problem(await request('instructorB', 'PUT', `/calendar/events/${ids.reviewEvent}`, event), 404, 'NOT_FOUND');
    problem(await request('instructorB', 'POST', `/calendar/events/${ids.reviewEvent}/cancel`), 404, 'NOT_FOUND');
    problem(await request('instructorB', 'DELETE', `/calendar/events/${ids.reviewEvent}`), 404, 'NOT_FOUND');
    problem(await request('instructorB', 'PUT', `/announcements/${ids.welcome}`, { title: 'X' }), 404, 'NOT_FOUND');
    problem(await request('instructor', 'POST', `${B()}/calendar/events`, event), 404, 'NOT_FOUND');
    problem(await request('instructor', 'POST', `${B()}/announcements`, { title: 'X', body: 'Y' }), 404, 'NOT_FOUND');
    problem(await request('instructor', 'POST', `/announcements/${ids.draftB}/publish`, {}), 404, 'NOT_FOUND');
    problem(await request('instructor', 'POST', '/calendar/events/' + ids.termEnd + '/cancel'), 403, 'FORBIDDEN');
  });

  it('19, 20. text is stored and returned as plain text; CSRF and Origin are enforced', async () => {
    const unsafe = '<script>alert(1)</script><img src=x onerror=alert(2)> & "quotes"';
    const res = await request('instructor', 'POST', `${A()}/announcements`, { title: '<b>Título</b>', body: unsafe });
    assert.equal(res.statusCode, 201);
    assert.match(String(res.headers['content-type']), /^application\/json/);
    assert.deepEqual([res.json().title, res.json().body], ['<b>Título</b>', unsafe], 'returned verbatim as JSON text, never as markup');
    ids.unsafe = res.json().id;
    await publish('instructor', ids.unsafe);
    problem(await request('instructor', 'POST', `${A()}/announcements`, { title: 'X', body: 'Y' }, { origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
    const noCsrf = await app.inject({ method: 'POST', url: `/api/v1${A()}/announcements`, cookies: { ap_session: sessions.instructor.token }, headers: { origin: ORIGIN }, payload: { title: 'X', body: 'Y' } });
    problem(noCsrf, 403, 'CSRF_TOKEN_INVALID');
    const readNoCsrf = await app.inject({ method: 'PUT', url: `/api/v1/announcements/${ids.welcome}/read`, cookies: { ap_session: sessions.s2.token }, headers: { origin: ORIGIN } });
    problem(readNoCsrf, 403, 'CSRF_TOKEN_INVALID');
    for (const url of ['/me/announcements', '/me/announcements/unread-count', '/me/calendar', `${A()}/announcements`]) problem(await request(null, 'GET', url), 401, 'UNAUTHENTICATED');
    problem(await request('instructor', 'POST', `${A()}/announcements`, { title: 'x'.repeat(201), body: 'Y' }), 400, 'VALIDATION_ERROR');
    problem(await request('instructor', 'POST', `${A()}/announcements`, { title: 'X', body: 'y'.repeat(10001) }), 400, 'VALIDATION_ERROR');
  });

  it('21. every write is audited with its actor', async () => {
    const actions = (await database.pool.query("SELECT action, count(*)::int AS n FROM audit_log WHERE action LIKE 'announcement.%' OR action LIKE 'calendar_event.%' GROUP BY action ORDER BY action")).rows;
    const byAction = Object.fromEntries(actions.map((row: { action: string; n: number }) => [row.action, row.n]));
    for (const action of ['announcement.created', 'announcement.updated', 'announcement.published', 'announcement.scheduled', 'announcement.unscheduled', 'announcement.archived', 'calendar_event.created', 'calendar_event.updated', 'calendar_event.cancelled', 'calendar_event.deleted']) {
      assert.ok((byAction[action] ?? 0) >= 1, `${action} audited`);
    }
    const [archive] = (await database.pool.query("SELECT actor_user_id AS actor, metadata FROM audit_log WHERE action = 'announcement.archived' AND entity_id = $1", [ids.pinned])).rows;
    assert.deepEqual([archive.actor, archive.metadata.after.status], [sessions.instructor.userId, 'archived']);
    assert.equal(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'announcement.published' AND entity_id = $1", [ids.welcome]), 1, 'an idempotent re-publish is not audited again');
  });

  it('assignment due dates appear only from approved assignments students can open; quizzes have none', async () => {
    const section = (await ok('admin', 'GET', `${A()}/sections`)).items[0].id;
    const dueAt = new Date(Date.now() + 3 * 24 * HOUR).toISOString();
    const assignment = await ok('instructor', 'POST', `${A()}/sections/${section}/activities`, { type: 'assignment', title: 'Ensayo final', instructions: 'Escribe.', dueAt, rubric: [{ title: 'Contenido', maxPoints: 10 }] }, 201);
    const unapproved = await ok('instructor', 'POST', `${A()}/sections/${section}/activities`, { type: 'assignment', title: 'Borrador de tarea', instructions: 'Escribe.', dueAt, rubric: [{ title: 'Contenido', maxPoints: 10 }] }, 201);
    await ok('instructor', 'POST', `${A()}/activities/${assignment.id}/submit`);
    await ok('reviewer', 'POST', `${A()}/activities/${assignment.id}/review`, { decision: 'approve' });
    const mine = await ok<Calendar>('s1', 'GET', '/me/calendar');
    assert.deepEqual(mine.dueDates.map((d) => [d.title, d.dueAt]), [['Ensayo final', new Date(dueAt).toISOString()]]);
    assert.ok(!mine.dueDates.some((d) => d.activityId === unapproved.id), 'unapproved work has no due date on the calendar');
    assert.deepEqual((await ok<Calendar>('s1', 'GET', `${A()}/calendar`)).dueDates.map((d) => d.activityId), [assignment.id]);
    assert.deepEqual((await ok<Calendar>('outsider', 'GET', '/me/calendar')).dueDates, []);
  });
});
