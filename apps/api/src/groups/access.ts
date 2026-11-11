/**
 * Who may see and manage student groups (AP-028), derived from current data on every request:
 * - instructors of the course (active enrollment, active account) manage its groups and, while the course is
 *   published, read, post in and moderate every group's discussions;
 * - non-editing instructors see every group and its members and take part in the discussions, but never
 *   change groups or members;
 * - administrators manage the groups of any course (institutional control) but never read group discussions;
 * - students see only the groups they currently belong to (open membership, active student enrollment, active
 *   account, published course), and read and post in those groups' discussions;
 * - everyone else, including the design team and program managers, has no access to groups.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getCourseAccess, hasCoursePermission, isAdministrator, type CourseRecord } from '../auth/authorization.js';
import type { SafeUser } from '../auth/types.js';
import type { Database } from '../db/client.js';
import { courses, enrollments, studentGroupMembers, studentGroups, users, type CourseRole } from '../db/schema/index.js';

export type GroupRecord = typeof studentGroups.$inferSelect;
type Reader = Pick<Database, 'select'>;

export type CourseGroupsViewer = {
  userId: string;
  course: CourseRecord;
  role: CourseRole | null;
  isAdministrator: boolean;
  /** Create, edit, archive, restore and change members. */
  canManage: boolean;
  /** See every group of the course and its members. */
  canViewAll: boolean;
  /** Read and post in group discussions as teaching staff (published course, active account). */
  staffReader: boolean;
};

/** `not_available`: the caller can see the course but has no access to its groups. */
export async function courseGroupsViewer(db: Reader, user: SafeUser, courseId: string): Promise<CourseGroupsViewer | 'not_found' | 'not_available'> {
  const [row] = await db
    .select({ course: courses, role: enrollments.role, isActive: users.isActive })
    .from(courses)
    .leftJoin(enrollments, and(eq(enrollments.courseId, courses.id), eq(enrollments.userId, user.id), eq(enrollments.status, 'active')))
    .leftJoin(users, eq(users.id, user.id))
    .where(eq(courses.id, courseId))
    .limit(1);
  if (!row) return 'not_found';
  const admin = isAdministrator(user);
  const active = row.isActive === true;
  const role = active ? row.role : null;
  const published = row.course.status === 'published';
  const canManage = admin || hasCoursePermission(role, 'groups.manage');
  const canViewAll = canManage || hasCoursePermission(role, 'groups.view');
  const staffReader = published && hasCoursePermission(role, 'groups.view') && hasCoursePermission(role, 'forum.participate');
  const student = published && role === 'student';
  if (canViewAll || student) return { userId: user.id, course: row.course, role, isAdministrator: admin, canManage, canViewAll, staffReader };
  return (await getCourseAccess(db as Database, user, courseId)) ? 'not_available' : 'not_found';
}

/**
 * Whether the person currently belongs to the group: open membership, active student enrollment, active account.
 * With `lock`, the membership row stays share-locked until commit, so a concurrent removal waits for the write.
 */
export async function isCurrentMember(db: Reader, groupId: string, userId: string, lock = false): Promise<boolean> {
  const query = db
    .select({ one: sql<number>`1` })
    .from(studentGroupMembers)
    .innerJoin(enrollments, and(eq(enrollments.courseId, studentGroupMembers.courseId), eq(enrollments.userId, studentGroupMembers.userId)))
    .innerJoin(users, eq(users.id, studentGroupMembers.userId))
    .where(
      and(
        eq(studentGroupMembers.groupId, groupId),
        eq(studentGroupMembers.userId, userId),
        isNull(studentGroupMembers.removedAt),
        eq(enrollments.status, 'active'),
        eq(enrollments.role, 'student'),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for('share', { of: studentGroupMembers }) : await query;
  return Boolean(row);
}

export type GroupContext = {
  group: GroupRecord;
  viewer: CourseGroupsViewer;
  isMember: boolean;
  canManage: boolean;
  /** Read the group's discussions. */
  canRead: boolean;
  /** Start topics and reply (not in an archived group). */
  canPost: boolean;
  canModerate: boolean;
};

/** The caller's standing in a group, or null when they may not see it at all (callers answer "not found"). */
export async function groupContext(db: Reader, user: SafeUser, group: GroupRecord, lock = false): Promise<GroupContext | null> {
  const viewer = await courseGroupsViewer(db, user, group.courseId);
  if (typeof viewer === 'string') return null;
  const isMember = viewer.role === 'student' && viewer.course.status === 'published' ? await isCurrentMember(db, group.id, user.id, lock) : false;
  if (!viewer.canViewAll && !isMember) return null;
  const canRead = viewer.staffReader || isMember;
  return {
    group,
    viewer,
    isMember,
    canManage: viewer.canManage,
    canRead,
    canPost: canRead && group.archivedAt === null,
    canModerate: canRead && hasCoursePermission(viewer.role, 'forum.moderate'),
  };
}

/**
 * For the forum: whether a forum participant may read a group's discussions. Teaching staff of the course
 * (instructors, non-editing instructors) may; students only while they currently belong to the group;
 * administrators without a course role never do.
 */
export async function forumGroupAccess(db: Reader, viewer: { userId: string; role: CourseRole | null }, groupId: string, lock = false): Promise<boolean> {
  if (viewer.role === 'instructor' || viewer.role === 'non_editing_instructor') return true;
  if (viewer.role === 'student') return isCurrentMember(db, groupId, viewer.userId, lock);
  return false;
}
