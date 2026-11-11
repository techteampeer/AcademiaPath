/**
 * Who may read, post in and moderate a course forum (AP-027). Derived from current data on every request:
 * - participants: an active account with an active enrollment whose course role grants `forum.participate`
 *   (students, instructors, non-editing instructors) in a published course; instructors also moderate;
 * - administrators: read and moderate the forum of any published course (institutional control), never post;
 * - everyone else, including the design team and program managers, has no forum access.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { getCourseAccess, hasCoursePermission, isAdministrator, type CourseRecord } from '../auth/authorization.js';
import type { SafeUser } from '../auth/types.js';
import type { Database } from '../db/client.js';
import { courses, enrollments, forumPosts, users, type CourseRole } from '../db/schema/index.js';

export const FORUM_ROLES = ['student', 'instructor', 'non_editing_instructor'] as const;
export type ForumRole = (typeof FORUM_ROLES)[number];

export type ForumViewer = {
  userId: string;
  course: CourseRecord;
  /** The caller's forum role in the course; null for an administrator without one. */
  role: ForumRole | null;
  canPost: boolean;
  canModerate: boolean;
};

/** `not_available`: the caller can see the course but has no forum access (or the course is not published). */
export async function forumViewer(db: Database | Pick<Database, 'select'>, user: SafeUser, courseId: string): Promise<ForumViewer | 'not_found' | 'not_available'> {
  const [row] = await db
    .select({ course: courses, role: enrollments.role, isActive: users.isActive })
    .from(courses)
    .leftJoin(enrollments, and(eq(enrollments.courseId, courses.id), eq(enrollments.userId, user.id), eq(enrollments.status, 'active')))
    .leftJoin(users, eq(users.id, user.id))
    .where(eq(courses.id, courseId))
    .limit(1);
  if (!row) return 'not_found';
  const admin = isAdministrator(user);
  const published = row.course.status === 'published';
  if (published && row.isActive && hasCoursePermission(row.role, 'forum.participate')) {
    return { userId: user.id, course: row.course, role: row.role as ForumRole, canPost: true, canModerate: admin || hasCoursePermission(row.role, 'forum.moderate') };
  }
  if (published && admin) return { userId: user.id, course: row.course, role: null, canPost: false, canModerate: true };
  return (await getCourseAccess(db as Database, user, courseId)) ? 'not_available' : 'not_found';
}

export const forumRole = (role: CourseRole | string | null | undefined): ForumRole | null =>
  role && (FORUM_ROLES as readonly string[]).includes(role) ? (role as ForumRole) : null;

/**
 * Replies only moderators see: hidden ones, and replies to a hidden reply (`post` is the forum_posts row).
 */
export function visiblePost(post: typeof forumPosts = forumPosts): SQL {
  return sql`(${post.hiddenAt} IS NULL AND (${post.parentPostId} IS NULL OR NOT EXISTS (
    SELECT 1 FROM ${forumPosts} hp WHERE hp.id = ${post.parentPostId} AND hp.hidden_at IS NOT NULL)))`;
}
