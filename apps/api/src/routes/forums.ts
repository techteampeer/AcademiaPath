/**
 * Course discussion forums (AP-027): topics and threaded replies in each published course, separate from
 * AP-026 conversations. Every request re-derives access from current active enrollments (see
 * `forumViewer`); nobody reads a topic by knowing its id.
 *
 * - Texts are plain text, never deleted, and never written to logs or audit records.
 * - Replies are numbered 1, 2, 3… within their topic while the topic row is locked, so the thread order is
 *   stable and gap-free under concurrent replies. A reply answers the topic or a reply to it (one level deep).
 * - Edit policy: authors edit their own topic or reply for `FORUM_EDIT_WINDOW_MINUTES` (30) after posting,
 *   while the topic is open, the post is visible and nobody has replied to it yet. Nobody edits someone
 *   else's post.
 * - Moderation (instructors of the course; administrators as institutional control): pin, lock, hide and
 *   restore topics; hide and restore replies. Every change is audited without any text. Hidden topics and
 *   replies (and replies to a hidden reply) are visible only to moderators: they are left out of lists,
 *   counts, previews, search and notifications, and a direct request for one is "not found".
 */
import { and, asc, count, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { recordAudit } from '../audit.js';
import { getAuth } from '../auth/hooks.js';
import type { SafeUser } from '../auth/types.js';
import type { Database } from '../db/client.js';
import { courses, enrollments, forumPosts, forumTopics, notifications, users } from '../db/schema/index.js';
import { FORUM_ROLES, forumRole, forumViewer, visiblePost, type ForumViewer } from '../forums/access.js';
import { ApiProblem, sendError } from '../http/errors.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';
import { notifyUsers, withdrawNotifications } from '../messaging/notify.js';
import {
  adminForumCourseListSchema,
  postInputSchema,
  postListQuerySchema,
  postModerationSchema,
  postPageSchema,
  postParamsSchema,
  postSchema,
  postUpdateSchema,
  topicInputSchema,
  topicListQuerySchema,
  topicModerationSchema,
  topicPageSchema,
  topicParamsSchema,
  topicSchema,
  topicUpdateSchema,
} from './forum-schemas.js';
import { courseParamsSchema } from './grading-schemas.js';

type TopicRecord = typeof forumTopics.$inferSelect;
type PostRecord = typeof forumPosts.$inferSelect;
type Reader = Pick<Database, 'select' | 'selectDistinctOn'>;
type Writer = Reader & Pick<Database, 'insert' | 'update' | 'execute'>;
type PostRow = { post: PostRecord; authorName: string; authorRole: string | null; childCount: number };
type TopicAction = 'pin' | 'unpin' | 'lock' | 'unlock' | 'hide' | 'restore';

const EXCERPT_LENGTH = 160;
const fullName = sql<string>`${users.givenName} || ' ' || ${users.familyName}`;
const topicNotFound = () => new ApiProblem(404, 'NOT_FOUND', 'Topic not found.');
const postNotFound = () => new ApiProblem(404, 'NOT_FOUND', 'Reply not found.');
const forbidden = (detail: string) => new ApiProblem(403, 'FORBIDDEN', detail);
const notPosting = () => forbidden('Administrators moderate course forums but do not post in them.');
const notModerator = () => forbidden('Only instructors of this course and administrators can moderate its forum.');
/** One notification per person and topic: later replies refresh it instead of adding another. */
const topicKey = (topicId: string) => `forum:${topicId}`;
const likePattern = (value: string) => `%${value.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1)}…` : flat;
};
/**
 * Outer-row references inside subqueries of select fields are spelled out: Drizzle leaves select-field columns
 * unqualified in single-table queries, where a bare "id" would bind to the subquery's own table.
 */
const OUTER_POST_ID = sql.raw('"forum_posts"."id"');
const OUTER_COURSE_ID = sql.raw('"courses"."id"');
const ACTIVITY_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

/** Topic list order: pinned first, then latest visible activity. The cursor holds all three sort keys. */
function decodeTopicCursor(cursor: string | undefined) {
  const decoded = decodeCursor(cursor, 'string');
  if (!decoded) return null;
  const [rank, activity] = [decoded.key.slice(0, 1), decoded.key.slice(2)];
  if (!['0', '1'].includes(rank) || decoded.key[1] !== '|' || !ACTIVITY_PATTERN.test(activity)) {
    throw new ApiProblem(400, 'INVALID_CURSOR', 'The pagination cursor is invalid.');
  }
  return { rank: Number(rank), activity, id: decoded.id };
}

export const forumRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app;
  const authenticated = { preValidation: [app.requireAuth] };
  const authenticatedWrite = { preValidation: [app.requireAuth, app.requireCsrf] };

  /** The caller's forum standing in a course: 404 when they cannot see it, 403 when it has no forum for them. */
  async function courseViewer(reader: Reader, user: SafeUser, courseId: string) {
    const viewer = await forumViewer(reader, user, courseId);
    if (viewer === 'not_found') throw new ApiProblem(404, 'NOT_FOUND', 'Course not found.');
    if (viewer === 'not_available') {
      throw new ApiProblem(403, 'FORUM_NOT_AVAILABLE', 'The course forum is for the students and teaching staff of a published course.');
    }
    return viewer;
  }

  /** A topic and the caller's standing in its forum; "not found" for anyone who may not read it. */
  async function topicContext(reader: Reader, user: SafeUser, topicId: string, lock?: 'update' | 'share') {
    const query = reader.select().from(forumTopics).where(eq(forumTopics.id, topicId));
    const [topic] = lock ? await query.for(lock) : await query;
    if (!topic) throw topicNotFound();
    const viewer = await forumViewer(reader, user, topic.courseId);
    if (typeof viewer === 'string') throw topicNotFound();
    if (topic.hiddenAt && !viewer.canModerate) throw topicNotFound();
    return { topic, viewer };
  }

  /** Whether the caller may edit one of their posts now, and the problem to report when not. */
  function editCheck(post: { authorUserId: string; createdAt: Date; hidden: boolean; hasReplies: boolean }, topic: TopicRecord, viewer: ForumViewer) {
    const minutes = config.forumEditWindowMinutes;
    const until = new Date(post.createdAt.getTime() + minutes * 60_000);
    let problem: ApiProblem | null = null;
    if (post.authorUserId !== viewer.userId || !viewer.canPost) problem = forbidden('Only its author can edit a post.');
    else if (post.hidden || topic.hiddenAt) problem = new ApiProblem(409, 'EDIT_NOT_ALLOWED', 'A hidden post cannot be edited.');
    else if (topic.lockedAt) problem = new ApiProblem(409, 'TOPIC_LOCKED', 'This topic is locked; its posts can no longer be edited.');
    else if (post.hasReplies) problem = new ApiProblem(409, 'EDIT_NOT_ALLOWED', 'A post that already has replies can no longer be edited.');
    else if (app.now().getTime() > until.getTime()) {
      problem = new ApiProblem(409, 'EDIT_WINDOW_CLOSED', `Posts can be edited for ${minutes} minutes after they are posted.`);
    }
    return { canEdit: problem === null, until: problem ? null : until, problem };
  }

  /** The list view of several topics of one course for one viewer, with a fixed number of queries. */
  async function topicSummaries(reader: Reader, viewer: ForumViewer, topics: TopicRecord[]) {
    if (!topics.length) return [];
    const ids = topics.map((t) => t.id);
    const visible = viewer.canModerate ? undefined : visiblePost();
    const authors = await reader
      .select({ id: users.id, name: fullName, role: enrollments.role })
      .from(users)
      .leftJoin(enrollments, and(eq(enrollments.userId, users.id), eq(enrollments.courseId, viewer.course.id)))
      .where(inArray(users.id, [...new Set(topics.map((t) => t.authorUserId))]));
    const authorBy = new Map(authors.map((a) => [a.id, a]));
    const counts = await reader
      .select({ topicId: forumPosts.topicId, n: count() })
      .from(forumPosts)
      .where(and(inArray(forumPosts.topicId, ids), visible))
      .groupBy(forumPosts.topicId);
    const countBy = new Map(counts.map((c) => [c.topicId, c.n]));
    const lasts = await reader
      .selectDistinctOn([forumPosts.topicId], { topicId: forumPosts.topicId, authorName: fullName, createdAt: forumPosts.createdAt })
      .from(forumPosts)
      .innerJoin(users, eq(users.id, forumPosts.authorUserId))
      .where(and(inArray(forumPosts.topicId, ids), visible))
      .orderBy(forumPosts.topicId, desc(forumPosts.postNumber));
    const lastBy = new Map(lasts.map((l) => [l.topicId, l]));
    return topics.map((topic) => {
      const author = authorBy.get(topic.authorUserId);
      const last = lastBy.get(topic.id);
      return {
        id: topic.id,
        title: topic.title,
        excerpt: excerpt(topic.body),
        author: { id: topic.authorUserId, name: author?.name ?? '', role: forumRole(author?.role) },
        mine: topic.authorUserId === viewer.userId,
        pinned: topic.pinnedAt !== null,
        locked: topic.lockedAt !== null,
        hidden: topic.hiddenAt !== null,
        replyCount: countBy.get(topic.id) ?? 0,
        lastReply: last ? { authorName: last.authorName, createdAt: last.createdAt } : null,
        lastActivityAt: topic.lastActivityAt,
        createdAt: topic.createdAt,
        editedAt: topic.editedAt,
      };
    });
  }

  async function topicView(reader: Reader, viewer: ForumViewer, topic: TopicRecord) {
    const [summary] = await topicSummaries(reader, viewer, [topic]);
    const edit = editCheck({ authorUserId: topic.authorUserId, createdAt: topic.createdAt, hidden: false, hasReplies: topic.lastPostNumber > 0 }, topic, viewer);
    return {
      ...summary!,
      course: { id: viewer.course.id, title: viewer.course.title, code: viewer.course.code },
      body: topic.body,
      canReply: viewer.canPost && !topic.hiddenAt && (!topic.lockedAt || viewer.canModerate),
      canEdit: edit.canEdit,
      canModerate: viewer.canModerate,
      editableUntil: edit.until,
    };
  }

  function postRows(reader: Reader) {
    return reader
      .select({
        post: forumPosts,
        authorName: fullName,
        authorRole: enrollments.role,
        childCount: sql<number>`(SELECT count(*) FROM ${forumPosts} cp WHERE cp.parent_post_id = ${OUTER_POST_ID})::int`,
      })
      .from(forumPosts)
      .innerJoin(users, eq(users.id, forumPosts.authorUserId))
      .leftJoin(enrollments, and(eq(enrollments.userId, forumPosts.authorUserId), eq(enrollments.courseId, forumPosts.courseId)));
  }

  function postView(row: PostRow, topic: TopicRecord, viewer: ForumViewer) {
    const { post } = row;
    const edit = editCheck({ authorUserId: post.authorUserId, createdAt: post.createdAt, hidden: post.hiddenAt !== null, hasReplies: row.childCount > 0 }, topic, viewer);
    return {
      id: post.id,
      number: post.postNumber,
      parentPostId: post.parentPostId,
      author: { id: post.authorUserId, name: row.authorName, role: forumRole(row.authorRole) },
      body: post.body,
      hidden: post.hiddenAt !== null,
      mine: post.authorUserId === viewer.userId,
      canEdit: edit.canEdit,
      editableUntil: edit.until,
      createdAt: post.createdAt,
      editedAt: post.editedAt,
    };
  }

  /** A reply and its topic with the caller's standing; "not found" for anyone who may not see the reply. */
  async function postContext(tx: Writer, user: SafeUser, postId: string) {
    const [found] = await tx.select({ topicId: forumPosts.topicId }).from(forumPosts).where(eq(forumPosts.id, postId));
    if (!found) throw postNotFound();
    // Topic before reply: the same lock order as posting a reply.
    const { topic, viewer } = await topicContext(tx, user, found.topicId, 'update');
    const [row] = await postRows(tx).where(eq(forumPosts.id, postId)).for('update', { of: forumPosts });
    if (!row) throw postNotFound();
    const [parent] = row.post.parentPostId ? await tx.select().from(forumPosts).where(eq(forumPosts.id, row.post.parentPostId)) : [];
    const visible = row.post.hiddenAt === null && !parent?.hiddenAt;
    if (!visible && !viewer.canModerate) throw postNotFound();
    return { topic, viewer, row };
  }

  /** Counted in PostgreSQL across topics and replies, so the limit holds across API instances. */
  async function rateLimited(tx: Writer, userId: string): Promise<number | null> {
    const { max, windowMinutes } = config.forumRateLimit;
    const result = await tx.execute<{ n: number; retry: number | null }>(sql`
      SELECT count(*)::int AS n,
             ceil(extract(epoch FROM (min(created_at) + make_interval(mins => ${windowMinutes}) - now())))::int AS retry
      FROM (
        SELECT created_at FROM ${forumTopics} WHERE author_user_id = ${userId} AND created_at > now() - make_interval(mins => ${windowMinutes})
        UNION ALL
        SELECT created_at FROM ${forumPosts} WHERE author_user_id = ${userId} AND created_at > now() - make_interval(mins => ${windowMinutes})
      ) recent`);
    const row = result.rows[0];
    return row && row.n >= max ? Math.max(1, row.retry ?? 60) : null;
  }

  /** Of these people, those who can currently read the course forum (active account and enrollment). */
  async function forumParticipants(tx: Writer, courseId: string, userIds: string[]) {
    if (!userIds.length) return [];
    const rows = await tx
      .select({ id: users.id })
      .from(enrollments)
      .innerJoin(users, eq(users.id, enrollments.userId))
      .where(and(eq(enrollments.courseId, courseId), eq(enrollments.status, 'active'), eq(users.isActive, true), inArray(enrollments.role, [...FORUM_ROLES]), inArray(users.id, userIds)));
    return rows.map((row) => row.id);
  }

  /** The topic's latest visible activity, after a reply was hidden or restored. */
  async function refreshActivity(tx: Writer, topicId: string) {
    await tx
      .update(forumTopics)
      .set({
        lastActivityAt: sql`greatest(${forumTopics.createdAt}, coalesce((
          SELECT max(ap.created_at) FROM ${forumPosts} ap LEFT JOIN ${forumPosts} app ON app.id = ap.parent_post_id
          WHERE ap.topic_id = ${topicId} AND ap.hidden_at IS NULL AND app.hidden_at IS NULL), ${forumTopics.createdAt}))`,
        updatedAt: sql`now()`,
      })
      .where(eq(forumTopics.id, topicId));
  }

  const nameOf = (user: SafeUser) => `${user.givenName} ${user.familyName}`.trim();
  /** An edit always records a later edit time than the previous one. */
  const editTime = (previous: Date | null) => new Date(Math.max(app.now().getTime(), (previous?.getTime() ?? 0) + 1));

  // ---- Topics ----

  app.get<{ Params: { id: string }; Querystring: { limit: number; cursor?: string; q?: string } }>(
    '/courses/:id/forum/topics',
    { ...authenticated, schema: { params: courseParamsSchema, querystring: topicListQuerySchema, response: { 200: topicPageSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      const viewer = await courseViewer(db, user, request.params.id);
      const { limit } = request.query;
      const cursor = decodeTopicCursor(request.query.cursor);
      const q = request.query.q?.trim();
      const pattern = q ? likePattern(q) : null;
      const rank = sql<number>`(CASE WHEN ${forumTopics.pinnedAt} IS NULL THEN 0 ELSE 1 END)`;
      const replyVisible = viewer.canModerate ? sql`` : sql`AND sp.hidden_at IS NULL AND spp.hidden_at IS NULL`;
      const rows = await db
        .select({ topic: forumTopics, rank, activity: sql<string>`${forumTopics.lastActivityAt}::text` })
        .from(forumTopics)
        .where(
          and(
            eq(forumTopics.courseId, viewer.course.id),
            viewer.canModerate ? undefined : isNull(forumTopics.hiddenAt),
            pattern
              ? or(
                  sql`lower(${forumTopics.title}) LIKE ${pattern}`,
                  sql`lower(${forumTopics.body}) LIKE ${pattern}`,
                  sql`EXISTS (SELECT 1 FROM ${forumPosts} sp LEFT JOIN ${forumPosts} spp ON spp.id = sp.parent_post_id
                      WHERE sp.topic_id = ${forumTopics.id} AND lower(sp.body) LIKE ${pattern} ${replyVisible})`,
                )
              : undefined,
            cursor ? sql`(${rank}, ${forumTopics.lastActivityAt}, ${forumTopics.id}) < (${cursor.rank}, ${cursor.activity}::timestamptz, ${cursor.id}::uuid)` : undefined,
          ),
        )
        .orderBy(desc(rank), desc(forumTopics.lastActivityAt), desc(forumTopics.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        course: { id: viewer.course.id, title: viewer.course.title, code: viewer.course.code },
        viewer: { role: viewer.role, canPost: viewer.canPost, canModerate: viewer.canModerate },
        items: await topicSummaries(db, viewer, page.map((row) => row.topic)),
        nextCursor: rows.length > limit && last ? encodeCursor(`${last.rank}|${last.activity}`, last.topic.id) : null,
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { title: string; body: string; clientRequestId: string; announce: boolean } }>(
    '/courses/:id/forum/topics',
    { ...authenticatedWrite, schema: { params: courseParamsSchema, body: topicInputSchema, response: { 200: topicSchema, 201: topicSchema } } },
    async (request, reply) => {
      const { user } = getAuth(request);
      const input = request.body;
      const outcome = await db.transaction(async (tx) => {
        // One post at a time per person: the rate limit and the retry check are exact under concurrency.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`forum-author:${user.id}`}, 0))`);
        const viewer = await courseViewer(tx, user, request.params.id);
        if (!viewer.canPost) throw notPosting();
        const [existing] = await tx
          .select()
          .from(forumTopics)
          .where(and(eq(forumTopics.courseId, viewer.course.id), eq(forumTopics.authorUserId, user.id), eq(forumTopics.clientRequestId, input.clientRequestId)));
        if (existing) {
          // A retry of a topic that was hidden since: like any hidden topic, it does not exist for participants.
          if (existing.hiddenAt && !viewer.canModerate) throw topicNotFound();
          return { kind: 'existing' as const, topic: existing, viewer };
        }
        if (input.announce && !viewer.canModerate) throw forbidden('Only instructors of this course can announce a topic to the class.');
        const retryAfter = await rateLimited(tx, user.id);
        if (retryAfter) return { kind: 'limited' as const, retryAfter };
        const [topic] = await tx
          .insert(forumTopics)
          .values({ courseId: viewer.course.id, authorUserId: user.id, title: input.title.trim(), body: input.body.trim(), clientRequestId: input.clientRequestId })
          .returning();
        if (!topic) throw new Error('Topic was not recorded');
        if (input.announce) {
          const recipients = await tx
            .select({ id: users.id })
            .from(enrollments)
            .innerJoin(users, eq(users.id, enrollments.userId))
            .where(and(eq(enrollments.courseId, viewer.course.id), eq(enrollments.status, 'active'), eq(users.isActive, true), inArray(enrollments.role, [...FORUM_ROLES])));
          await notifyUsers(
            tx,
            recipients.map((r) => r.id).filter((id) => id !== user.id),
            { type: 'forum_topic', courseId: viewer.course.id, entityId: topic.id, dedupeKey: topicKey(topic.id), data: { topicTitle: topic.title, authorName: nameOf(user), courseCode: viewer.course.code }, at: app.now() },
          );
        }
        return { kind: 'created' as const, topic, viewer };
      });
      if (outcome.kind === 'limited') {
        reply.header('retry-after', String(outcome.retryAfter));
        return sendError(reply, 429, 'RATE_LIMITED', 'Too many forum posts. Try again in a moment.');
      }
      return reply.code(outcome.kind === 'created' ? 201 : 200).send(await topicView(db, outcome.viewer, outcome.topic));
    },
  );

  app.get<{ Params: { topicId: string } }>(
    '/forum/topics/:topicId',
    { ...authenticated, schema: { params: topicParamsSchema, response: { 200: topicSchema } } },
    async (request) => {
      const { topic, viewer } = await topicContext(db, getAuth(request).user, request.params.topicId);
      return topicView(db, viewer, topic);
    },
  );

  app.patch<{ Params: { topicId: string }; Body: { title?: string; body?: string } }>(
    '/forum/topics/:topicId',
    { ...authenticatedWrite, schema: { params: topicParamsSchema, body: topicUpdateSchema, response: { 200: topicSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      return db.transaction(async (tx) => {
        const { topic, viewer } = await topicContext(tx, user, request.params.topicId, 'update');
        const check = editCheck({ authorUserId: topic.authorUserId, createdAt: topic.createdAt, hidden: false, hasReplies: topic.lastPostNumber > 0 }, topic, viewer);
        if (check.problem) throw check.problem;
        const title = request.body.title?.trim() ?? topic.title;
        const body = request.body.body?.trim() ?? topic.body;
        if (title === topic.title && body === topic.body) return topicView(tx, viewer, topic);
        const [updated] = await tx.update(forumTopics).set({ title, body, editedAt: editTime(topic.editedAt), updatedAt: sql`now()` }).where(eq(forumTopics.id, topic.id)).returning();
        return topicView(tx, viewer, updated!);
      });
    },
  );

  /** Pin, lock and hide (and undo each) a topic. Administrators may do this in any published course. */
  app.post<{ Params: { topicId: string }; Body: { action: TopicAction } }>(
    '/forum/topics/:topicId/moderation',
    { ...authenticatedWrite, schema: { params: topicParamsSchema, body: topicModerationSchema, response: { 200: topicSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      const { action } = request.body;
      return db.transaction(async (tx) => {
        const { topic, viewer } = await topicContext(tx, user, request.params.topicId, 'update');
        if (!viewer.canModerate) throw notModerator();
        const now = app.now();
        const field = { pin: 'pinned', unpin: 'pinned', lock: 'locked', unlock: 'locked', hide: 'hidden', restore: 'hidden' }[action] as 'pinned' | 'locked' | 'hidden';
        const on = action === 'pin' || action === 'lock' || action === 'hide';
        const current = { pinned: topic.pinnedAt, locked: topic.lockedAt, hidden: topic.hiddenAt }[field] !== null;
        if (current === on) return topicView(tx, viewer, topic);
        const set = {
          pinned: on ? { pinnedAt: now, pinnedByUserId: user.id } : { pinnedAt: null, pinnedByUserId: null },
          locked: on ? { lockedAt: now, lockedByUserId: user.id } : { lockedAt: null, lockedByUserId: null },
          hidden: on ? { hiddenAt: now, hiddenByUserId: user.id } : { hiddenAt: null, hiddenByUserId: null },
        }[field];
        const [updated] = await tx.update(forumTopics).set({ ...set, updatedAt: sql`now()` }).where(eq(forumTopics.id, topic.id)).returning();
        // A hidden topic's notifications are withdrawn for good (restoring it does not notify again).
        if (action === 'hide') await withdrawNotifications(tx, topicKey(topic.id), now);
        await recordAudit(tx, request, {
          action: `forum.topic.${{ pin: 'pinned', unpin: 'unpinned', lock: 'locked', unlock: 'unlocked', hide: 'hidden', restore: 'restored' }[action]}`,
          entityType: 'forum_topic',
          entityId: topic.id,
          // Never the title or text.
          before: { [field]: current },
          after: { [field]: on, courseId: topic.courseId, authorUserId: topic.authorUserId, byAdministrator: viewer.role === null },
        });
        return topicView(tx, viewer, updated!);
      });
    },
  );

  // ---- Replies ----

  app.get<{ Params: { topicId: string }; Querystring: { after?: number; limit: number } }>(
    '/forum/topics/:topicId/posts',
    { ...authenticated, schema: { params: topicParamsSchema, querystring: postListQuerySchema, response: { 200: postPageSchema } } },
    async (request) => {
      const { topic, viewer } = await topicContext(db, getAuth(request).user, request.params.topicId);
      const { after, limit } = request.query;
      const visible = viewer.canModerate ? undefined : visiblePost();
      // A page holds replies to the topic in order, each with all the replies to it.
      const top = await postRows(db)
        .where(and(eq(forumPosts.topicId, topic.id), isNull(forumPosts.parentPostId), after !== undefined ? gt(forumPosts.postNumber, after) : undefined, visible))
        .orderBy(asc(forumPosts.postNumber))
        .limit(limit + 1);
      const page = top.slice(0, limit);
      const children = page.length
        ? await postRows(db)
            .where(and(inArray(forumPosts.parentPostId, page.map((row) => row.post.id)), viewer.canModerate ? undefined : isNull(forumPosts.hiddenAt)))
            .orderBy(asc(forumPosts.postNumber))
        : [];
      const [total] = await db.select({ n: count() }).from(forumPosts).where(and(eq(forumPosts.topicId, topic.id), visible));
      return {
        items: page.map((row) => ({
          ...postView(row, topic, viewer),
          replies: children.filter((child) => child.post.parentPostId === row.post.id).map((child) => postView(child, topic, viewer)),
        })),
        nextCursor: top.length > limit ? page.at(-1)!.post.postNumber : null,
        total: total?.n ?? 0,
      };
    },
  );

  app.post<{ Params: { topicId: string }; Body: { body: string; clientRequestId: string; parentPostId?: string } }>(
    '/forum/topics/:topicId/posts',
    { ...authenticatedWrite, schema: { params: topicParamsSchema, body: postInputSchema, response: { 200: postSchema, 201: postSchema } } },
    async (request, reply) => {
      const { user } = getAuth(request);
      const input = request.body;
      const outcome = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`forum-author:${user.id}`}, 0))`);
        // The topic row stays locked until commit: replies are numbered in commit order, and a concurrent
        // lock or hide cannot interleave.
        const { topic, viewer } = await topicContext(tx, user, request.params.topicId, 'update');
        if (!viewer.canPost) throw notPosting();
        const [existing] = await postRows(tx).where(
          and(eq(forumPosts.topicId, topic.id), eq(forumPosts.authorUserId, user.id), eq(forumPosts.clientRequestId, input.clientRequestId)),
        );
        if (existing) {
          // A retry of a reply that was hidden since (or answers a hidden reply) is "not found" for participants.
          const [parentOfExisting] = existing.post.parentPostId ? await tx.select({ hiddenAt: forumPosts.hiddenAt }).from(forumPosts).where(eq(forumPosts.id, existing.post.parentPostId)) : [];
          if (!viewer.canModerate && (existing.post.hiddenAt || parentOfExisting?.hiddenAt)) throw postNotFound();
          return { kind: 'existing' as const, row: existing, topic, viewer };
        }
        if (topic.hiddenAt) throw new ApiProblem(409, 'TOPIC_HIDDEN', 'This topic is hidden; restore it before replying.');
        if (topic.lockedAt && !viewer.canModerate) throw new ApiProblem(409, 'TOPIC_LOCKED', 'This topic is locked; no new replies can be posted.');
        let parent: PostRecord | undefined;
        if (input.parentPostId) {
          [parent] = await tx.select().from(forumPosts).where(and(eq(forumPosts.id, input.parentPostId), eq(forumPosts.topicId, topic.id)));
          // For participants, a hidden reply (or a reply under one) does not exist.
          const [grandparent] = parent?.parentPostId ? await tx.select().from(forumPosts).where(eq(forumPosts.id, parent.parentPostId)) : [];
          if (!parent || (!viewer.canModerate && (parent.hiddenAt || grandparent?.hiddenAt))) throw postNotFound();
          if (parent.parentPostId) throw new ApiProblem(422, 'REPLY_NESTING_LIMIT', 'Replies to replies are one level deep: answer the original reply instead.');
          if (parent.hiddenAt) throw new ApiProblem(409, 'POST_HIDDEN', 'This reply is hidden; restore it before answering it.');
        }
        const retryAfter = await rateLimited(tx, user.id);
        if (retryAfter) return { kind: 'limited' as const, retryAfter };
        const [counter] = await tx
          .update(forumTopics)
          .set({ lastPostNumber: sql`${forumTopics.lastPostNumber} + 1`, lastActivityAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(forumTopics.id, topic.id))
          .returning({ number: forumTopics.lastPostNumber });
        const [post] = await tx
          .insert(forumPosts)
          .values({
            courseId: topic.courseId,
            topicId: topic.id,
            parentPostId: parent?.id ?? null,
            postNumber: counter!.number,
            authorUserId: user.id,
            body: input.body.trim(),
            clientRequestId: input.clientRequestId,
          })
          .returning();
        if (!post) throw new Error('Reply was not recorded');
        // The topic's author and the answered reply's author hear about it, while they can still read the forum.
        const recipients = [...new Set([topic.authorUserId, parent?.authorUserId].filter((id): id is string => Boolean(id) && id !== user.id))];
        await notifyUsers(tx, await forumParticipants(tx, topic.courseId, recipients), {
          type: 'forum_reply',
          courseId: topic.courseId,
          entityId: topic.id,
          dedupeKey: topicKey(topic.id),
          data: { topicTitle: topic.title, authorName: nameOf(user), courseCode: viewer.course.code, postId: post.id },
          at: app.now(),
        });
        const row: PostRow = { post, authorName: nameOf(user), authorRole: viewer.role, childCount: 0 };
        return { kind: 'created' as const, row, topic: { ...topic, lastPostNumber: counter!.number }, viewer };
      });
      if (outcome.kind === 'limited') {
        reply.header('retry-after', String(outcome.retryAfter));
        return sendError(reply, 429, 'RATE_LIMITED', 'Too many forum posts. Try again in a moment.');
      }
      return reply.code(outcome.kind === 'created' ? 201 : 200).send(postView(outcome.row, outcome.topic, outcome.viewer));
    },
  );

  app.patch<{ Params: { postId: string }; Body: { body: string } }>(
    '/forum/posts/:postId',
    { ...authenticatedWrite, schema: { params: postParamsSchema, body: postUpdateSchema, response: { 200: postSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      return db.transaction(async (tx) => {
        const { topic, viewer, row } = await postContext(tx, user, request.params.postId);
        const check = editCheck({ authorUserId: row.post.authorUserId, createdAt: row.post.createdAt, hidden: row.post.hiddenAt !== null, hasReplies: row.childCount > 0 }, topic, viewer);
        if (check.problem) throw check.problem;
        const body = request.body.body.trim();
        if (body === row.post.body) return postView(row, topic, viewer);
        const [post] = await tx.update(forumPosts).set({ body, editedAt: editTime(row.post.editedAt) }).where(eq(forumPosts.id, row.post.id)).returning();
        return postView({ ...row, post: post! }, topic, viewer);
      });
    },
  );

  app.post<{ Params: { postId: string }; Body: { action: 'hide' | 'restore' } }>(
    '/forum/posts/:postId/moderation',
    { ...authenticatedWrite, schema: { params: postParamsSchema, body: postModerationSchema, response: { 200: postSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      const hide = request.body.action === 'hide';
      return db.transaction(async (tx) => {
        const { topic, viewer, row } = await postContext(tx, user, request.params.postId);
        if (!viewer.canModerate) throw notModerator();
        if ((row.post.hiddenAt !== null) === hide) return postView(row, topic, viewer);
        const now = app.now();
        const [post] = await tx
          .update(forumPosts)
          .set(hide ? { hiddenAt: now, hiddenByUserId: user.id } : { hiddenAt: null, hiddenByUserId: null })
          .where(eq(forumPosts.id, row.post.id))
          .returning();
        if (hide) {
          // Notifications announcing this reply or a reply to it are withdrawn for good.
          await tx
            .update(notifications)
            .set({ withdrawnAt: now })
            .where(
              and(
                eq(notifications.dedupeKey, topicKey(topic.id)),
                isNull(notifications.withdrawnAt),
                sql`${notifications.data} ->> 'postId' IN (SELECT wp.id::text FROM ${forumPosts} wp WHERE wp.id = ${row.post.id} OR wp.parent_post_id = ${row.post.id})`,
              ),
            );
        }
        await refreshActivity(tx, topic.id);
        await recordAudit(tx, request, {
          action: hide ? 'forum.post.hidden' : 'forum.post.restored',
          entityType: 'forum_post',
          entityId: row.post.id,
          // Never the text itself.
          before: { hidden: !hide },
          after: { hidden: hide, courseId: topic.courseId, topicId: topic.id, authorUserId: row.post.authorUserId, length: row.post.body.length, byAdministrator: viewer.role === null },
        });
        return postView({ ...row, post: post! }, topic, viewer);
      });
    },
  );

  /** Administrators: each published course's forum activity and moderation state, as counts only. */
  app.get(
    '/admin/forums/courses',
    { preValidation: [app.requireAuth, app.requireAdministrator], schema: { response: { 200: adminForumCourseListSchema } } },
    async () => {
      const rows = await db
        .select({
          course: { id: courses.id, title: courses.title, code: courses.code },
          topicCount: sql<number>`(SELECT count(*) FROM ${forumTopics} t WHERE t.course_id = ${OUTER_COURSE_ID})::int`,
          lockedTopicCount: sql<number>`(SELECT count(*) FROM ${forumTopics} t WHERE t.course_id = ${OUTER_COURSE_ID} AND t.locked_at IS NOT NULL)::int`,
          hiddenTopicCount: sql<number>`(SELECT count(*) FROM ${forumTopics} t WHERE t.course_id = ${OUTER_COURSE_ID} AND t.hidden_at IS NOT NULL)::int`,
          replyCount: sql<number>`(SELECT count(*) FROM ${forumPosts} p WHERE p.course_id = ${OUTER_COURSE_ID})::int`,
          hiddenReplyCount: sql<number>`(SELECT count(*) FROM ${forumPosts} p WHERE p.course_id = ${OUTER_COURSE_ID} AND p.hidden_at IS NOT NULL)::int`,
          lastActivityAt: sql<Date | null>`(SELECT max(t.last_activity_at) FROM ${forumTopics} t WHERE t.course_id = ${OUTER_COURSE_ID})`.mapWith(forumTopics.lastActivityAt),
        })
        .from(courses)
        .where(eq(courses.status, 'published'))
        .orderBy(asc(courses.code));
      return { items: rows };
    },
  );
};

