/**
 * In-app notifications (AP-026). Events record notifications inside the same database transaction that
 * changes the data (a message, a published announcement, a released grade, an issued certificate), so a
 * notification exists exactly when its event committed; no scheduler or broker is involved.
 *
 * One row per recipient and event key: a repeated event refreshes the recipient's notification (unread again,
 * new time) instead of adding a duplicate. Whether a notification is shown is decided when it is read
 * (`visibleTo`): withdrawn and not-yet-available ones are hidden, and course notifications only appear while
 * the recipient still has access to the course.
 */
import { and, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { courses, enrollments, forumPosts, forumTopics, notifications, notificationTypeEnum, studentGroupMembers, users } from '../db/schema/index.js';

export type NotificationType = (typeof notificationTypeEnum.enumValues)[number];
type Executor = Pick<Database, 'insert' | 'update' | 'select'>;

export type NotificationEvent = {
  type: NotificationType;
  courseId: string | null;
  entityId: string;
  dedupeKey: string;
  /** Only what every recipient may see: titles, a course code, a sender's name. Never a body or a grade. */
  data: Record<string, string>;
  at: Date;
  /** Hidden until then (scheduled announcements); defaults to `at`. */
  availableAt?: Date;
};

const BATCH = 500;

/** Records (or refreshes) the notification of one event for each recipient. */
export async function notifyUsers(tx: Executor, userIds: Iterable<string>, event: NotificationEvent): Promise<number> {
  const recipients = [...new Set(userIds)];
  for (let i = 0; i < recipients.length; i += BATCH) {
    await tx
      .insert(notifications)
      .values(
        recipients.slice(i, i + BATCH).map((userId) => ({
          userId,
          type: event.type,
          courseId: event.courseId,
          entityId: event.entityId,
          dedupeKey: event.dedupeKey,
          data: event.data,
          eventAt: event.at,
          availableAt: event.availableAt ?? event.at,
        })),
      )
      .onConflictDoUpdate({
        target: [notifications.userId, notifications.dedupeKey],
        set: {
          type: sql`excluded.type`,
          courseId: sql`excluded.course_id`,
          entityId: sql`excluded.entity_id`,
          data: sql`excluded.data`,
          eventAt: sql`excluded.event_at`,
          availableAt: sql`excluded.available_at`,
          readAt: null,
          withdrawnAt: null,
        },
      });
  }
  return recipients.length;
}

/** The event no longer applies (e.g. an announcement was archived): its notifications are hidden, not deleted. */
export async function withdrawNotifications(tx: Executor, dedupeKey: string, at: Date): Promise<void> {
  await tx
    .update(notifications)
    .set({ withdrawnAt: at })
    .where(and(eq(notifications.dedupeKey, dedupeKey), isNull(notifications.withdrawnAt)));
}

/** Active accounts with an active enrollment in the course (optionally only some roles), except one person. */
export async function courseMemberIds(tx: Executor, courseId: string, options: { roles?: string[]; except?: string } = {}): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(enrollments)
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(
      and(
        eq(enrollments.courseId, courseId),
        eq(enrollments.status, 'active'),
        eq(users.isActive, true),
        options.roles ? inArray(enrollments.role, options.roles as never[]) : undefined,
        options.except ? ne(users.id, options.except) : undefined,
      ),
    );
  return rows.map((row) => row.id);
}

/** Every active account except one person (institution-wide announcements). */
export async function activeUserIds(tx: Executor, except?: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isActive, true), except ? ne(users.id, except) : undefined));
  return rows.map((row) => row.id);
}

/**
 * Which of a person's notifications they may see now: their own, not withdrawn, already available, and, for
 * course notifications, only while they still hold an active enrollment that gives access to the course
 * (students: published courses only). Messaging notifications also need a messaging role in that course.
 * Forum notifications (AP-027) also need a forum role in a published course, and disappear while their topic,
 * the reply they announce or that reply's parent is hidden by moderation. A group topic's notifications (AP-028)
 * show only while the reader is the course's teaching staff or a current member of the group.
 */
export function visibleTo(userId: string, at: Date): SQL {
  return and(
    eq(notifications.userId, userId),
    isNull(notifications.withdrawnAt),
    sql`${notifications.availableAt} <= ${at.toISOString()}::timestamptz`,
    sql`(${notifications.courseId} IS NULL OR EXISTS (
      SELECT 1 FROM ${enrollments} e JOIN ${courses} c ON c.id = e.course_id
      WHERE e.course_id = ${notifications.courseId} AND e.user_id = ${userId} AND e.status = 'active'
        AND (c.status = 'published' OR e.role <> 'student')
        AND (${notifications.type} NOT IN ('direct_message', 'course_message')
             OR (c.status = 'published' AND e.role IN ('student', 'instructor', 'non_editing_instructor')))
        AND (${notifications.type} NOT IN ('forum_reply', 'forum_topic')
             OR (c.status = 'published' AND e.role IN ('student', 'instructor', 'non_editing_instructor')
                 AND EXISTS (SELECT 1 FROM ${forumTopics} ft WHERE ft.id = ${notifications.entityId} AND ft.course_id = c.id AND ft.hidden_at IS NULL
                   AND (ft.group_id IS NULL OR e.role IN ('instructor', 'non_editing_instructor') OR EXISTS (
                     SELECT 1 FROM ${studentGroupMembers} gm WHERE gm.group_id = ft.group_id AND gm.user_id = ${userId} AND gm.removed_at IS NULL)))
                 AND (${notifications.data} ->> 'postId' IS NULL OR EXISTS (
                   SELECT 1 FROM ${forumPosts} fp
                   LEFT JOIN ${forumPosts} fpp ON fpp.id = fp.parent_post_id
                   WHERE fp.id::text = ${notifications.data} ->> 'postId' AND fp.topic_id = ${notifications.entityId}
                     AND fp.hidden_at IS NULL AND fpp.hidden_at IS NULL))))
    ))`,
  )!;
}

/** Where a notification leads; every destination re-checks access itself. */
export function notificationLink(row: { type: NotificationType; courseId: string | null; entityId: string }): string {
  switch (row.type) {
    case 'direct_message':
    case 'course_message':
      return `/messages/${row.entityId}`;
    case 'announcement':
      return `/announcements/${row.entityId}`;
    case 'grade_released':
      return row.courseId ? `/courses/${row.courseId}/grades` : '/dashboard';
    case 'certificate_issued':
      return `/certificates/${row.entityId}`;
    case 'forum_reply':
    case 'forum_topic':
      return row.courseId ? `/courses/${row.courseId}/forum/${row.entityId}` : '/dashboard';
  }
}
