import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { enrollments, type CourseRole } from '../db/schema/index.js';
import type { SafeUser } from './types.js';

/** System-level check. Administrator is never a course-level role. */
export function isAdministrator(user: Pick<SafeUser, 'systemRole'>): boolean {
  return user.systemRole === 'administrator';
}

/**
 * Course-level role from the user's active enrollment, or null. Foundation for later
 * course policies; it deliberately does not treat administrators as enrolled.
 */
export async function getCourseRole(db: Database, userId: string, courseId: string): Promise<CourseRole | null> {
  const rows = await db
    .select({ role: enrollments.role })
    .from(enrollments)
    .where(and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId), eq(enrollments.status, 'active')))
    .limit(1);
  return rows[0]?.role ?? null;
}
