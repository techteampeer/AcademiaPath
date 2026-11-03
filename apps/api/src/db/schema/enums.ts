import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * System-level role stored on the user. Only `administrator` grants
 * platform-wide permissions; every other permission is course-specific.
 */
export const systemRoleEnum = pgEnum('system_role', ['administrator', 'user']);

/**
 * Course-level role, held per course through an enrollment.
 * `administrator` is intentionally absent: it can never be granted per course.
 */
export const courseRoleEnum = pgEnum('course_role', [
  'design_team',
  'instructor',
  'non_editing_instructor',
  'student',
]);

export const courseStatusEnum = pgEnum('course_status', ['draft', 'published', 'archived']);

export const enrollmentStatusEnum = pgEnum('enrollment_status', ['active', 'inactive']);

export const activityTypeEnum = pgEnum('activity_type', [
  'page',
  'file',
  'link',
  'quiz',
  'assignment',
  'scorm',
  'lti',
]);

/** Review workflow for course content. New content always starts as `draft`. */
export const activityReviewStatusEnum = pgEnum('activity_review_status', ['draft', 'submitted', 'approved', 'returned']);

export const localeEnum = pgEnum('locale', ['es', 'en']);

export type SystemRole = (typeof systemRoleEnum.enumValues)[number];
export type CourseRole = (typeof courseRoleEnum.enumValues)[number];
export type CourseStatus = (typeof courseStatusEnum.enumValues)[number];
export type EnrollmentStatus = (typeof enrollmentStatusEnum.enumValues)[number];
export type ActivityType = (typeof activityTypeEnum.enumValues)[number];
export type Locale = (typeof localeEnum.enumValues)[number];
export type ActivityReviewStatus = (typeof activityReviewStatusEnum.enumValues)[number];

/** The five AcademiaPath role categories: one system-level, four course-level. */
export type RoleCategory = Extract<SystemRole, 'administrator'> | CourseRole;
