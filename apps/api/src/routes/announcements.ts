import { and, count, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import { canInCourse, getCourseAccess, isAdministrator, type CourseAccess } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import type { Database } from '../db/client.js';
import { announcementReads, announcements, courses, enrollments } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';
import {
  announcementCreateSchema,
  announcementListQuerySchema,
  announcementPageSchema,
  announcementParamsSchema,
  announcementPublishSchema,
  announcementSchema,
  announcementUpdateSchema,
  feedQuerySchema,
  unreadCountSchema,
} from './communication-schemas.js';
import { courseParamsSchema } from './grading-schemas.js';

type AnnouncementRecord = typeof announcements.$inferSelect;
type CourseRef = { id: string; title: string; code: string };
type Status = 'all' | 'draft' | 'scheduled' | 'published' | 'archived';
type ListQuery = { status: Status; limit: number; cursor?: string };
type Reader = Pick<Database, 'select'>;

const MAX_SCHEDULE_DAYS = 366;
const notFound = () => new ApiProblem(404, 'NOT_FOUND', 'Announcement not found.');
const forbidden = (detail: string) => new ApiProblem(403, 'FORBIDDEN', detail);
const courseColumns = { id: courses.id, title: courses.title, code: courses.code };

/**
 * Visible to readers: published and its publication time reached on the server clock (`at`). Drafts,
 * scheduled (not yet reached) and archived announcements never match, so nothing else can leak through
 * lists, counts or direct ids.
 */
const visibleAt = (at: Date) => and(eq(announcements.status, 'published'), sql`${announcements.publishAt} <= ${at.toISOString()}::timestamptz`)!;

/** Display status: a published announcement whose time has not come yet is "scheduled". */
function displayStatus(row: AnnouncementRecord, at: Date): 'draft' | 'scheduled' | 'published' | 'archived' {
  if (row.status === 'published' && row.publishAt && row.publishAt.getTime() > at.getTime()) return 'scheduled';
  return row.status;
}

/** Newest first, pinned first: (pinned, publication or creation time, id), all descending. */
const sortTime = sql<Date>`coalesce(${announcements.publishAt}, ${announcements.createdAt})`;
const pinnedRank = sql<number>`(CASE WHEN ${announcements.pinned} THEN 1 ELSE 0 END)`;
const ordering = [desc(pinnedRank), desc(sortTime), desc(announcements.id)];
function afterCursor(cursor: string | undefined): SQL | undefined {
  const after = decodeCursor(cursor, 'string');
  if (!after) return undefined;
  const [rank, time] = after.key.split('|');
  if ((rank !== '0' && rank !== '1') || !time || Number.isNaN(Date.parse(time))) throw new ApiProblem(400, 'INVALID_CURSOR', 'The pagination cursor is invalid.');
  return sql`(${pinnedRank}, ${sortTime}, ${announcements.id}) < (${Number(rank)}, ${time}::timestamptz, ${after.id}::uuid)`;
}
function page<T extends { row: AnnouncementRecord }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const time = last ? (last.row.publishAt ?? last.row.createdAt).toISOString() : '';
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(`${last.row.pinned ? 1 : 0}|${time}`, last.row.id) : null };
}

function view(row: AnnouncementRecord, course: CourseRef | null, read: boolean, at: Date) {
  return {
    id: row.id,
    scope: row.scope,
    course: course ? { id: course.id, title: course.title, code: course.code } : null,
    title: row.title,
    body: row.body,
    status: displayStatus(row, at),
    pinned: row.pinned,
    publishAt: row.publishAt,
    archivedAt: row.archivedAt,
    read,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Status filter for staff lists. */
function statusFilter(status: Status, at: Date): SQL | undefined {
  const now = sql`${at.toISOString()}::timestamptz`;
  switch (status) {
    case 'draft':
      return eq(announcements.status, 'draft');
    case 'scheduled':
      return and(eq(announcements.status, 'published'), sql`${announcements.publishAt} > ${now}`);
    case 'published':
      return visibleAt(at);
    case 'archived':
      return eq(announcements.status, 'archived');
    default:
      return undefined;
  }
}

export const announcementRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const authenticated = { preValidation: [app.requireAuth] };
  const authenticatedWrite = { preValidation: [app.requireAuth, app.requireCsrf] };

  async function courseAccess(request: FastifyRequest, courseId: string): Promise<CourseAccess> {
    const access = await getCourseAccess(db, getAuth(request).user, courseId);
    if (!access) throw new ApiProblem(404, 'NOT_FOUND', 'Course not found.');
    return access;
  }

  async function readSet(executor: Reader, userId: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await executor
      .select({ id: announcementReads.announcementId })
      .from(announcementReads)
      .where(and(eq(announcementReads.userId, userId), inArray(announcementReads.announcementId, ids)));
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Who may do what with one announcement. Institution-wide: everyone signed in reads it once visible;
   * administrators manage it. Course: the caller needs access to the course (students: an active enrollment
   * in a published course); `announcements.viewAll` sees every status, `announcements.manage` writes.
   * Anything the caller may not see is "not found".
   */
  async function authorize(request: FastifyRequest, row: AnnouncementRecord) {
    const { user } = getAuth(request);
    const at = app.now();
    let manage: boolean;
    let viewAll: boolean;
    let course: CourseRef | null = null;
    if (row.scope === 'institution') {
      manage = viewAll = isAdministrator(user);
    } else {
      const access = await getCourseAccess(db, user, row.courseId!);
      if (!access) throw notFound();
      manage = canInCourse(access, 'announcements.manage');
      viewAll = canInCourse(access, 'announcements.viewAll') || manage;
      course = { id: access.course.id, title: access.course.title, code: access.course.code };
    }
    const visible = row.status === 'published' && row.publishAt !== null && row.publishAt.getTime() <= at.getTime();
    if (!viewAll && !visible) throw notFound();
    return { manage, viewAll, visible, course, at, user };
  }

  async function load(executor: Reader, announcementId: string, lock = false) {
    const query = executor.select().from(announcements).where(eq(announcements.id, announcementId));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw notFound();
    return row;
  }

  // ---- Lists ----

  app.get<{ Params: { id: string }; Querystring: ListQuery }>(
    '/courses/:id/announcements',
    { ...authenticated, schema: { params: courseParamsSchema, querystring: announcementListQuerySchema, response: { 200: announcementPageSchema } } },
    async (request) => {
      const access = await courseAccess(request, request.params.id);
      const at = app.now();
      const viewAll = canInCourse(access, 'announcements.viewAll');
      const rows = await db
        .select({ row: announcements })
        .from(announcements)
        .where(
          and(
            eq(announcements.courseId, access.course.id),
            viewAll ? statusFilter(request.query.status, at) : visibleAt(at),
            afterCursor(request.query.cursor),
          ),
        )
        .orderBy(...ordering)
        .limit(request.query.limit + 1);
      const result = page(rows, request.query.limit);
      const read = await readSet(db, access.userId, result.items.map((item) => item.row.id));
      const course = { id: access.course.id, title: access.course.title, code: access.course.code };
      return { items: result.items.map(({ row }) => view(row, course, read.has(row.id), at)), nextCursor: result.nextCursor };
    },
  );

  app.get<{ Querystring: ListQuery }>(
    '/announcements',
    { ...authenticated, schema: { querystring: announcementListQuerySchema, response: { 200: announcementPageSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      const at = app.now();
      const admin = isAdministrator(user);
      const rows = await db
        .select({ row: announcements })
        .from(announcements)
        .where(and(eq(announcements.scope, 'institution'), admin ? statusFilter(request.query.status, at) : visibleAt(at), afterCursor(request.query.cursor)))
        .orderBy(...ordering)
        .limit(request.query.limit + 1);
      const result = page(rows, request.query.limit);
      const read = await readSet(db, user.id, result.items.map((item) => item.row.id));
      return { items: result.items.map(({ row }) => view(row, null, read.has(row.id), at)), nextCursor: result.nextCursor };
    },
  );

  /**
   * The caller's announcements: institution-wide ones and those of every course they have an active
   * enrollment in (students: published courses only). Only visible announcements, newest and pinned first.
   */
  function myScope(userId: string, at: Date) {
    const myCourses = db
      .select({ id: enrollments.courseId })
      .from(enrollments)
      .innerJoin(courses, eq(courses.id, enrollments.courseId))
      .where(and(eq(enrollments.userId, userId), eq(enrollments.status, 'active'), or(sql`${enrollments.role} <> 'student'`, eq(courses.status, 'published'))));
    return and(visibleAt(at), or(eq(announcements.scope, 'institution'), inArray(announcements.courseId, myCourses)));
  }

  app.get<{ Querystring: { limit: number; cursor?: string } }>(
    '/me/announcements',
    { ...authenticated, schema: { querystring: feedQuerySchema, response: { 200: announcementPageSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      const at = app.now();
      const rows = await db
        .select({ row: announcements, course: courseColumns })
        .from(announcements)
        .leftJoin(courses, eq(courses.id, announcements.courseId))
        .where(and(myScope(user.id, at), afterCursor(request.query.cursor)))
        .orderBy(...ordering)
        .limit(request.query.limit + 1);
      const result = page(rows, request.query.limit);
      const read = await readSet(db, user.id, result.items.map((item) => item.row.id));
      return {
        items: result.items.map(({ row, course }) => view(row, course?.id ? (course as CourseRef) : null, read.has(row.id), at)),
        nextCursor: result.nextCursor,
      };
    },
  );

  app.get('/me/announcements/unread-count', { ...authenticated, schema: { response: { 200: unreadCountSchema } } }, async (request) => {
    const { user } = getAuth(request);
    const [row] = await db
      .select({ n: count() })
      .from(announcements)
      .leftJoin(announcementReads, and(eq(announcementReads.announcementId, announcements.id), eq(announcementReads.userId, user.id)))
      .where(and(myScope(user.id, app.now()), isNull(announcementReads.userId)));
    return { unreadCount: row?.n ?? 0 };
  });

  // ---- One announcement ----

  app.get<{ Params: { announcementId: string } }>(
    '/announcements/:announcementId',
    { ...authenticated, schema: { params: announcementParamsSchema, response: { 200: announcementSchema } } },
    async (request) => {
      const row = await load(db, request.params.announcementId);
      const { course, at, user } = await authorize(request, row);
      const read = await readSet(db, user.id, [row.id]);
      return view(row, course, read.has(row.id), at);
    },
  );

  app.put<{ Params: { announcementId: string } }>(
    '/announcements/:announcementId/read',
    { ...authenticatedWrite, schema: { params: announcementParamsSchema } },
    async (request, reply) => {
      const row = await load(db, request.params.announcementId);
      const { visible, user } = await authorize(request, row);
      // Only announcements the caller can actually read are marked; repeated requests change nothing.
      if (!visible) throw notFound();
      await db.insert(announcementReads).values({ announcementId: row.id, userId: user.id }).onConflictDoNothing();
      return reply.code(204).send();
    },
  );

  // ---- Writes (staff) ----

  async function create(request: FastifyRequest, scope: 'course' | 'institution', course: CourseRef | null, body: { title: string; body: string; pinned?: boolean }) {
    const { user } = getAuth(request);
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(announcements)
        .values({
          scope,
          courseId: course?.id ?? null,
          title: body.title.trim(),
          body: body.body.trim(),
          pinned: body.pinned ?? false,
          createdByUserId: user.id,
          updatedByUserId: user.id,
        })
        .returning();
      if (!row) throw new Error('Announcement was not recorded');
      await recordAudit(tx, request, {
        action: 'announcement.created',
        entityType: 'announcement',
        entityId: row.id,
        before: null,
        after: { scope, courseId: row.courseId, title: row.title, pinned: row.pinned, status: row.status },
      });
      return view(row, course, false, app.now());
    });
  }

  app.post<{ Params: { id: string }; Body: { title: string; body: string; pinned?: boolean } }>(
    '/courses/:id/announcements',
    { ...authenticatedWrite, schema: { params: courseParamsSchema, body: announcementCreateSchema, response: { 201: announcementSchema } } },
    async (request, reply) => {
      const access = await courseAccess(request, request.params.id);
      if (!canInCourse(access, 'announcements.manage')) throw forbidden('Only instructors of this course and administrators can post announcements.');
      const course = { id: access.course.id, title: access.course.title, code: access.course.code };
      return reply.code(201).send(await create(request, 'course', course, request.body));
    },
  );

  app.post<{ Body: { title: string; body: string; pinned?: boolean } }>(
    '/announcements',
    { ...authenticatedWrite, schema: { body: announcementCreateSchema, response: { 201: announcementSchema } } },
    async (request, reply) => {
      if (!isAdministrator(getAuth(request).user)) throw forbidden('Only administrators can post institution-wide announcements.');
      return reply.code(201).send(await create(request, 'institution', null, request.body));
    },
  );

  /** Runs one change on a locked announcement the caller manages, and audits it. */
  async function change(
    request: FastifyRequest,
    announcementId: string,
    action: string,
    apply: (row: AnnouncementRecord, at: Date) => Partial<typeof announcements.$inferInsert> | null,
  ) {
    const { user } = getAuth(request);
    return db.transaction(async (tx) => {
      const current = await load(tx, announcementId, true);
      const { manage, course } = await authorize(request, current);
      if (!manage) throw forbidden(current.scope === 'institution' ? 'Only administrators can change institution-wide announcements.' : 'Only instructors of this course and administrators can change its announcements.');
      const at = app.now();
      const next = apply(current, at);
      if (!next) return view(current, course, false, at);
      const [row] = await tx
        .update(announcements)
        .set({ ...next, updatedByUserId: user.id })
        .where(eq(announcements.id, current.id))
        .returning();
      if (!row) throw notFound();
      const snapshot = (value: AnnouncementRecord) => ({ title: value.title, pinned: value.pinned, status: displayStatus(value, at), publishAt: value.publishAt, bodyLength: value.body.length });
      await recordAudit(tx, request, { action, entityType: 'announcement', entityId: row.id, before: snapshot(current), after: snapshot(row) });
      const read = await readSet(tx, user.id, [row.id]);
      return view(row, course, read.has(row.id), at);
    });
  }
  const archivedConflict = () => new ApiProblem(409, 'ANNOUNCEMENT_ARCHIVED', 'This announcement is archived and can no longer change.');

  app.put<{ Params: { announcementId: string }; Body: { title?: string; body?: string; pinned?: boolean } }>(
    '/announcements/:announcementId',
    { ...authenticatedWrite, schema: { params: announcementParamsSchema, body: announcementUpdateSchema, response: { 200: announcementSchema } } },
    async (request) =>
      change(request, request.params.announcementId, 'announcement.updated', (row) => {
        if (row.status === 'archived') throw archivedConflict();
        return {
          ...(request.body.title !== undefined ? { title: request.body.title.trim() } : {}),
          ...(request.body.body !== undefined ? { body: request.body.body.trim() } : {}),
          ...(request.body.pinned !== undefined ? { pinned: request.body.pinned } : {}),
        };
      }),
  );

  app.post<{ Params: { announcementId: string }; Body: { publishAt?: string | null } }>(
    '/announcements/:announcementId/publish',
    { ...authenticatedWrite, schema: { params: announcementParamsSchema, body: announcementPublishSchema, response: { 200: announcementSchema } } },
    async (request) => {
      const requested = request.body.publishAt ? new Date(request.body.publishAt) : null;
      return change(request, request.params.announcementId, requested ? 'announcement.scheduled' : 'announcement.published', (row, at) => {
        if (row.status === 'archived') throw archivedConflict();
        if (requested) {
          // Scheduling: strictly in the future (server clock), within a year.
          if (requested.getTime() <= at.getTime()) throw new ApiProblem(422, 'PUBLISH_AT_INVALID', 'A scheduled publication time must be in the future.');
          if (requested.getTime() > at.getTime() + MAX_SCHEDULE_DAYS * 86_400_000) throw new ApiProblem(422, 'PUBLISH_AT_INVALID', 'Publications can be scheduled up to one year ahead.');
          return { status: 'published', publishAt: requested };
        }
        // Publish now; publishing an already visible announcement changes nothing (idempotent).
        if (row.status === 'published' && row.publishAt && row.publishAt.getTime() <= at.getTime()) return null;
        return { status: 'published', publishAt: at };
      });
    },
  );

  app.post<{ Params: { announcementId: string } }>(
    '/announcements/:announcementId/unschedule',
    { ...authenticatedWrite, schema: { params: announcementParamsSchema, response: { 200: announcementSchema } } },
    async (request) =>
      change(request, request.params.announcementId, 'announcement.unscheduled', (row, at) => {
        if (displayStatus(row, at) !== 'scheduled') throw new ApiProblem(409, 'ANNOUNCEMENT_NOT_SCHEDULED', 'Only a scheduled announcement can be moved back to draft.');
        return { status: 'draft', publishAt: null };
      }),
  );

  app.post<{ Params: { announcementId: string } }>(
    '/announcements/:announcementId/archive',
    { ...authenticatedWrite, schema: { params: announcementParamsSchema, response: { 200: announcementSchema } } },
    async (request) =>
      change(request, request.params.announcementId, 'announcement.archived', (row, at) => (row.status === 'archived' ? null : { status: 'archived', archivedAt: at, pinned: false })),
  );
};


