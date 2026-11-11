import { and, asc, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { readAssignment } from '../assignments/model.js';
import { recordAudit } from '../audit.js';
import { canInCourse, getCourseAccess, isAdministrator, type CourseAccess } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import { isCalendarDate, isValidTimeZone, nextDay, startOfDay } from '../calendar/time.js';
import type { Database } from '../db/client.js';
import { activities, calendarEvents, courses, enrollments, sections } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';
import { lockedSectionIds } from '../progress/model.js';
import { calendarQuerySchema, calendarSchema, eventInputSchema, eventListSchema, eventParamsSchema, eventSchema } from './communication-schemas.js';
import { courseParamsSchema } from './grading-schemas.js';

type EventRecord = typeof calendarEvents.$inferSelect;
type CourseRef = { id: string; title: string; code: string };
type EventBody = {
  title: string;
  description?: string | null;
  allDay: boolean;
  startsAt?: string;
  endsAt?: string;
  startDate?: string;
  endDate?: string;
  timeZone?: string;
  status: 'hidden' | 'published';
};
type RangeQuery = { from?: string; to?: string; courseId?: string };
type Reader = Pick<Database, 'select'>;

const DAY = 86_400_000;
const MAX_EVENT_DAYS = 366;
const MAX_RANGE_DAYS = 400;
const DEFAULT_RANGE_DAYS = 120;
const MAX_EVENTS = 500;
const notFound = () => new ApiProblem(404, 'NOT_FOUND', 'Event not found.');
const forbidden = (detail: string) => new ApiProblem(403, 'FORBIDDEN', detail);
const invalid = (detail: string) => new ApiProblem(422, 'EVENT_TIME_INVALID', detail);
const courseColumns = { id: courses.id, title: courses.title, code: courses.code };

/** Students see published events, and cancelled ones (marked cancelled) so a change of plans is visible. */
const studentVisible = inArray(calendarEvents.status, ['published', 'cancelled']);

function view(row: EventRecord, course: CourseRef | null) {
  return {
    id: row.id,
    scope: row.scope,
    course: course ? { id: course.id, title: course.title, code: course.code } : null,
    title: row.title,
    description: row.description,
    allDay: row.allDay,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    startDate: row.startDate,
    endDate: row.endDate,
    timeZone: row.timeZone,
    status: row.status,
    publishedAt: row.publishedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Server-side validation of the event's time: explicit time zones only (the institution's when omitted),
 * the end strictly after the start (all-day: last date on or after the first), at most a year long.
 */
function resolveTimes(body: EventBody, defaultZone: string) {
  const timeZone = body.timeZone ?? defaultZone;
  if (!isValidTimeZone(timeZone)) throw new ApiProblem(422, 'INVALID_TIME_ZONE', 'Use an IANA time zone such as America/Lima.');
  if (body.allDay) {
    const { startDate, endDate } = body as Required<Pick<EventBody, 'startDate' | 'endDate'>>;
    if (!isCalendarDate(startDate) || !isCalendarDate(endDate)) throw invalid('Use real calendar dates between 2000 and 2100.');
    if (endDate < startDate) throw invalid('The end date cannot be before the start date.');
    const startsAt = startOfDay(startDate, timeZone);
    const endsAt = startOfDay(nextDay(endDate), timeZone);
    if (endsAt.getTime() - startsAt.getTime() > MAX_EVENT_DAYS * DAY) throw invalid('An event can last at most one year.');
    return { timeZone, startsAt, endsAt, startDate, endDate };
  }
  const startsAt = new Date(body.startsAt!);
  const endsAt = new Date(body.endsAt!);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw invalid('Use date-times with an explicit offset, for example 2026-11-13T19:00:00-05:00.');
  const year = (date: Date) => date.getUTCFullYear();
  if (year(startsAt) < 2000 || year(endsAt) > 2100) throw invalid('Use dates between 2000 and 2100.');
  if (endsAt.getTime() <= startsAt.getTime()) throw invalid('The end must be after the start.');
  if (endsAt.getTime() - startsAt.getTime() > MAX_EVENT_DAYS * DAY) throw invalid('An event can last at most one year.');
  return { timeZone, startsAt, endsAt, startDate: null, endDate: null };
}

/** The requested range (default: the next 120 days on the server clock), at most 400 days. */
function resolveRange(query: RangeQuery, at: Date) {
  const from = query.from ? new Date(query.from) : at;
  const to = query.to ? new Date(query.to) : new Date(from.getTime() + DEFAULT_RANGE_DAYS * DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to.getTime() <= from.getTime()) {
    throw new ApiProblem(422, 'RANGE_INVALID', 'The range must end after it starts.');
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) throw new ApiProblem(422, 'RANGE_INVALID', `A range can cover at most ${MAX_RANGE_DAYS} days.`);
  return { from, to };
}
/** Events overlapping [from, to): starts before the end of the range and ends after its start. */
const overlaps = (from: Date, to: Date) =>
  and(sql`${calendarEvents.startsAt} < ${to.toISOString()}::timestamptz`, sql`${calendarEvents.endsAt} > ${from.toISOString()}::timestamptz`);

export const calendarRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app;
  const authenticated = { preValidation: [app.requireAuth] };
  const authenticatedWrite = { preValidation: [app.requireAuth, app.requireCsrf] };

  async function courseAccess(request: FastifyRequest, courseId: string): Promise<CourseAccess> {
    const access = await getCourseAccess(db, getAuth(request).user, courseId);
    if (!access) throw new ApiProblem(404, 'NOT_FOUND', 'Course not found.');
    return access;
  }
  const refOf = (access: CourseAccess): CourseRef => ({ id: access.course.id, title: access.course.title, code: access.course.code });

  /**
   * Assignment due dates come only from approved assignments (their reviewed due date and late window);
   * quizzes have no due date, so none is invented. Students see only assignments they can open.
   */
  async function dueDates(executor: Reader, access: CourseAccess, from: Date, to: Date) {
    const staff = canInCourse(access, 'calendar.viewAll');
    const rows = await executor
      .select({ id: activities.id, sectionId: activities.sectionId, title: activities.approvedTitle, config: activities.approvedConfig, visible: activities.isVisible, sectionVisible: sections.isVisible })
      .from(activities)
      .innerJoin(sections, eq(sections.id, activities.sectionId))
      .where(and(eq(sections.courseId, access.course.id), eq(activities.type, 'assignment'), isNotNull(activities.approvedConfig)))
      .orderBy(asc(sections.position), asc(activities.position));
    const locked = staff ? new Set<string>() : await lockedSectionIds(executor, access.course.id, access.userId);
    return rows
      .filter((row) => staff || (row.visible && row.sectionVisible && !locked.has(row.sectionId)))
      .map((row) => {
        const settings = readAssignment(row.config);
        return { activityId: row.id, course: refOf(access), title: row.title ?? '', dueAt: new Date(settings.dueAt), lateUntil: settings.lateUntil ? new Date(settings.lateUntil) : null };
      })
      .filter((item) => item.dueAt.getTime() >= from.getTime() && item.dueAt.getTime() < to.getTime());
  }

  /**
   * Who may do what with one event. Institution-wide: everyone signed in reads published or cancelled
   * events; administrators manage them. Course: course access is required (students: an active enrollment
   * in a published course); `calendar.viewAll` sees hidden events, `calendar.manage` writes.
   */
  async function authorize(request: FastifyRequest, row: EventRecord) {
    const { user } = getAuth(request);
    if (row.scope === 'institution') {
      const admin = isAdministrator(user);
      if (!admin && row.status === 'hidden') throw notFound();
      return { manage: admin, course: null };
    }
    const access = await getCourseAccess(db, user, row.courseId!);
    if (!access) throw notFound();
    const manage = canInCourse(access, 'calendar.manage');
    if (row.status === 'hidden' && !manage && !canInCourse(access, 'calendar.viewAll')) throw notFound();
    return { manage, course: refOf(access) };
  }

  async function load(executor: Reader, eventId: string, lock = false) {
    const query = executor.select().from(calendarEvents).where(eq(calendarEvents.id, eventId));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw notFound();
    return row;
  }

  // ---- Reading ----

  app.get<{ Params: { id: string }; Querystring: RangeQuery }>(
    '/courses/:id/calendar',
    { ...authenticated, schema: { params: courseParamsSchema, querystring: calendarQuerySchema, response: { 200: calendarSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      const { from, to } = resolveRange(request.query, app.now());
      const staff = canInCourse(access, 'calendar.viewAll');
      const rows = await db
        .select()
        .from(calendarEvents)
        .where(and(eq(calendarEvents.courseId, access.course.id), staff ? undefined : studentVisible, overlaps(from, to)))
        .orderBy(asc(calendarEvents.startsAt), asc(calendarEvents.id))
        .limit(MAX_EVENTS);
      return {
        timeZone: config.institution.timeZone,
        from,
        to,
        events: rows.map((row) => view(row, refOf(access))),
        dueDates: await dueDates(db, access, from, to),
      };
    },
  );

  /**
   * The caller's calendar: institution-wide events and those of every course they have an active enrollment
   * in (students: published courses only), published or cancelled, plus visible assignment due dates.
   * `courseId` narrows it to one of those courses; any other course is "not found".
   */
  app.get<{ Querystring: RangeQuery }>(
    '/me/calendar',
    { ...authenticated, schema: { querystring: calendarQuerySchema, response: { 200: calendarSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      const { from, to } = resolveRange(request.query, app.now());
      const mine = await db
        .select({ id: courses.id })
        .from(enrollments)
        .innerJoin(courses, eq(courses.id, enrollments.courseId))
        .where(and(eq(enrollments.userId, user.id), eq(enrollments.status, 'active'), or(sql`${enrollments.role} <> 'student'`, eq(courses.status, 'published'))));
      let courseIds = mine.map((row) => row.id);
      if (request.query.courseId) {
        if (!courseIds.includes(request.query.courseId)) throw new ApiProblem(404, 'NOT_FOUND', 'Course not found.');
        courseIds = [request.query.courseId];
      }
      const scope: SQL | undefined = request.query.courseId
        ? inArray(calendarEvents.courseId, courseIds)
        : courseIds.length
          ? or(eq(calendarEvents.scope, 'institution'), inArray(calendarEvents.courseId, courseIds))
          : eq(calendarEvents.scope, 'institution');
      const rows = await db
        .select({ row: calendarEvents, course: courseColumns })
        .from(calendarEvents)
        .leftJoin(courses, eq(courses.id, calendarEvents.courseId))
        .where(and(scope, studentVisible, overlaps(from, to)))
        .orderBy(asc(calendarEvents.startsAt), asc(calendarEvents.id))
        .limit(MAX_EVENTS);
      const due = [];
      for (const courseId of courseIds) {
        const access = await getCourseAccess(db, user, courseId);
        if (access) due.push(...(await dueDates(db, access, from, to)));
      }
      due.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
      return {
        timeZone: config.institution.timeZone,
        from,
        to,
        events: rows.map(({ row, course }) => view(row, course?.id ? (course as CourseRef) : null)),
        dueDates: due,
      };
    },
  );

  app.get<{ Querystring: RangeQuery }>(
    '/calendar/events',
    { ...authenticated, schema: { querystring: calendarQuerySchema, response: { 200: eventListSchema } } },
    async (request) => {
      const admin = isAdministrator(getAuth(request).user);
      const { from, to } = resolveRange(request.query, app.now());
      const rows = await db
        .select()
        .from(calendarEvents)
        .where(and(eq(calendarEvents.scope, 'institution'), admin ? undefined : studentVisible, overlaps(from, to)))
        .orderBy(asc(calendarEvents.startsAt), asc(calendarEvents.id))
        .limit(MAX_EVENTS);
      return { items: rows.map((row) => view(row, null)) };
    },
  );

  app.get<{ Params: { eventId: string } }>(
    '/calendar/events/:eventId',
    { ...authenticated, schema: { params: eventParamsSchema, response: { 200: eventSchema } } },
    async (request) => {
      const row = await load(db, request.params.eventId);
      const { course } = await authorize(request, row);
      return view(row, course);
    },
  );

  // ---- Writes (staff) ----

  const auditView = (row: EventRecord) => ({
    title: row.title,
    allDay: row.allDay,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    startDate: row.startDate,
    endDate: row.endDate,
    timeZone: row.timeZone,
    status: row.status,
    descriptionLength: row.description?.length ?? 0,
  });

  async function create(request: FastifyRequest, scope: 'course' | 'institution', course: CourseRef | null, body: EventBody) {
    const { user } = getAuth(request);
    const times = resolveTimes(body, config.institution.timeZone);
    const at = app.now();
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(calendarEvents)
        .values({
          scope,
          courseId: course?.id ?? null,
          title: body.title.trim(),
          description: body.description?.trim() || null,
          allDay: body.allDay,
          ...times,
          status: body.status,
          publishedAt: body.status === 'published' ? at : null,
          createdByUserId: user.id,
          updatedByUserId: user.id,
        })
        .returning();
      if (!row) throw new Error('Event was not recorded');
      await recordAudit(tx, request, { action: 'calendar_event.created', entityType: 'calendar_event', entityId: row.id, before: null, after: { scope, courseId: row.courseId, ...auditView(row) } });
      return view(row, course);
    });
  }

  app.post<{ Params: { id: string }; Body: EventBody }>(
    '/courses/:id/calendar/events',
    { ...authenticatedWrite, schema: { params: courseParamsSchema, body: eventInputSchema, response: { 201: eventSchema } } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      if (!canInCourse(access, 'calendar.manage')) throw forbidden('Only instructors of this course and administrators can add course events.');
      return reply.code(201).send(await create(request, 'course', refOf(access), request.body));
    },
  );

  app.post<{ Body: EventBody }>(
    '/calendar/events',
    { ...authenticatedWrite, schema: { body: eventInputSchema, response: { 201: eventSchema } } },
    async (request, reply) => {
      if (!isAdministrator(getAuth(request).user)) throw forbidden('Only administrators can add institution-wide events.');
      return reply.code(201).send(await create(request, 'institution', null, request.body));
    },
  );

  /** One change on a locked event the caller manages, audited. */
  async function change(request: FastifyRequest, eventId: string, action: string, apply: (row: EventRecord, at: Date) => Partial<typeof calendarEvents.$inferInsert> | null) {
    const { user } = getAuth(request);
    return db.transaction(async (tx) => {
      const current = await load(tx, eventId, true);
      const { manage, course } = await authorize(request, current);
      if (!manage) throw forbidden(current.scope === 'institution' ? 'Only administrators can change institution-wide events.' : 'Only instructors of this course and administrators can change its events.');
      const next = apply(current, app.now());
      if (!next) return view(current, course);
      const [row] = await tx.update(calendarEvents).set({ ...next, updatedByUserId: user.id }).where(eq(calendarEvents.id, current.id)).returning();
      if (!row) throw notFound();
      await recordAudit(tx, request, { action, entityType: 'calendar_event', entityId: row.id, before: auditView(current), after: auditView(row) });
      return view(row, course);
    });
  }
  const cancelledConflict = () => new ApiProblem(409, 'EVENT_CANCELLED', 'This event is cancelled and can no longer change.');

  app.put<{ Params: { eventId: string }; Body: EventBody }>(
    '/calendar/events/:eventId',
    { ...authenticatedWrite, schema: { params: eventParamsSchema, body: eventInputSchema, response: { 200: eventSchema } } },
    async (request) => {
      const times = resolveTimes(request.body, config.institution.timeZone);
      return change(request, request.params.eventId, 'calendar_event.updated', (row, at) => {
        if (row.status === 'cancelled') throw cancelledConflict();
        return {
          title: request.body.title.trim(),
          description: request.body.description?.trim() || null,
          allDay: request.body.allDay,
          ...times,
          status: request.body.status,
          publishedAt: row.publishedAt ?? (request.body.status === 'published' ? at : null),
        };
      });
    },
  );

  app.post<{ Params: { eventId: string } }>(
    '/calendar/events/:eventId/cancel',
    { ...authenticatedWrite, schema: { params: eventParamsSchema, response: { 200: eventSchema } } },
    async (request) =>
      change(request, request.params.eventId, 'calendar_event.cancelled', (row, at) => (row.status === 'cancelled' ? null : { status: 'cancelled', cancelledAt: at })),
  );

  /** Deleting is only for events students never saw; anything ever published is cancelled instead. */
  app.delete<{ Params: { eventId: string } }>(
    '/calendar/events/:eventId',
    { ...authenticatedWrite, schema: { params: eventParamsSchema } },
    async (request, reply) => {
      await db.transaction(async (tx) => {
        const current = await load(tx, request.params.eventId, true);
        const { manage } = await authorize(request, current);
        if (!manage) throw forbidden('Only the staff who manage this calendar can delete its events.');
        if (current.publishedAt) throw new ApiProblem(409, 'EVENT_WAS_PUBLISHED', 'This event was published, so it can only be cancelled.');
        await recordAudit(tx, request, { action: 'calendar_event.deleted', entityType: 'calendar_event', entityId: current.id, before: { scope: current.scope, courseId: current.courseId, ...auditView(current) }, after: null });
        await tx.delete(calendarEvents).where(eq(calendarEvents.id, current.id));
      });
      return reply.code(204).send();
    },
  );
};
