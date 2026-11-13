/**
 * Hybrid teaching sessions (AP-045): optional session details on course calendar events. Against temporary
 * PostgreSQL databases (skipped unless TEST_DATABASE_URL is set); synthetic users. Tests run in order.
 *
 * Course A (published) has four visible units (Unidad 1–4) and a hidden one, an approved reading in Unidad 2 and a
 * draft in Unidad 3. Six sessions cover the four units (sessions 5 and 6 are final presentations without units).
 * Course B belongs to another instructor and has its own unit and activity. A second database checks migration
 * 0034 against calendar events created before it.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { checkJoinUrl } from '../../src/calendar/sessions.js';
import { loadConfig } from '../../src/config.js';
import { userCredentials, users } from '../../src/db/schema/index.js';
import { createTestDatabase, migrationsFolder, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const EMAILS = {
  admin: DEV_USERS[0]!.email,
  instructor: DEV_USERS[1]!.email,
  s1: DEV_USERS[2]!.email,
  reviewer: DEV_USERS[3]!.email,
  assistant: 'sessions.assistant@academiapath.example',
  s2: 'sessions.student2@academiapath.example',
  instructorB: 'sessions.instructor2@academiapath.example',
  outsider: 'sessions.outsider@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Session = { token: string; csrf: string; userId: string };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type SessionView = { number: number; deliveryMode: string; joinUrl: string | null; units: Array<{ id: string; title: string }>; activity: { id: string; title: string; type: string } | null };
type Event = { id: string; title: string; status: string; startsAt: string; endsAt: string; timeZone: string; allDay: boolean; startDate: string | null; session: SessionView | null };
type Calendar = { timeZone: string; events: Event[] };

const MEET = 'https://meet.example.edu/clase-ia?pwd=Sintetico1';

describe('teaching session links (AP-045)', () => {
  it('accepts external https:// classroom links only', () => {
    assert.equal(checkJoinUrl('https://zoom.example.com/j/123?pwd=abc'), 'https://zoom.example.com/j/123?pwd=abc');
    assert.equal(checkJoinUrl('  HTTPS://Meet.Example.EDU/abc  '), 'https://meet.example.edu/abc', 'normalized scheme and host');
    assert.equal(checkJoinUrl('   '), null, 'empty means no link');
    for (const bad of ['http://zoom.example.com/j/1', 'javascript:alert(1)', 'https://', 'https://user:secret@zoom.example.com/j/1', 'https://zoom.example.com/j/1 2', 'ftp://files.example.com', 'zoom.example.com/j/1', 'data:text/html,hi', `https://example.com/${'a'.repeat(2000)}`]) {
      assert.throws(() => checkJoinUrl(bad), (error: { code?: string }) => error.code === 'SESSION_JOIN_URL_INVALID', bad);
    }
  });
});

describe('teaching sessions (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  const as = {} as Record<Person, Session>;
  const ids = {} as Record<'courseA' | 'courseB' | 'foreignUnit' | 'reading' | 'draft' | 'foreignActivity', string>;
  const unit: string[] = [];
  const sessions: Event[] = [];

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
  const A = () => `/courses/${ids.courseA}`;
  /** A weekly 19:00–21:00 (Lima) slot: week 1 starts on Monday 2027-03-15. */
  const slot = (week: number) => {
    const day = 15 + (week - 1) * 7;
    const date = new Date(Date.UTC(2027, 2, day)).toISOString().slice(0, 10);
    return { startsAt: `${date}T19:00:00-05:00`, endsAt: `${date}T21:00:00-05:00` };
  };
  const event = (title: string, week: number, session?: unknown, status = 'published') => ({ title, allDay: false, ...slot(week), timeZone: 'America/Lima', status, ...(session !== undefined ? { session } : {}) });
  const range = '?from=2027-03-01T00:00:00Z&to=2027-06-01T00:00:00Z';
  const calendar = (who: Person, course = A()) => ok<Calendar>(who, 'GET', `${course}/calendar${range}`);

  before(async () => {
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const passwordHash = await hashPassword(PASSWORD);
    for (const person of ['assistant', 's2', 'instructorB', 'outsider'] as const) {
      const [user] = await database.db.insert(users).values({ email: EMAILS[person], givenName: `Luis ${person}`, familyName: 'Ccori' }).returning();
      await database.db.insert(userCredentials).values({ userId: user!.id, passwordHash });
    }
    app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000' }), database: database.db });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAILS[person], password: PASSWORD }, headers: { origin: ORIGIN } });
      assert.equal(res.statusCode, 200, res.body);
      as[person] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
    }
    const program = await ok('admin', 'POST', '/programs', { code: 'HYB', name: 'Programa Híbrido' }, 201);
    const term = await ok('admin', 'POST', '/terms', { code: '2027-1', name: 'Semestre 2027-1', startsOn: '2027-03-08', endsOn: '2027-07-09' }, 201);
    const templateA = await ok('admin', 'POST', '/course-templates', {
      code: 'HYB-T',
      programId: program.id,
      title: 'Gestión de Proyectos',
      sections: [{ title: 'Unidad 1' }, { title: 'Unidad 2' }, { title: 'Unidad 3' }, { title: 'Unidad 4' }, { title: 'Unidad oculta', isVisible: false }],
    }, 201);
    const templateB = await ok('admin', 'POST', '/course-templates', { code: 'HYB-TB', programId: program.id, title: 'Otro curso', sections: [{ title: 'Unidad ajena' }] }, 201);
    ids.courseA = (await ok('admin', 'POST', '/courses', { programId: program.id, termId: term.id, templateId: templateA.templateId, code: 'HYB-A', status: 'published' }, 201)).id;
    ids.courseB = (await ok('admin', 'POST', '/courses', { programId: program.id, termId: term.id, templateId: templateB.templateId, code: 'HYB-B', status: 'published' }, 201)).id;
    const enroll = (courseId: string, person: Person, role: string) => ok('admin', 'POST', `/courses/${courseId}/enrollments`, { email: EMAILS[person], role }, 201);
    for (const [person, role] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['assistant', 'non_editing_instructor'], ['s1', 'student']] as const) await enroll(ids.courseA, person, role);
    for (const [person, role] of [['instructorB', 'instructor'], ['reviewer', 'design_team'], ['s2', 'student']] as const) await enroll(ids.courseB, person, role);
    const sectionsA = (await ok<{ items: Array<{ id: string; title: string }> }>('admin', 'GET', `${A()}/sections`)).items;
    unit.push(...sectionsA.map((section) => section.id));
    ids.foreignUnit = (await ok<{ items: Array<{ id: string }> }>('admin', 'GET', `/courses/${ids.courseB}/sections`)).items[0]!.id;
    ids.reading = (await ok('instructor', 'POST', `${A()}/sections/${unit[1]}/activities`, { type: 'page', title: 'Lectura asíncrona', body: 'Material sintético.' }, 201)).id;
    await ok('instructor', 'POST', `${A()}/activities/${ids.reading}/submit`);
    await ok('reviewer', 'POST', `${A()}/activities/${ids.reading}/review`, { decision: 'approve' });
    ids.draft = (await ok('instructor', 'POST', `${A()}/sections/${unit[2]}/activities`, { type: 'page', title: 'Borrador interno', body: 'Sin aprobar.' }, 201)).id;
    ids.foreignActivity = (await ok('instructorB', 'POST', `/courses/${ids.courseB}/sections/${ids.foreignUnit}/activities`, { type: 'page', title: 'Ajena', body: 'Otro curso.' }, 201)).id;
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  it('four units across six sessions: units and sessions are independent; ordinary events stay ordinary', async () => {
    const plan: Array<[string, unknown]> = [
      ['Sesión 1: introducción', { number: 1, deliveryMode: 'live_online', joinUrl: MEET, unitIds: [unit[0]] }],
      ['Sesión 2: estudio guiado', { number: 2, deliveryMode: 'asynchronous', unitIds: [unit[0], unit[1]], activityId: ids.reading }],
      ['Sesión 3: planificación', { number: 3, deliveryMode: 'live_online', joinUrl: MEET, unitIds: [unit[1], unit[2]] }],
      ['Sesión 4: control', { number: 4, deliveryMode: 'live_online', joinUrl: MEET, unitIds: [unit[2], unit[3]] }],
      ['Sesión 5: presentaciones finales', { number: 5, deliveryMode: 'presentation', joinUrl: MEET }],
      ['Sesión 6: presentaciones finales', { number: 6, deliveryMode: 'presentation' }],
    ];
    for (const [index, [title, session]] of plan.entries()) sessions.push(await ok<Event>('instructor', 'POST', `${A()}/calendar/events`, event(title, index + 1, session), 201));
    const ordinary = await ok<Event>('instructor', 'POST', `${A()}/calendar/events`, event('Feriado: sin clases', 2), 201);
    assert.equal(ordinary.session, null, 'an event without session details is an ordinary event');

    const view = await calendar('s1');
    const listed = view.events.filter((e) => e.session).map((e) => e.session!);
    assert.deepEqual(listed.map((s) => s.number), [1, 2, 3, 4, 5, 6], 'six sessions, in date order');
    assert.equal(view.events.length, 7, 'plus the ordinary event');
    const unitsOf = (n: number) => listed.find((s) => s.number === n)!.units.map((u) => u.title);
    assert.deepEqual([unitsOf(1), unitsOf(2), unitsOf(3), unitsOf(4), unitsOf(5), unitsOf(6)], [['Unidad 1'], ['Unidad 1', 'Unidad 2'], ['Unidad 2', 'Unidad 3'], ['Unidad 3', 'Unidad 4'], [], []]);
    const covering = (title: string) => listed.filter((s) => s.units.some((u) => u.title === title)).map((s) => s.number);
    assert.deepEqual(covering('Unidad 1'), [1, 2], 'one unit across several sessions');
    assert.equal(new Set(listed.flatMap((s) => s.units.map((u) => u.id))).size, 4, 'four units over six sessions');
    assert.deepEqual(listed.map((s) => s.deliveryMode), ['live_online', 'asynchronous', 'live_online', 'live_online', 'presentation', 'presentation']);
    assert.deepEqual(listed[1]!.activity, { id: ids.reading, title: 'Lectura asíncrona', type: 'page' }, 'the asynchronous session links its course activity');
    assert.equal(listed[1]!.joinUrl, null);
    assert.deepEqual(listed.map((s) => s.joinUrl), [MEET, null, MEET, MEET, MEET, null], 'students get the classroom link of published live and presentation sessions');
  });

  it('timezone: wall times in the event zone are stored as UTC instants; all-day asynchronous sessions use dates', async () => {
    const first = sessions[0]!;
    assert.equal(first.startsAt, '2027-03-16T00:00:00.000Z', '19:00 in Lima (UTC−5) is 00:00 UTC the next day');
    assert.equal(first.timeZone, 'America/Lima');
    const allDay = await ok<Event>('instructor', 'POST', `${A()}/calendar/events`, { title: 'Sesión 7: lectura libre', allDay: true, startDate: '2027-05-03', endDate: '2027-05-04', timeZone: 'America/Lima', status: 'published', session: { number: 7, deliveryMode: 'asynchronous', unitIds: [unit[3]] } }, 201);
    assert.deepEqual([allDay.allDay, allDay.startDate, allDay.startsAt, allDay.session!.number], [true, '2027-05-03', '2027-05-03T05:00:00.000Z', 7]);
    problem(await request('instructor', 'POST', `${A()}/calendar/events`, { ...event('Rango inválido', 9, { number: 9, deliveryMode: 'live_online' }), endsAt: slot(9).startsAt }), 422, 'EVENT_TIME_INVALID');
    problem(await request('instructor', 'POST', `${A()}/calendar/events`, { ...event('Zona inválida', 9, { number: 9, deliveryMode: 'live_online' }), timeZone: 'Mars/Olympus' }), 422, 'INVALID_TIME_ZONE');
  });

  it('live versus asynchronous delivery, classroom links, numbers and modes are validated', async () => {
    const create = (session: unknown, title = 'Sesión inválida') => request('instructor', 'POST', `${A()}/calendar/events`, event(title, 10, session));
    problem(await create({ number: 10, deliveryMode: 'asynchronous', joinUrl: MEET }), 422, 'SESSION_JOIN_URL_INVALID');
    for (const joinUrl of ['http://meet.example.edu/x', 'javascript:alert(1)', 'https://user:pw@meet.example.edu/x', 'meet.example.edu/x']) problem(await create({ number: 10, deliveryMode: 'live_online', joinUrl }), 422, 'SESSION_JOIN_URL_INVALID');
    problem(await create({ number: 10, deliveryMode: 'live_online', joinUrl: `https://x.example/${'a'.repeat(2000)}` }), 400, 'VALIDATION_ERROR');
    for (const session of [{ number: 0, deliveryMode: 'live_online' }, { number: 1000, deliveryMode: 'live_online' }, { number: 2.5, deliveryMode: 'live_online' }, { number: 10, deliveryMode: 'in_person' }, { number: 10 }, { deliveryMode: 'live_online' }, { number: 10, deliveryMode: 'live_online', unitIds: [unit[0], unit[0]] }, { number: 10, deliveryMode: 'live_online', extra: true }]) {
      problem(await create(session), 400, 'VALIDATION_ERROR');
    }
    problem(await create({ number: 3, deliveryMode: 'live_online' }), 409, 'SESSION_NUMBER_TAKEN');
    const normalized = await ok<Event>('instructor', 'POST', `${A()}/calendar/events`, event('Sesión 10', 10, { number: 10, deliveryMode: 'live_online', joinUrl: 'HTTPS://Meet.Example.EDU/Clase' }), 201);
    assert.equal(normalized.session!.joinUrl, 'https://meet.example.edu/Clase');
    await ok('instructor', 'POST', `/calendar/events/${normalized.id}/cancel`);
    const reused = await ok<Event>('instructor', 'POST', `${A()}/calendar/events`, event('Sesión 10 (reprogramada)', 11, { number: 10, deliveryMode: 'live_online' }), 201);
    assert.equal(reused.session!.number, 10, 'a cancelled session frees its number');
    problem(await request('admin', 'POST', '/calendar/events', event('Institucional', 3, { number: 1, deliveryMode: 'live_online' })), 422, 'SESSION_NOT_ALLOWED');
  });

  it('cross-course units and activities are rejected, in the API and in the database', async () => {
    const create = (session: unknown) => request('instructor', 'POST', `${A()}/calendar/events`, event('Sesión cruzada', 12, session));
    problem(await create({ number: 12, deliveryMode: 'live_online', unitIds: [unit[0], ids.foreignUnit] }), 422, 'SESSION_UNIT_INVALID');
    problem(await create({ number: 12, deliveryMode: 'live_online', unitIds: [randomUUID()] }), 422, 'SESSION_UNIT_INVALID');
    problem(await create({ number: 12, deliveryMode: 'asynchronous', activityId: ids.foreignActivity }), 422, 'SESSION_ACTIVITY_INVALID');
    problem(await create({ number: 12, deliveryMode: 'asynchronous', activityId: randomUUID() }), 422, 'SESSION_ACTIVITY_INVALID');
    const res = await create({ number: 12, deliveryMode: 'live_online', unitIds: [ids.foreignUnit] });
    assert.doesNotMatch(res.body, /Unidad ajena|HYB-B/, 'nothing about the other course is revealed');
    await assert.rejects(query('INSERT INTO calendar_event_units (event_id, course_id, section_id) VALUES ($1, $2, $3)', [sessions[0]!.id, ids.courseA, ids.foreignUnit]), /calendar_event_units_section_fk/);
    await assert.rejects(query('INSERT INTO calendar_event_units (event_id, course_id, section_id) VALUES ($1, $2, $3)', [sessions[0]!.id, ids.courseB, ids.foreignUnit]), /calendar_event_units_event_fk/);
    await assert.rejects(query("UPDATE calendar_events SET join_url = 'http://x.example' WHERE id = $1", [sessions[0]!.id]), /calendar_events_join_url_check/);
    await assert.rejects(query('UPDATE calendar_events SET session_mode = NULL WHERE id = $1', [sessions[0]!.id]), /calendar_events_session_check/);
    assert.equal((await query<{ n: number }>("SELECT count(*)::int AS n FROM calendar_events WHERE title = 'Sesión cruzada'"))[0]!.n, 0);
  });

  it('only instructors of the course and administrators create and edit sessions', async () => {
    const body = event('Sesión 20', 13, { number: 20, deliveryMode: 'live_online', joinUrl: MEET });
    problem(await request('assistant', 'POST', `${A()}/calendar/events`, body), 403, 'FORBIDDEN');
    problem(await request('reviewer', 'POST', `${A()}/calendar/events`, body), 403, 'FORBIDDEN');
    problem(await request('s1', 'POST', `${A()}/calendar/events`, body), 403, 'FORBIDDEN');
    problem(await request('instructorB', 'POST', `${A()}/calendar/events`, body), 404, 'NOT_FOUND');
    problem(await request('outsider', 'POST', `${A()}/calendar/events`, body), 404, 'NOT_FOUND');
    problem(await request(null, 'POST', `${A()}/calendar/events`, body), 401, 'UNAUTHENTICATED');
    problem(await request('instructor', 'POST', `${A()}/calendar/events`, body, { origin: 'https://evil.example' }), 403, 'ORIGIN_NOT_ALLOWED');
    const noCsrf = await app.inject({ method: 'POST', url: `/api/v1${A()}/calendar/events`, cookies: { ap_session: as.instructor.token }, headers: { origin: ORIGIN }, payload: body });
    problem(noCsrf, 403, 'CSRF_TOKEN_INVALID');
    const target = sessions[2]!;
    const edit = { ...event(target.title, 3, { number: 3, deliveryMode: 'live_online', unitIds: [unit[2]] }) };
    for (const who of ['assistant', 'reviewer', 's1'] as const) problem(await request(who, 'PUT', `/calendar/events/${target.id}`, edit), 403, 'FORBIDDEN');
    problem(await request('instructorB', 'PUT', `/calendar/events/${target.id}`, edit), 404, 'NOT_FOUND');
    assert.deepEqual((await calendar('instructor')).events.find((e) => e.id === target.id)!.session!.units.map((u) => u.title), ['Unidad 2', 'Unidad 3'], 'refused edits changed nothing');
    const byAdmin = await ok<Event>('admin', 'POST', `${A()}/calendar/events`, body, 201);
    assert.equal(byAdmin.session!.number, 20, 'administrators keep their established permissions');
    assert.equal((await ok<Event>('instructor', 'PUT', `/calendar/events/${target.id}`, edit)).session!.units.length, 1);
  });

  it('updates: leaving `session` out keeps it (publish/hide), null removes it, an object replaces it', async () => {
    const target = sessions[3]!;
    const { session: _ignored, ...withoutSession } = event(target.title, 4, undefined, 'hidden') as Record<string, unknown>;
    const hidden = await ok<Event>('instructor', 'PUT', `/calendar/events/${target.id}`, withoutSession);
    assert.deepEqual([hidden.status, hidden.session!.number, hidden.session!.units.length, hidden.session!.joinUrl], ['hidden', 4, 2, MEET]);
    const republished = await ok<Event>('instructor', 'PUT', `/calendar/events/${target.id}`, { ...withoutSession, status: 'published' });
    assert.equal(republished.session!.units.length, 2);
    const scratch = await ok<Event>('instructor', 'POST', `${A()}/calendar/events`, event('Borrador de sesión', 14, { number: 30, deliveryMode: 'live_online', unitIds: [unit[0]] }, 'hidden'), 201);
    const cleared = await ok<Event>('instructor', 'PUT', `/calendar/events/${scratch.id}`, { ...event('Borrador de sesión', 14, undefined, 'hidden'), session: null });
    assert.equal(cleared.session, null);
    assert.equal((await query<{ n: number }>('SELECT count(*)::int AS n FROM calendar_event_units WHERE event_id = $1', [scratch.id]))[0]!.n, 0, 'units removed with the session');
    await ok('instructor', 'DELETE', `/calendar/events/${scratch.id}`, undefined, 204);
  });

  it('students see only what course access allows: published sessions, visible units, activities they can open, links of published sessions', async () => {
    const hiddenSession = await ok<Event>('instructor', 'POST', `${A()}/calendar/events`, event('Sesión 40 (oculta)', 5, { number: 40, deliveryMode: 'live_online', joinUrl: MEET, unitIds: [unit[4]] }, 'hidden'), 201);
    const draftLinked = await ok<Event>('instructor', 'POST', `${A()}/calendar/events`, event('Sesión 41', 6, { number: 41, deliveryMode: 'asynchronous', unitIds: [unit[0], unit[4]], activityId: ids.draft }), 201);
    const cancelled = await ok<Event>('instructor', 'POST', `${A()}/calendar/events`, event('Sesión 42', 7, { number: 42, deliveryMode: 'live_online', joinUrl: MEET }), 201);
    await ok('instructor', 'POST', `/calendar/events/${cancelled.id}/cancel`);

    const student = await calendar('s1');
    assert.ok(!student.events.some((e) => e.id === hiddenSession.id), 'hidden sessions are not listed');
    problem(await request('s1', 'GET', `/calendar/events/${hiddenSession.id}`), 404, 'NOT_FOUND');
    const seen = student.events.find((e) => e.id === draftLinked.id)!.session!;
    assert.deepEqual([seen.units.map((u) => u.title), seen.activity], [['Unidad 1'], null], 'hidden units and unapproved activities are left out for students');
    const staff = (await calendar('instructor')).events.find((e) => e.id === draftLinked.id)!.session!;
    assert.deepEqual([staff.units.map((u) => u.title), staff.activity?.title], [['Unidad 1', 'Unidad oculta'], 'Borrador interno'], 'staff see everything they planned');
    assert.equal(student.events.find((e) => e.id === cancelled.id)!.session!.joinUrl, null, 'no classroom link for a cancelled session');
    assert.equal((await calendar('instructor')).events.find((e) => e.id === cancelled.id)!.session!.joinUrl, MEET);
    const mine = await ok<Calendar>('s1', 'GET', `/me/calendar${range}`);
    assert.deepEqual(mine.events.find((e) => e.id === draftLinked.id)!.session!.units.map((u) => u.title), ['Unidad 1'], 'the personal calendar applies the same rules');
    assert.equal(mine.events.find((e) => e.id === sessions[0]!.id)!.session!.joinUrl, MEET);

    problem(await request('outsider', 'GET', `${A()}/calendar${range}`), 404, 'NOT_FOUND');
    problem(await request('s2', 'GET', `${A()}/calendar${range}`), 404, 'NOT_FOUND');
    for (const who of ['outsider', 's2', 'instructorB'] as const) {
      problem(await request(who, 'GET', `/calendar/events/${sessions[0]!.id}`), 404, 'NOT_FOUND');
      const own = await ok<Calendar>(who, 'GET', `/me/calendar${range}`);
      assert.ok(!JSON.stringify(own).includes(MEET), `${who}: no classroom link of another course`);
    }
  });

  it('non-editing instructors read every session, including hidden ones and links, but cannot change them', async () => {
    const view = await calendar('assistant');
    assert.ok(view.events.some((e) => e.session?.number === 40), 'hidden sessions are visible to them (calendar.viewAll)');
    problem(await request('assistant', 'POST', `/calendar/events/${sessions[0]!.id}/cancel`), 403, 'FORBIDDEN');
    problem(await request('assistant', 'DELETE', `/calendar/events/${sessions[0]!.id}`), 403, 'FORBIDDEN');
  });

  it('writes are audited with session details, never the classroom link itself', async () => {
    const rows = await query<{ metadata: { after: { session: Record<string, unknown> | null; unitIds?: string[] } } }>(
      "SELECT metadata FROM audit_log WHERE action = 'calendar_event.created' AND entity_id = $1",
      [sessions[0]!.id],
    );
    assert.deepEqual(rows[0]!.metadata.after.session, { number: 1, deliveryMode: 'live_online', joinUrl: true, activityId: null });
    assert.deepEqual(rows[0]!.metadata.after.unitIds, [unit[0]]);
    assert.doesNotMatch(JSON.stringify(await query("SELECT metadata FROM audit_log WHERE entity_type = 'calendar_event'")), /meet\.example\.edu|pwd=/);
  });
});

describe('teaching session migration on existing calendar events (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let before0034 = '';
  const raw = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[];

  before(async () => {
    before0034 = await mkdtemp(path.join(tmpdir(), 'ap045-migrations-'));
    for (const file of await readdir(migrationsFolder)) if (file.endsWith('.sql') && !file.startsWith('0034_')) await cp(path.join(migrationsFolder, file), path.join(before0034, file));
    const journal = JSON.parse(await readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => !entry.tag.startsWith('0034_'));
    await cp(path.join(migrationsFolder, 'meta'), path.join(before0034, 'meta'), { recursive: true });
    await writeFile(path.join(before0034, 'meta/_journal.json'), JSON.stringify(journal));
    database = await createTestDatabase({ migrationsFolder: before0034 });
  });
  after(async () => {
    await database?.drop();
    if (before0034) await rm(before0034, { recursive: true, force: true });
  });

  it('migration 0034 keeps existing course and institution events unchanged and readable as ordinary events', async () => {
    const [staff] = await raw<{ id: string }>("INSERT INTO users (email, given_name, family_name) VALUES ('legacy.calendar@academiapath.example', 'Elena', 'Ríos') RETURNING id");
    await raw('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [staff!.id, await hashPassword(PASSWORD)]);
    const [term] = await raw<{ id: string }>("INSERT INTO terms (code, name, starts_on, ends_on, academic_year) VALUES ('2026-2', 'Semestre 2026-2', '2026-08-17', '2026-12-11', 2026) RETURNING id");
    const [course] = await raw<{ id: string }>("INSERT INTO courses (term_id, code, title, status) VALUES ($1, 'LEG-CAL', 'Curso Histórico', 'published') RETURNING id", [term!.id]);
    await raw(
      `INSERT INTO calendar_events (scope, course_id, title, all_day, starts_at, ends_at, start_date, end_date, time_zone, status, published_at, created_by_user_id, updated_by_user_id) VALUES
       ('course', $1, 'Clase histórica', false, '2026-09-01T00:00:00Z', '2026-09-01T02:00:00Z', NULL, NULL, 'America/Lima', 'published', now(), $2, $2),
       ('institution', NULL, 'Feriado histórico', true, '2026-10-08T05:00:00Z', '2026-10-09T05:00:00Z', '2026-10-08', '2026-10-08', 'America/Lima', 'published', now(), $2, $2)`,
      [course!.id, staff!.id],
    );
    const beforeRows = await raw('SELECT * FROM calendar_events ORDER BY title');
    assert.equal(beforeRows.length, 2);

    await migrate(database.db, { migrationsFolder });

    const afterRows = await raw('SELECT * FROM calendar_events ORDER BY title');
    assert.deepEqual(afterRows, beforeRows.map((row) => ({ ...row, session_number: null, session_mode: null, join_url: null, session_activity_id: null })), 'no existing value changed; new columns are empty');
    assert.equal((await raw<{ n: number }>('SELECT count(*)::int AS n FROM calendar_event_units'))[0]!.n, 0);
    const app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN }), database: database.db });
    try {
      await app.ready();
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'legacy.calendar@academiapath.example', password: PASSWORD }, headers: { origin: ORIGIN } });
      assert.equal(login.statusCode, 200, login.body);
      const cookie = login.cookies.find((c) => c.name === 'ap_session')!.value;
      const res = await app.inject({ method: 'GET', url: '/api/v1/calendar/events?from=2026-08-01T00:00:00Z&to=2026-12-01T00:00:00Z', cookies: { ap_session: cookie } });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(res.json().items.map((e: Event) => [e.title, e.session]), [['Feriado histórico', null]], 'existing events read as ordinary events');
    } finally {
      await app.close();
    }
  });
});
