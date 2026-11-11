/**
 * Who may message whom (AP-026). Derived from current data on every request: an active account with an
 * active enrollment whose course role grants messaging, in a published course. Administrators and the design
 * team get no access to private conversations through their roles.
 */
import { and, eq } from 'drizzle-orm';
import { hasCoursePermission, type CourseRecord } from '../auth/authorization.js';
import type { Database } from '../db/client.js';
import { courses, enrollments, users, type CourseRole } from '../db/schema/index.js';

export type MessagingMember = { userId: string; role: CourseRole; course: CourseRecord };

/** The person's messaging membership in the course, or null (no access: callers answer "not found"). */
export async function messagingMember(db: Pick<Database, 'select'>, userId: string, courseId: string): Promise<MessagingMember | null> {
  const [row] = await db
    .select({ course: courses, role: enrollments.role, isActive: users.isActive })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(and(eq(enrollments.courseId, courseId), eq(enrollments.userId, userId), eq(enrollments.status, 'active')))
    .limit(1);
  if (!row || !row.isActive || row.course.status !== 'published') return null;
  if (!hasCoursePermission(row.role, 'messages.course') && !hasCoursePermission(row.role, 'messages.direct')) return null;
  return { userId, role: row.role, course: row.course };
}

/** Direct conversations always join a student and a member of the course's teaching staff. */
export function mayConverse(a: CourseRole, b: CourseRole): boolean {
  if (!hasCoursePermission(a, 'messages.direct') || !hasCoursePermission(b, 'messages.direct')) return false;
  return (a === 'student') !== (b === 'student');
}

/** The two participants of a direct conversation, ordered as stored. */
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
