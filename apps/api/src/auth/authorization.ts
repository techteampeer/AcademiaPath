import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { courseRoleEnum, courses, enrollments, type CourseRole } from '../db/schema/index.js';
import type { SafeUser } from './types.js';

/** System-level check. Administrator is never a course-level role. */
export function isAdministrator(user: Pick<SafeUser, 'systemRole'>): boolean {
  return user.systemRole === 'administrator';
}

export type CoursePermission =
  | 'course.view'
  | 'course.viewUnpublished'
  | 'sections.viewHidden'
  | 'enrollments.viewAll'
  | 'content.edit';

/**
 * Course-level permissions per role. Default deny: a permission not listed here is not granted.
 * Enrolling users and managing institutional structures are administrator-only (system level).
 */
export const COURSE_ROLE_PERMISSIONS: Record<CourseRole, ReadonlySet<CoursePermission>> = {
  design_team: new Set(['course.view', 'course.viewUnpublished', 'sections.viewHidden', 'enrollments.viewAll', 'content.edit']),
  instructor: new Set(['course.view', 'course.viewUnpublished', 'sections.viewHidden', 'enrollments.viewAll', 'content.edit']),
  non_editing_instructor: new Set(['course.view', 'course.viewUnpublished', 'sections.viewHidden', 'enrollments.viewAll']),
  student: new Set(['course.view']),
};

export function hasCoursePermission(role: CourseRole | null, permission: CoursePermission): boolean {
  return role !== null && COURSE_ROLE_PERMISSIONS[role].has(permission);
}

/** Roles that may see draft and archived courses they are assigned to. */
export const UNPUBLISHED_VIEWER_ROLES = courseRoleEnum.enumValues.filter((role) =>
  hasCoursePermission(role, 'course.viewUnpublished'),
);

export type CourseRecord = typeof courses.$inferSelect;

export type CourseAccess = {
  course: CourseRecord;
  /** The caller's active enrollment role in this course, if any. */
  viewerRole: CourseRole | null;
  isAdministrator: boolean;
};

export function canInCourse(access: CourseAccess, permission: CoursePermission): boolean {
  return access.isAdministrator || hasCoursePermission(access.viewerRole, permission);
}

/**
 * Resolves the caller's access to one course from their system role and active enrollment.
 * Returns null when the course does not exist or the caller may not see it (default deny),
 * so callers respond 404 without revealing whether the course exists.
 */
export async function getCourseAccess(db: Database, user: SafeUser, courseId: string): Promise<CourseAccess | null> {
  const rows = await db
    .select({ course: courses, role: enrollments.role })
    .from(courses)
    .leftJoin(
      enrollments,
      and(eq(enrollments.courseId, courses.id), eq(enrollments.userId, user.id), eq(enrollments.status, 'active')),
    )
    .where(eq(courses.id, courseId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const access: CourseAccess = { course: row.course, viewerRole: row.role, isAdministrator: isAdministrator(user) };
  if (access.isAdministrator) return access;
  if (!hasCoursePermission(access.viewerRole, 'course.view')) return null;
  if (row.course.status !== 'published' && !hasCoursePermission(access.viewerRole, 'course.viewUnpublished')) {
    return null;
  }
  return access;
}

/**
 * Course-level role from the user's active enrollment, or null. Deliberately does not treat
 * administrators as enrolled.
 */
export async function getCourseRole(db: Database, userId: string, courseId: string): Promise<CourseRole | null> {
  const rows = await db
    .select({ role: enrollments.role })
    .from(enrollments)
    .where(and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId), eq(enrollments.status, 'active')))
    .limit(1);
  return rows[0]?.role ?? null;
}
