/**
 * Messaging (AP-026): direct conversations between a student and the course's teaching staff, and one
 * conversation per course. Every request re-derives access from current active enrollments; nobody reads a
 * conversation by knowing its id. Messages are plain text, ordered by an insertion sequence, never deleted
 * (instructors may hide course-conversation messages) and never written to logs or audit records.
 */
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import { getCourseAccess, hasCoursePermission, isAdministrator } from '../auth/authorization.js';
import { getAuth } from '../auth/hooks.js';
import type { Database } from '../db/client.js';
import { conversationReads, conversations, courses, enrollments, messages, notifications, users } from '../db/schema/index.js';
import { ApiProblem, sendError } from '../http/errors.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';
import { mayConverse, messagingMember, orderedPair, type MessagingMember } from '../messaging/access.js';
import { courseMemberIds, notifyUsers, visibleTo } from '../messaging/notify.js';
import { courseParamsSchema } from './grading-schemas.js';
import {
  adminCourseConversationListSchema,
  conversationListQuerySchema,
  conversationPageSchema,
  conversationParamsSchema,
  conversationSchema,
  courseMessagingSchema,
  directConversationInputSchema,
  lockResultSchema,
  messageInputSchema,
  messageListQuerySchema,
  messagePageSchema,
  messageParamsSchema,
  messageSchema,
  messagingSummarySchema,
  readInputSchema,
} from './messaging-schemas.js';

type ConversationRecord = typeof conversations.$inferSelect;
type MessageRecord = typeof messages.$inferSelect;
type Reader = Pick<Database, 'select' | 'selectDistinctOn'>;
type CourseRef = { id: string; title: string; code: string };

const MESSAGING_ROLES = ['student', 'instructor', 'non_editing_instructor'] as const;
const STAFF_ROLES = ['instructor', 'non_editing_instructor'] as const;
const PREVIEW_LENGTH = 120;
/** Polling endpoints: generous for a few open views per person, bounded per instance. */
const POLL_LIMIT = { max: 120, timeWindow: 60_000 };

const notFound = () => new ApiProblem(404, 'NOT_FOUND', 'Conversation not found.');
const forbidden = (detail: string) => new ApiProblem(403, 'FORBIDDEN', detail);
const fullName = sql<string>`${users.givenName} || ' ' || ${users.familyName}`;

/** The caller's standing in one conversation, from current data. */
type Context = { conversation: ConversationRecord; member: MessagingMember; counterpartId: string | null; canPost: boolean; canModerate: boolean };

export async function conversationContext(reader: Reader, userId: string, conversation: ConversationRecord): Promise<Context | null> {
  const member = await messagingMember(reader, userId, conversation.courseId);
  if (!member) return null;
  if (conversation.kind === 'direct') {
    if (!hasCoursePermission(member.role, 'messages.direct')) return null;
    if (userId !== conversation.participantLowId && userId !== conversation.participantHighId) return null;
    const counterpartId = userId === conversation.participantLowId ? conversation.participantHighId! : conversation.participantLowId!;
    const other = await messagingMember(reader, counterpartId, conversation.courseId);
    return { conversation, member, counterpartId, canPost: Boolean(other && mayConverse(member.role, other.role)), canModerate: false };
  }
  if (!hasCoursePermission(member.role, 'messages.course')) return null;
  return { conversation, member, counterpartId: null, canPost: conversation.lockedAt === null, canModerate: hasCoursePermission(member.role, 'messages.moderate') };
}

/** Builds the API view of several conversations for one person with a fixed number of queries. */
async function conversationViews(reader: Reader, userId: string, contexts: Context[]) {
  if (!contexts.length) return [];
  const ids = contexts.map((c) => c.conversation.id);
  const courseIds = [...new Set(contexts.map((c) => c.conversation.courseId))];
  const unread = await reader
    .select({ conversationId: messages.conversationId, n: count() })
    .from(messages)
    .leftJoin(conversationReads, and(eq(conversationReads.conversationId, messages.conversationId), eq(conversationReads.userId, userId)))
    .where(
      and(
        inArray(messages.conversationId, ids),
        ne(messages.senderUserId, userId),
        isNull(messages.hiddenAt),
        sql`${messages.seq} > coalesce(${conversationReads.lastReadSeq}, 0)`,
      ),
    )
    .groupBy(messages.conversationId);
  const unreadBy = new Map(unread.map((row) => [row.conversationId, row.n]));
  const last = await reader
    .selectDistinctOn([messages.conversationId], {
      conversationId: messages.conversationId,
      body: messages.body,
      hiddenAt: messages.hiddenAt,
      createdAt: messages.createdAt,
      senderName: fullName,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderUserId))
    .where(inArray(messages.conversationId, ids))
    .orderBy(messages.conversationId, desc(messages.seq));
  const lastBy = new Map(last.map((row) => [row.conversationId, row]));
  const counterpartIds = contexts.map((c) => c.counterpartId).filter((id): id is string => Boolean(id));
  const people = counterpartIds.length
    ? await reader
        .select({ id: users.id, name: fullName, courseId: enrollments.courseId, role: enrollments.role })
        .from(users)
        .leftJoin(enrollments, and(eq(enrollments.userId, users.id), inArray(enrollments.courseId, courseIds)))
        .where(inArray(users.id, counterpartIds))
    : [];
  const courseRows = await reader.select({ id: courses.id, title: courses.title, code: courses.code }).from(courses).where(inArray(courses.id, courseIds));
  const courseBy = new Map(courseRows.map((row) => [row.id, row]));
  return contexts.map((c) => {
    const lastMessage = lastBy.get(c.conversation.id);
    const person = c.counterpartId ? people.find((p) => p.id === c.counterpartId && (p.courseId === c.conversation.courseId || p.courseId === null)) ?? people.find((p) => p.id === c.counterpartId) : undefined;
    return {
      id: c.conversation.id,
      kind: c.conversation.kind,
      course: courseBy.get(c.conversation.courseId)!,
      counterpart: person ? { id: person.id, name: person.name, role: messagingRole(person.courseId === c.conversation.courseId ? person.role : null) } : null,
      locked: c.conversation.lockedAt !== null,
      canPost: c.canPost,
      canModerate: c.canModerate,
      unreadCount: unreadBy.get(c.conversation.id) ?? 0,
      lastMessage: lastMessage
        ? { senderName: lastMessage.senderName, preview: lastMessage.hiddenAt ? null : preview(lastMessage.body), createdAt: lastMessage.createdAt }
        : null,
    };
  });
}

const messagingRole = (role: string | null | undefined) => (role && (MESSAGING_ROLES as readonly string[]).includes(role) ? (role as (typeof MESSAGING_ROLES)[number]) : null);
const preview = (body: string) => (body.length > PREVIEW_LENGTH ? `${body.slice(0, PREVIEW_LENGTH - 1)}…` : body);

/**
 * Unread messages across the conversations a person can currently read: their direct conversations and the
 * conversations of published courses where they hold an active messaging role.
 */
export function unreadMessagesCount(reader: Reader, userId: string) {
  return reader
    .select({ n: count() })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(courses, eq(courses.id, conversations.courseId))
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.courseId, conversations.courseId),
        eq(enrollments.userId, userId),
        eq(enrollments.status, 'active'),
        inArray(enrollments.role, [...MESSAGING_ROLES]),
      ),
    )
    .leftJoin(conversationReads, and(eq(conversationReads.conversationId, conversations.id), eq(conversationReads.userId, userId)))
    .where(
      and(
        eq(courses.status, 'published'),
        ne(messages.senderUserId, userId),
        isNull(messages.hiddenAt),
        sql`${messages.seq} > coalesce(${conversationReads.lastReadSeq}, 0)`,
        or(eq(conversations.kind, 'course'), eq(conversations.participantLowId, userId), eq(conversations.participantHighId, userId)),
      ),
    )
    .then((rows) => rows[0]?.n ?? 0);
}

export const messagingRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app;
  const authenticated = { preValidation: [app.requireAuth] };
  const authenticatedWrite = { preValidation: [app.requireAuth, app.requireCsrf] };
  const pollLimit = { rateLimit: { ...POLL_LIMIT, hook: 'preHandler' as const, keyGenerator: (request: FastifyRequest) => `poll:${request.auth?.user.id ?? request.ip}` } };

  async function load(reader: Reader, conversationId: string, lock = false) {
    const query = reader.select().from(conversations).where(eq(conversations.id, conversationId));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw notFound();
    return row;
  }

  /** The caller's context in a conversation, or "not found" for anyone who may not read it. */
  async function context(request: FastifyRequest, reader: Reader, conversationId: string, lock = false) {
    const conversation = await load(reader, conversationId, lock);
    const ctx = await conversationContext(reader, getAuth(request).user.id, conversation);
    if (!ctx) throw notFound();
    return ctx;
  }

  /** Messaging membership in a course; people who can see the course without a messaging role get 403. */
  async function courseMember(request: FastifyRequest, courseId: string) {
    const { user } = getAuth(request);
    const member = await messagingMember(db, user.id, courseId);
    if (member) return member;
    if (!(await getCourseAccess(db, user, courseId))) throw new ApiProblem(404, 'NOT_FOUND', 'Course not found.');
    throw new ApiProblem(403, 'MESSAGING_NOT_AVAILABLE', 'Messaging is for the students and teaching staff of a published course.');
  }

  // ---- Reading ----

  app.get('/me/messaging/summary', { ...authenticated, config: pollLimit, schema: { response: { 200: messagingSummarySchema } } }, async (request) => {
    const { user } = getAuth(request);
    const [unreadNotifications] = await db
      .select({ n: count() })
      .from(notifications)
      .where(and(visibleTo(user.id, app.now()), isNull(notifications.readAt)));
    return { unreadMessages: await unreadMessagesCount(db, user.id), unreadNotifications: unreadNotifications?.n ?? 0 };
  });

  app.get<{ Querystring: { limit: number; cursor?: string } }>(
    '/me/conversations',
    { ...authenticated, schema: { querystring: conversationListQuerySchema, response: { 200: conversationPageSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      const { limit } = request.query;
      const cursor = decodeCursor(request.query.cursor, 'string');
      const activity = sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;
      const rows = await db
        .select({ conversation: conversations, activity: sql<string>`${activity}::text` })
        .from(conversations)
        .innerJoin(courses, and(eq(courses.id, conversations.courseId), eq(courses.status, 'published')))
        .innerJoin(
          enrollments,
          and(
            eq(enrollments.courseId, conversations.courseId),
            eq(enrollments.userId, user.id),
            eq(enrollments.status, 'active'),
            inArray(enrollments.role, [...MESSAGING_ROLES]),
          ),
        )
        .where(
          and(
            or(eq(conversations.kind, 'course'), eq(conversations.participantLowId, user.id), eq(conversations.participantHighId, user.id)),
            cursor ? sql`(${activity}, ${conversations.id}) < (${cursor.key}::timestamptz, ${cursor.id}::uuid)` : undefined,
          ),
        )
        .orderBy(desc(activity), desc(conversations.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const contexts = (await Promise.all(page.map((row) => conversationContext(db, user.id, row.conversation)))).filter((c): c is Context => c !== null);
      const last = page.at(-1);
      return { items: await conversationViews(db, user.id, contexts), nextCursor: rows.length > limit && last ? encodeCursor(last.activity, last.conversation.id) : null };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/courses/:id/messaging',
    { ...authenticated, schema: { params: courseParamsSchema, response: { 200: courseMessagingSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      const member = await courseMember(request, request.params.id);
      const course: CourseRef = { id: member.course.id, title: member.course.title, code: member.course.code };
      // Students reach the course's teaching staff; teaching staff reach its students.
      const contactRoles = member.role === 'student' ? [...STAFF_ROLES] : ['student' as const];
      const contacts = await db
        .select({ id: users.id, name: fullName, role: enrollments.role })
        .from(enrollments)
        .innerJoin(users, eq(users.id, enrollments.userId))
        .where(and(eq(enrollments.courseId, course.id), eq(enrollments.status, 'active'), eq(users.isActive, true), inArray(enrollments.role, contactRoles), ne(users.id, user.id)))
        .orderBy(asc(users.familyName), asc(users.givenName));
      const rows = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.courseId, course.id), or(eq(conversations.kind, 'course'), eq(conversations.participantLowId, user.id), eq(conversations.participantHighId, user.id))))
        .orderBy(desc(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`));
      const contexts = (await Promise.all(rows.map((row) => conversationContext(db, user.id, row)))).filter((c): c is Context => c !== null);
      const views = await conversationViews(db, user.id, contexts);
      return {
        course,
        role: member.role as (typeof MESSAGING_ROLES)[number],
        courseConversation: views.find((v) => v.kind === 'course') ?? null,
        directConversations: views.filter((v) => v.kind === 'direct'),
        contacts: contacts.map((c) => ({ id: c.id, name: c.name, role: messagingRole(c.role) })),
      };
    },
  );

  app.get<{ Params: { conversationId: string } }>(
    '/conversations/:conversationId',
    { ...authenticated, schema: { params: conversationParamsSchema, response: { 200: conversationSchema } } },
    async (request) => {
      const ctx = await context(request, db, request.params.conversationId);
      const [view] = await conversationViews(db, getAuth(request).user.id, [ctx]);
      return view;
    },
  );

  app.get<{ Params: { conversationId: string }; Querystring: { before?: number; after?: number; limit: number } }>(
    '/conversations/:conversationId/messages',
    { ...authenticated, config: pollLimit, schema: { params: conversationParamsSchema, querystring: messageListQuerySchema, response: { 200: messagePageSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      const ctx = await context(request, db, request.params.conversationId);
      const { before, after, limit } = request.query;
      if (before !== undefined && after !== undefined) throw new ApiProblem(400, 'INVALID_QUERY', 'Use either before or after, not both.');
      const columns = {
        message: messages,
        senderName: fullName,
        senderRole: enrollments.role,
      };
      const base = db
        .select(columns)
        .from(messages)
        .innerJoin(users, eq(users.id, messages.senderUserId))
        .leftJoin(enrollments, and(eq(enrollments.userId, messages.senderUserId), eq(enrollments.courseId, ctx.conversation.courseId)));
      const inConversation = eq(messages.conversationId, ctx.conversation.id);
      let rows: Array<{ message: MessageRecord; senderName: string; senderRole: string | null }>;
      let hasOlder = false;
      if (after !== undefined) {
        rows = await base.where(and(inConversation, gt(messages.seq, after))).orderBy(asc(messages.seq)).limit(limit);
      } else {
        const found = await base
          .where(and(inConversation, before !== undefined ? lt(messages.seq, before) : undefined))
          .orderBy(desc(messages.seq))
          .limit(limit + 1);
        hasOlder = found.length > limit;
        rows = found.slice(0, limit).reverse();
      }
      const [latest] = await db.select({ seq: sql<number | null>`max(${messages.seq})`.mapWith((v) => (v === null ? null : Number(v))) }).from(messages).where(inConversation);
      const [read] = await db
        .select({ seq: conversationReads.lastReadSeq })
        .from(conversationReads)
        .where(and(eq(conversationReads.conversationId, ctx.conversation.id), eq(conversationReads.userId, user.id)));
      return {
        items: rows.map((row) => messageView(row, user.id)),
        olderCursor: hasOlder && rows[0] ? rows[0].message.seq : null,
        latestSeq: latest?.seq ?? null,
        readSeq: read?.seq ?? 0,
      };
    },
  );

  // ---- Writing ----

  app.post<{ Params: { id: string }; Body: { recipientUserId: string } }>(
    '/courses/:id/conversations',
    { ...authenticatedWrite, schema: { params: courseParamsSchema, body: directConversationInputSchema, response: { 200: conversationSchema, 201: conversationSchema } } },
    async (request, reply) => {
      const { user } = getAuth(request);
      const member = await courseMember(request, request.params.id);
      const recipientId = request.body.recipientUserId;
      const other = recipientId === user.id ? null : await messagingMember(db, recipientId, member.course.id);
      if (!other || !mayConverse(member.role, other.role)) {
        throw new ApiProblem(422, 'RECIPIENT_NOT_ALLOWED', 'Students can message the teaching staff of their course, and teaching staff can message its students.');
      }
      const [low, high] = orderedPair(user.id, recipientId);
      const [created] = await db
        .insert(conversations)
        .values({ kind: 'direct', courseId: member.course.id, participantLowId: low, participantHighId: high })
        .onConflictDoNothing()
        .returning();
      const [found] = created
        ? [created]
        : await db
            .select()
            .from(conversations)
            .where(and(eq(conversations.kind, 'direct'), eq(conversations.courseId, member.course.id), eq(conversations.participantLowId, low), eq(conversations.participantHighId, high)));
      if (!found) throw notFound();
      const ctx = await conversationContext(db, user.id, found);
      const [view] = await conversationViews(db, user.id, [ctx!]);
      return reply.code(created ? 201 : 200).send(view);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/courses/:id/course-conversation',
    { ...authenticatedWrite, schema: { params: courseParamsSchema, response: { 200: conversationSchema, 201: conversationSchema } } },
    async (request, reply) => {
      const { user } = getAuth(request);
      const member = await courseMember(request, request.params.id);
      if (!hasCoursePermission(member.role, 'messages.course')) throw forbidden('The course conversation is for the students and teaching staff of this course.');
      const [created] = await db.insert(conversations).values({ kind: 'course', courseId: member.course.id }).onConflictDoNothing().returning();
      const [found] = created ? [created] : await db.select().from(conversations).where(and(eq(conversations.kind, 'course'), eq(conversations.courseId, member.course.id)));
      if (!found) throw notFound();
      const ctx = await conversationContext(db, user.id, found);
      const [view] = await conversationViews(db, user.id, [ctx!]);
      return reply.code(created ? 201 : 200).send(view);
    },
  );

  app.post<{ Params: { conversationId: string }; Body: { body: string; clientMessageId: string } }>(
    '/conversations/:conversationId/messages',
    { ...authenticatedWrite, schema: { params: conversationParamsSchema, body: messageInputSchema, response: { 200: messageSchema, 201: messageSchema } } },
    async (request, reply) => {
      const { user } = getAuth(request);
      const { max, windowMinutes } = config.messageRateLimit;
      const text = request.body.body.trim();
      const outcome = await db.transaction(async (tx) => {
        // One send at a time per person: the rate limit and the retry check below are exact under concurrency.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`message-sender:${user.id}`}, 0))`);
        const ctx = await context(request, tx, request.params.conversationId);
        const [existing] = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.conversationId, ctx.conversation.id), eq(messages.senderUserId, user.id), eq(messages.clientMessageId, request.body.clientMessageId)));
        if (existing) return { kind: 'existing' as const, message: existing, ctx };
        // The conversation row is locked against a concurrent lock/unlock while the message is recorded.
        const [current] = await tx.select().from(conversations).where(eq(conversations.id, ctx.conversation.id)).for('share');
        if (ctx.conversation.kind === 'course' && current?.lockedAt) {
          throw new ApiProblem(409, 'CONVERSATION_LOCKED', 'This course conversation is locked; no new messages can be posted.');
        }
        if (!ctx.canPost) throw new ApiProblem(409, 'RECIPIENT_UNAVAILABLE', 'The other person can no longer receive messages in this course.');
        const [used] = await tx
          .select({
            n: count(),
            retryAfter: sql<number>`ceil(extract(epoch from (min(${messages.createdAt}) + make_interval(mins => ${windowMinutes}) - now())))`.mapWith(Number),
          })
          .from(messages)
          .where(and(eq(messages.senderUserId, user.id), sql`${messages.createdAt} > now() - make_interval(mins => ${windowMinutes})`));
        if ((used?.n ?? 0) >= max) return { kind: 'limited' as const, retryAfter: Math.max(1, used?.retryAfter ?? 60) };
        const [message] = await tx
          .insert(messages)
          .values({ conversationId: ctx.conversation.id, senderUserId: user.id, body: text, clientMessageId: request.body.clientMessageId })
          .returning();
        if (!message) throw new Error('Message was not recorded');
        const at = app.now();
        await tx.update(conversations).set({ lastMessageAt: message.createdAt }).where(eq(conversations.id, ctx.conversation.id));
        // The sender has read their own message.
        await markRead(tx, ctx.conversation.id, user.id, message.seq);
        const senderName = `${user.givenName} ${user.familyName}`.trim();
        const event = { courseId: ctx.conversation.courseId, entityId: ctx.conversation.id, dedupeKey: `conversation:${ctx.conversation.id}`, data: { senderName, courseCode: ctx.member.course.code }, at };
        if (ctx.conversation.kind === 'direct') await notifyUsers(tx, [ctx.counterpartId!], { ...event, type: 'direct_message' });
        else await notifyUsers(tx, await courseMemberIds(tx, ctx.conversation.courseId, { roles: [...MESSAGING_ROLES], except: user.id }), { ...event, type: 'course_message' });
        return { kind: 'created' as const, message, ctx };
      });
      if (outcome.kind === 'limited') {
        reply.header('retry-after', String(outcome.retryAfter));
        return sendError(reply, 429, 'RATE_LIMITED', 'Too many messages. Try again in a moment.');
      }
      const view = messageView({ message: outcome.message, senderName: `${user.givenName} ${user.familyName}`.trim(), senderRole: outcome.ctx.member.role }, user.id);
      return reply.code(outcome.kind === 'created' ? 201 : 200).send(view);
    },
  );

  app.put<{ Params: { conversationId: string }; Body: { upToSeq: number } }>(
    '/conversations/:conversationId/read',
    { ...authenticatedWrite, schema: { params: conversationParamsSchema, body: readInputSchema } },
    async (request, reply) => {
      const { user } = getAuth(request);
      await db.transaction(async (tx) => {
        const ctx = await context(request, tx, request.params.conversationId);
        const [latest] = await tx.select({ seq: sql<number>`coalesce(max(${messages.seq}), 0)`.mapWith(Number) }).from(messages).where(eq(messages.conversationId, ctx.conversation.id));
        const latestSeq = latest?.seq ?? 0;
        const target = Math.min(request.body.upToSeq, latestSeq);
        await markRead(tx, ctx.conversation.id, user.id, target);
        // Everything read: the conversation's notification is read too.
        if (target >= latestSeq) {
          await tx
            .update(notifications)
            .set({ readAt: app.now() })
            .where(and(eq(notifications.userId, user.id), eq(notifications.dedupeKey, `conversation:${ctx.conversation.id}`), isNull(notifications.readAt)));
        }
      });
      return reply.code(204).send();
    },
  );

  // ---- Moderation (instructors) and institutional management (administrators) ----

  app.post<{ Params: { conversationId: string; messageId: string } }>(
    '/conversations/:conversationId/messages/:messageId/hide',
    { ...authenticatedWrite, schema: { params: messageParamsSchema, response: { 200: messageSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      return db.transaction(async (tx) => {
        const ctx = await context(request, tx, request.params.conversationId);
        if (!ctx.canModerate) throw forbidden('Only instructors of this course can hide messages in its conversation.');
        const [row] = await tx
          .select({ message: messages, senderName: fullName })
          .from(messages)
          .innerJoin(users, eq(users.id, messages.senderUserId))
          .where(and(eq(messages.id, request.params.messageId), eq(messages.conversationId, ctx.conversation.id)))
          .for('update', { of: messages });
        if (!row) throw new ApiProblem(404, 'NOT_FOUND', 'Message not found.');
        let message = row.message;
        if (!message.hiddenAt) {
          const [updated] = await tx.update(messages).set({ hiddenAt: app.now(), hiddenByUserId: user.id }).where(eq(messages.id, message.id)).returning();
          message = updated!;
          await recordAudit(tx, request, {
            action: 'message.hidden',
            entityType: 'message',
            entityId: message.id,
            before: null,
            // Never the text itself.
            after: { conversationId: ctx.conversation.id, courseId: ctx.conversation.courseId, senderUserId: message.senderUserId, length: message.body.length },
          });
        }
        const [sender] = await tx.select({ role: enrollments.role }).from(enrollments).where(and(eq(enrollments.userId, message.senderUserId), eq(enrollments.courseId, ctx.conversation.courseId)));
        return messageView({ message, senderName: row.senderName, senderRole: sender?.role ?? null }, user.id);
      });
    },
  );

  /**
   * Locking stops new posts in a course conversation. Instructors of the course may lock it; administrators may
   * too, as institutional management, without being able to read it.
   */
  async function setLock(request: FastifyRequest, conversationId: string, locked: boolean) {
    const { user } = getAuth(request);
    return db.transaction(async (tx) => {
      const conversation = await load(tx, conversationId, true);
      // Only course conversations can be locked; a direct conversation is "not found" here for everyone.
      if (conversation.kind !== 'course') throw notFound();
      if (!isAdministrator(user)) {
        const ctx = await conversationContext(tx, user.id, conversation);
        if (!ctx) throw notFound();
        if (!ctx.canModerate) throw forbidden('Only instructors of this course and administrators can lock its conversation.');
      }
      if ((conversation.lockedAt !== null) !== locked) {
        await tx
          .update(conversations)
          .set(locked ? { lockedAt: app.now(), lockedByUserId: user.id } : { lockedAt: null, lockedByUserId: null })
          .where(eq(conversations.id, conversation.id));
        await recordAudit(tx, request, {
          action: locked ? 'conversation.locked' : 'conversation.unlocked',
          entityType: 'conversation',
          entityId: conversation.id,
          before: { locked: !locked },
          after: { locked, courseId: conversation.courseId },
        });
      }
      return { conversationId: conversation.id, locked };
    });
  }

  app.post<{ Params: { conversationId: string } }>(
    '/conversations/:conversationId/lock',
    { ...authenticatedWrite, schema: { params: conversationParamsSchema, response: { 200: lockResultSchema } } },
    async (request) => setLock(request, request.params.conversationId, true),
  );

  app.post<{ Params: { conversationId: string } }>(
    '/conversations/:conversationId/unlock',
    { ...authenticatedWrite, schema: { params: conversationParamsSchema, response: { 200: lockResultSchema } } },
    async (request) => setLock(request, request.params.conversationId, false),
  );

  /** Administrators: every course conversation's state and size, never its messages. */
  app.get(
    '/admin/messaging/courses',
    { preValidation: [app.requireAuth, app.requireAdministrator], schema: { response: { 200: adminCourseConversationListSchema } } },
    async () => {
      const rows = await db
        .select({
          course: { id: courses.id, title: courses.title, code: courses.code },
          conversationId: conversations.id,
          lockedAt: conversations.lockedAt,
          lastMessageAt: conversations.lastMessageAt,
          messageCount: sql<number>`(SELECT count(*) FROM ${messages} m WHERE m.conversation_id = ${conversations.id})`.mapWith(Number),
        })
        .from(courses)
        .leftJoin(conversations, and(eq(conversations.courseId, courses.id), eq(conversations.kind, 'course')))
        .where(eq(courses.status, 'published'))
        .orderBy(asc(courses.code));
      return {
        items: rows.map((row) => ({
          course: row.course,
          conversationId: row.conversationId,
          locked: row.lockedAt !== null,
          messageCount: row.conversationId ? row.messageCount : 0,
          lastMessageAt: row.lastMessageAt,
        })),
      };
    },
  );
};

/** Moves a person's read position forward only (concurrent marks keep the highest). */
async function markRead(tx: Pick<Database, 'insert'>, conversationId: string, userId: string, seq: number) {
  await tx
    .insert(conversationReads)
    .values({ conversationId, userId, lastReadSeq: seq })
    .onConflictDoUpdate({
      target: [conversationReads.conversationId, conversationReads.userId],
      set: { lastReadSeq: sql`greatest(${conversationReads.lastReadSeq}, excluded.last_read_seq)`, updatedAt: sql`now()` },
    });
}

function messageView(row: { message: MessageRecord; senderName: string; senderRole: string | null }, viewerId: string) {
  const hidden = row.message.hiddenAt !== null;
  return {
    id: row.message.id,
    seq: row.message.seq,
    sender: { id: row.message.senderUserId, name: row.senderName, role: messagingRole(row.senderRole) },
    body: hidden ? null : row.message.body,
    hidden,
    mine: row.message.senderUserId === viewerId,
    createdAt: row.message.createdAt,
  };
}
