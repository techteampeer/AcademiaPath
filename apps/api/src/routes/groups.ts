/**
 * Student groups (AP-028): instructor-managed collections of a course's students, each with a private
 * workspace. A group's discussions are course-forum topics scoped to it (see routes/forums.ts); this file
 * manages the groups, their members and the workspace overview.
 *
 * - Access is derived from current data on every request (see groups/access.ts). Anyone who may not see a
 *   group gets "not found"; administrators manage groups but never read their discussions.
 * - Membership changes lock the group row, so concurrent changes are serialized; an open membership is
 *   unique per student and group, so a repeated add is a no-op. Removing a member closes the membership at
 *   once: every later request of theirs is re-checked against it.
 * - Archiving keeps everything as read-only history. Nothing is deleted (enforced by triggers), and every
 *   management change is audited without discussion text.
 */
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit.js';
import { getAuth } from '../auth/hooks.js';
import type { SafeUser } from '../auth/types.js';
import type { Database } from '../db/client.js';
import { withUniqueConflict } from '../db/errors.js';
import { courses, enrollments, forumTopics, notifications, studentGroupMembers, studentGroups, users } from '../db/schema/index.js';
import { courseGroupsViewer, groupContext, type CourseGroupsViewer, type GroupContext, type GroupRecord } from '../groups/access.js';
import { ApiProblem } from '../http/errors.js';
import { visibleTo } from '../messaging/notify.js';
import { courseParamsSchema } from './grading-schemas.js';
import {
  adminGroupOverviewSchema,
  courseGroupListSchema,
  groupDetailSchema,
  groupInputSchema,
  groupMemberParamsSchema,
  groupParamsSchema,
  groupUpdateSchema,
  memberAddResultSchema,
  memberAddSchema,
  memberRemoveResultSchema,
  myGroupListSchema,
} from './group-schemas.js';

type Reader = Pick<Database, 'select'>;

const fullName = sql<string>`${users.givenName} || ' ' || ${users.familyName}`;
const groupNotFound = () => new ApiProblem(404, 'NOT_FOUND', 'Group not found.');
const notManager = () => new ApiProblem(403, 'FORBIDDEN', "Only the course's instructors and administrators manage its groups.");
const archived = () => new ApiProblem(409, 'GROUP_ARCHIVED', 'This group is archived: restore it before changing it.');
const NAME_CONSTRAINT = 'student_groups_course_name_unique';
const nameTaken = () => new ApiProblem(409, 'GROUP_NAME_TAKEN', 'Another active group of this course already has this name.');
/** Current members: open membership, active student enrollment, active account. */
const currentMember = and(
  isNull(studentGroupMembers.removedAt),
  eq(enrollments.status, 'active'),
  eq(enrollments.role, 'student'),
  eq(users.isActive, true),
);

export const groupRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const authenticated = { preValidation: [app.requireAuth] };
  const authenticatedWrite = { preValidation: [app.requireAuth, app.requireCsrf] };

  async function courseViewer(reader: Reader, user: SafeUser, courseId: string) {
    const viewer = await courseGroupsViewer(reader, user, courseId);
    if (viewer === 'not_found') throw new ApiProblem(404, 'NOT_FOUND', 'Course not found.');
    if (viewer === 'not_available') throw new ApiProblem(403, 'GROUPS_NOT_AVAILABLE', "Student groups are for the course's students, teaching staff and administrators.");
    return viewer;
  }

  /** A group and the caller's standing; with `lock`, the group row is locked for a management change. */
  async function loadGroup(reader: Reader, user: SafeUser, groupId: string, lock = false) {
    const query = reader.select().from(studentGroups).where(eq(studentGroups.id, groupId));
    const [group] = lock ? await query.for('update') : await query;
    if (!group) throw groupNotFound();
    const ctx = await groupContext(reader, user, group);
    if (!ctx) throw groupNotFound();
    return ctx;
  }

  /** List views of several groups for one caller, with a fixed number of queries. */
  async function summaries(reader: Reader, userId: string, groups: GroupRecord[], options: { moderatorCourseIds: Set<string>; memberOf: Set<string> }) {
    if (!groups.length) return [];
    const ids = groups.map((g) => g.id);
    const memberCounts = await reader
      .select({ groupId: studentGroupMembers.groupId, n: count() })
      .from(studentGroupMembers)
      .innerJoin(enrollments, and(eq(enrollments.courseId, studentGroupMembers.courseId), eq(enrollments.userId, studentGroupMembers.userId)))
      .innerJoin(users, eq(users.id, studentGroupMembers.userId))
      .where(and(inArray(studentGroupMembers.groupId, ids), currentMember))
      .groupBy(studentGroupMembers.groupId);
    const memberBy = new Map(memberCounts.map((r) => [r.groupId, r.n]));
    const topics = await reader
      .select({ groupId: forumTopics.groupId, courseId: forumTopics.courseId, hidden: sql<boolean>`${forumTopics.hiddenAt} IS NOT NULL`, lastActivityAt: forumTopics.lastActivityAt })
      .from(forumTopics)
      .where(inArray(forumTopics.groupId, ids));
    const unread = await reader
      .select({ groupId: forumTopics.groupId, n: count() })
      .from(notifications)
      .innerJoin(forumTopics, eq(forumTopics.id, notifications.entityId))
      .where(and(visibleTo(userId, app.now()), isNull(notifications.readAt), inArray(notifications.type, ['forum_reply', 'forum_topic']), inArray(forumTopics.groupId, ids)))
      .groupBy(forumTopics.groupId);
    const unreadBy = new Map(unread.map((r) => [r.groupId, r.n]));
    const courseRows = await reader
      .select({ id: courses.id, title: courses.title, code: courses.code })
      .from(courses)
      .where(inArray(courses.id, [...new Set(groups.map((g) => g.courseId))]));
    const courseBy = new Map(courseRows.map((c) => [c.id, c]));
    return groups.map((g) => {
      // Hidden topics count only for the course's moderators.
      const seen = topics.filter((t) => t.groupId === g.id && (!t.hidden || options.moderatorCourseIds.has(g.courseId)));
      const last = seen.reduce<Date | null>((latest, t) => (!latest || t.lastActivityAt > latest ? t.lastActivityAt : latest), null);
      return {
        id: g.id,
        course: courseBy.get(g.courseId)!,
        name: g.name,
        description: g.description,
        archived: g.archivedAt !== null,
        isMember: options.memberOf.has(g.id),
        memberCount: memberBy.get(g.id) ?? 0,
        topicCount: seen.length,
        lastActivityAt: last,
        unreadCount: unreadBy.get(g.id) ?? 0,
        createdAt: g.createdAt,
      };
    });
  }

  /** The groups a person currently belongs to (optionally in one course). */
  async function memberGroupIds(reader: Reader, userId: string, courseId?: string) {
    const rows = await reader
      .select({ groupId: studentGroupMembers.groupId })
      .from(studentGroupMembers)
      .innerJoin(enrollments, and(eq(enrollments.courseId, studentGroupMembers.courseId), eq(enrollments.userId, studentGroupMembers.userId)))
      .innerJoin(users, eq(users.id, studentGroupMembers.userId))
      .innerJoin(courses, eq(courses.id, studentGroupMembers.courseId))
      .where(and(eq(studentGroupMembers.userId, userId), currentMember, eq(courses.status, 'published'), courseId ? eq(studentGroupMembers.courseId, courseId) : undefined));
    return new Set(rows.map((r) => r.groupId));
  }

  const moderatorCourses = (viewer: CourseGroupsViewer) => new Set(viewer.role === 'instructor' && viewer.staffReader ? [viewer.course.id] : []);

  /** The workspace overview of one group for one caller. */
  async function detail(reader: Reader, ctx: GroupContext) {
    const { group, viewer } = ctx;
    const [summary] = await summaries(reader, viewer.userId, [group], { moderatorCourseIds: ctx.canModerate ? new Set([group.courseId]) : new Set(), memberOf: new Set(ctx.isMember ? [group.id] : []) });
    const members = await reader
      .select({ id: users.id, name: fullName, addedAt: studentGroupMembers.addedAt })
      .from(studentGroupMembers)
      .innerJoin(enrollments, and(eq(enrollments.courseId, studentGroupMembers.courseId), eq(enrollments.userId, studentGroupMembers.userId)))
      .innerJoin(users, eq(users.id, studentGroupMembers.userId))
      .where(and(eq(studentGroupMembers.groupId, group.id), currentMember))
      .orderBy(asc(users.familyName), asc(users.givenName));
    const recentTopics = ctx.canRead
      ? (
          await reader
            .select({
              id: forumTopics.id,
              title: forumTopics.title,
              lastActivityAt: forumTopics.lastActivityAt,
              pinned: sql<boolean>`${forumTopics.pinnedAt} IS NOT NULL`,
              locked: sql<boolean>`${forumTopics.lockedAt} IS NOT NULL`,
              replyCount: sql<number>`(SELECT count(*) FROM forum_posts rp LEFT JOIN forum_posts rpp ON rpp.id = rp.parent_post_id
                WHERE rp.topic_id = ${sql.raw('"forum_topics"."id"')} ${ctx.canModerate ? sql`` : sql`AND rp.hidden_at IS NULL AND rpp.hidden_at IS NULL`})::int`,
            })
            .from(forumTopics)
            .where(and(eq(forumTopics.groupId, group.id), ctx.canModerate ? undefined : isNull(forumTopics.hiddenAt)))
            .orderBy(desc(forumTopics.lastActivityAt))
            .limit(5)
        )
      : [];
    let membershipChanges: Array<{ kind: string; person: { id: string; name: string } | null; actor: { id: string; name: string } | null; at: Date }> = [];
    let candidates: Array<{ id: string; name: string }> = [];
    if (viewer.canViewAll) {
      const rows = await reader.select().from(studentGroupMembers).where(eq(studentGroupMembers.groupId, group.id));
      const peopleIds = [...new Set([group.createdByUserId, group.archivedByUserId, ...rows.flatMap((r) => [r.userId, r.addedByUserId, r.removedByUserId])].filter((id): id is string => Boolean(id)))];
      const people = await reader.select({ id: users.id, name: fullName }).from(users).where(inArray(users.id, peopleIds));
      const person = (id: string | null) => (id ? people.find((p) => p.id === id) ?? null : null);
      membershipChanges = [
        { kind: 'group_created', person: null, actor: person(group.createdByUserId), at: group.createdAt },
        ...rows.map((r) => ({ kind: 'member_added', person: person(r.userId), actor: person(r.addedByUserId), at: r.addedAt })),
        ...rows.filter((r) => r.removedAt).map((r) => ({ kind: 'member_removed', person: person(r.userId), actor: person(r.removedByUserId), at: r.removedAt! })),
        ...(group.archivedAt ? [{ kind: 'group_archived', person: null, actor: person(group.archivedByUserId), at: group.archivedAt }] : []),
      ]
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, 50);
    }
    if (ctx.canManage && !group.archivedAt) {
      candidates = await reader
        .select({ id: users.id, name: fullName })
        .from(enrollments)
        .innerJoin(users, eq(users.id, enrollments.userId))
        .where(
          and(
            eq(enrollments.courseId, group.courseId),
            eq(enrollments.status, 'active'),
            eq(enrollments.role, 'student'),
            eq(users.isActive, true),
            sql`NOT EXISTS (SELECT 1 FROM ${studentGroupMembers} cm WHERE cm.group_id = ${group.id} AND cm.user_id = ${users.id} AND cm.removed_at IS NULL)`,
          ),
        )
        .orderBy(asc(users.familyName), asc(users.givenName));
    }
    return {
      group: summary!,
      viewer: { role: viewer.role, isMember: ctx.isMember, canManage: ctx.canManage, canRead: ctx.canRead, canPost: ctx.canPost, canModerate: ctx.canModerate },
      members,
      recentTopics,
      membershipChanges,
      candidates,
    };
  }

  // ---- Reading ----

  app.get<{ Params: { id: string } }>(
    '/courses/:id/groups',
    { ...authenticated, schema: { params: courseParamsSchema, response: { 200: courseGroupListSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      const viewer = await courseViewer(db, user, request.params.id);
      const memberOf = viewer.role === 'student' ? await memberGroupIds(db, user.id, viewer.course.id) : new Set<string>();
      const groups = viewer.canViewAll
        ? await db.select().from(studentGroups).where(eq(studentGroups.courseId, viewer.course.id)).orderBy(sql`${studentGroups.archivedAt} IS NOT NULL`, asc(studentGroups.name))
        : memberOf.size
          ? await db.select().from(studentGroups).where(inArray(studentGroups.id, [...memberOf])).orderBy(sql`${studentGroups.archivedAt} IS NOT NULL`, asc(studentGroups.name))
          : [];
      return {
        course: { id: viewer.course.id, title: viewer.course.title, code: viewer.course.code },
        viewer: { role: viewer.role, canManage: viewer.canManage, canViewAll: viewer.canViewAll },
        items: await summaries(db, user.id, groups, { moderatorCourseIds: moderatorCourses(viewer), memberOf }),
      };
    },
  );

  /** The caller's current groups across their courses (students). */
  app.get('/me/groups', { ...authenticated, schema: { response: { 200: myGroupListSchema } } }, async (request) => {
    const { user } = getAuth(request);
    const memberOf = await memberGroupIds(db, user.id);
    const groups = memberOf.size ? await db.select().from(studentGroups).where(inArray(studentGroups.id, [...memberOf])).orderBy(sql`${studentGroups.archivedAt} IS NOT NULL`, asc(studentGroups.name)) : [];
    return { items: await summaries(db, user.id, groups, { moderatorCourseIds: new Set(), memberOf }) };
  });

  app.get<{ Params: { groupId: string } }>(
    '/groups/:groupId',
    { ...authenticated, schema: { params: groupParamsSchema, response: { 200: groupDetailSchema } } },
    async (request) => detail(db, await loadGroup(db, getAuth(request).user, request.params.groupId)),
  );

  // ---- Management (instructors of the course; administrators) ----

  app.post<{ Params: { id: string }; Body: { name: string; description?: string | null } }>(
    '/courses/:id/groups',
    { ...authenticatedWrite, schema: { params: courseParamsSchema, body: groupInputSchema, response: { 201: groupDetailSchema } } },
    async (request, reply) => {
      const { user } = getAuth(request);
      const result = await db.transaction(async (tx) => {
        const viewer = await courseViewer(tx, user, request.params.id);
        if (!viewer.canManage) throw notManager();
        const name = request.body.name.trim();
        const description = request.body.description?.trim() || null;
        const [group] = await withUniqueConflict(
          () => tx.insert(studentGroups).values({ courseId: viewer.course.id, name, description, createdByUserId: user.id }).returning(),
          NAME_CONSTRAINT,
          'GROUP_NAME_TAKEN',
          'Another active group of this course already has this name.',
        );
        await recordAudit(tx, request, {
          action: 'group.created',
          entityType: 'student_group',
          entityId: group!.id,
          before: null,
          after: { courseId: group!.courseId, name: group!.name, descriptionLength: group!.description?.length ?? 0 },
        });
        return detail(tx, (await groupContext(tx, user, group!))!);
      });
      return reply.code(201).send(result);
    },
  );

  app.patch<{ Params: { groupId: string }; Body: { name?: string; description?: string | null } }>(
    '/groups/:groupId',
    { ...authenticatedWrite, schema: { params: groupParamsSchema, body: groupUpdateSchema, response: { 200: groupDetailSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      return db.transaction(async (tx) => {
        const ctx = await loadGroup(tx, user, request.params.groupId, true);
        if (!ctx.canManage) throw notManager();
        if (ctx.group.archivedAt) throw archived();
        const name = request.body.name?.trim() ?? ctx.group.name;
        const description = request.body.description === undefined ? ctx.group.description : request.body.description?.trim() || null;
        if (name === ctx.group.name && description === ctx.group.description) return detail(tx, ctx);
        const [updated] = await withUniqueConflict(
          () => tx.update(studentGroups).set({ name, description, updatedAt: sql`now()` }).where(eq(studentGroups.id, ctx.group.id)).returning(),
          NAME_CONSTRAINT,
          'GROUP_NAME_TAKEN',
          'Another active group of this course already has this name.',
        );
        await recordAudit(tx, request, {
          action: 'group.updated',
          entityType: 'student_group',
          entityId: ctx.group.id,
          before: { name: ctx.group.name, descriptionLength: ctx.group.description?.length ?? 0 },
          after: { courseId: ctx.group.courseId, name: updated!.name, descriptionLength: updated!.description?.length ?? 0 },
        });
        return detail(tx, { ...ctx, group: updated! });
      });
    },
  );

  /** Adds active students of the group's course; members already in the group are left as they are. */
  app.post<{ Params: { groupId: string }; Body: { userIds: string[] } }>(
    '/groups/:groupId/members',
    { ...authenticatedWrite, schema: { params: groupParamsSchema, body: memberAddSchema, response: { 200: memberAddResultSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      return db.transaction(async (tx) => {
        // The group row stays locked until commit: membership changes of a group never interleave.
        const ctx = await loadGroup(tx, user, request.params.groupId, true);
        if (!ctx.canManage) throw notManager();
        if (ctx.group.archivedAt) throw archived();
        const { userIds } = request.body;
        const eligible = await tx
          .select({ id: users.id })
          .from(enrollments)
          .innerJoin(users, eq(users.id, enrollments.userId))
          .where(and(eq(enrollments.courseId, ctx.group.courseId), inArray(enrollments.userId, userIds), eq(enrollments.status, 'active'), eq(enrollments.role, 'student'), eq(users.isActive, true)));
        if (eligible.length !== userIds.length) {
          // Never says which ids failed: a person outside the course must not be confirmed to exist.
          throw new ApiProblem(422, 'MEMBER_NOT_ELIGIBLE', "Only active students of the group's course can be added.");
        }
        // Timestamped by the database clock after the group lock is held (not at transaction start, and the same
        // clock for every API instance), so a membership history never shows a re-add before the removal it
        // waited for.
        const addedAt = sql`clock_timestamp()`;
        const added = await tx
          .insert(studentGroupMembers)
          .values(userIds.map((userId) => ({ groupId: ctx.group.id, courseId: ctx.group.courseId, userId, addedByUserId: user.id, addedAt })))
          .onConflictDoNothing({ target: [studentGroupMembers.groupId, studentGroupMembers.userId], where: sql`removed_at IS NULL` })
          .returning({ id: studentGroupMembers.id, userId: studentGroupMembers.userId });
        for (const member of added) {
          await recordAudit(tx, request, {
            action: 'group.member_added',
            entityType: 'student_group',
            entityId: ctx.group.id,
            before: null,
            after: { courseId: ctx.group.courseId, userId: member.userId, membershipId: member.id },
          });
        }
        return { added: added.length, alreadyMembers: userIds.length - added.length };
      });
    },
  );

  /** Closes a student's membership: their access to the group ends with this request. */
  app.delete<{ Params: { groupId: string; userId: string } }>(
    '/groups/:groupId/members/:userId',
    { ...authenticatedWrite, schema: { params: groupMemberParamsSchema, response: { 200: memberRemoveResultSchema } } },
    async (request) => {
      const { user } = getAuth(request);
      return db.transaction(async (tx) => {
        const ctx = await loadGroup(tx, user, request.params.groupId, true);
        if (!ctx.canManage) throw notManager();
        if (ctx.group.archivedAt) throw archived();
        const closed = await tx
          .update(studentGroupMembers)
          // The same database clock as additions, never before the membership opened.
          .set({ removedAt: sql`greatest(clock_timestamp(), ${studentGroupMembers.addedAt})`, removedByUserId: user.id })
          .where(and(eq(studentGroupMembers.groupId, ctx.group.id), eq(studentGroupMembers.userId, request.params.userId), isNull(studentGroupMembers.removedAt)))
          .returning({ id: studentGroupMembers.id });
        for (const membership of closed) {
          await recordAudit(tx, request, {
            action: 'group.member_removed',
            entityType: 'student_group',
            entityId: ctx.group.id,
            before: { membershipId: membership.id },
            after: { courseId: ctx.group.courseId, userId: request.params.userId },
          });
        }
        return { removed: closed.length > 0 };
      });
    },
  );

  async function setArchived(request: FastifyRequest, groupId: string, archive: boolean) {
    const { user } = getAuth(request);
    return db.transaction(async (tx) => {
      const ctx = await loadGroup(tx, user, groupId, true);
      if (!ctx.canManage) throw notManager();
      if ((ctx.group.archivedAt !== null) === archive) return detail(tx, ctx);
      if (!archive) {
        // Restoring takes the name back among the course's active groups.
        const [clash] = await tx
          .select({ id: studentGroups.id })
          .from(studentGroups)
          .where(and(eq(studentGroups.courseId, ctx.group.courseId), isNull(studentGroups.archivedAt), sql`lower(${studentGroups.name}) = lower(${ctx.group.name})`));
        if (clash) throw nameTaken();
      }
      const [updated] = await tx
        .update(studentGroups)
        .set(archive ? { archivedAt: app.now(), archivedByUserId: user.id, updatedAt: sql`now()` } : { archivedAt: null, archivedByUserId: null, updatedAt: sql`now()` })
        .where(eq(studentGroups.id, ctx.group.id))
        .returning();
      await recordAudit(tx, request, {
        action: archive ? 'group.archived' : 'group.restored',
        entityType: 'student_group',
        entityId: ctx.group.id,
        before: { archived: !archive },
        after: { archived: archive, courseId: ctx.group.courseId },
      });
      return detail(tx, { ...ctx, group: updated!, canPost: ctx.canRead && archive === false });
    });
  }

  app.post<{ Params: { groupId: string } }>(
    '/groups/:groupId/archive',
    { ...authenticatedWrite, schema: { params: groupParamsSchema, response: { 200: groupDetailSchema } } },
    async (request) => setArchived(request, request.params.groupId, true),
  );

  app.post<{ Params: { groupId: string } }>(
    '/groups/:groupId/restore',
    { ...authenticatedWrite, schema: { params: groupParamsSchema, response: { 200: groupDetailSchema } } },
    async (request) => setArchived(request, request.params.groupId, false),
  );

  /** Administrators: group organization per published course, as counts only (never discussions). */
  app.get(
    '/admin/groups',
    { preValidation: [app.requireAuth, app.requireAdministrator], schema: { response: { 200: adminGroupOverviewSchema } } },
    async () => {
      const course = sql.raw('"courses"."id"');
      const rows = await db
        .select({
          course: { id: courses.id, title: courses.title, code: courses.code },
          activeGroups: sql<number>`(SELECT count(*) FROM ${studentGroups} g WHERE g.course_id = ${course} AND g.archived_at IS NULL)::int`,
          archivedGroups: sql<number>`(SELECT count(*) FROM ${studentGroups} g WHERE g.course_id = ${course} AND g.archived_at IS NOT NULL)::int`,
          memberships: sql<number>`(SELECT count(*) FROM ${studentGroupMembers} m JOIN ${studentGroups} g ON g.id = m.group_id
            WHERE m.course_id = ${course} AND m.removed_at IS NULL AND g.archived_at IS NULL)::int`,
          studentsWithoutGroup: sql<number>`(SELECT count(*) FROM ${enrollments} e WHERE e.course_id = ${course} AND e.role = 'student' AND e.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM ${studentGroupMembers} m JOIN ${studentGroups} g ON g.id = m.group_id
              WHERE m.course_id = e.course_id AND m.user_id = e.user_id AND m.removed_at IS NULL AND g.archived_at IS NULL))::int`,
        })
        .from(courses)
        .where(eq(courses.status, 'published'))
        .orderBy(asc(courses.code));
      return { items: rows };
    },
  );
};

