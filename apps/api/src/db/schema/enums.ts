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

/** Supported question types. Future types (matching, short answer, essay) can be added as new values. */
export const quizQuestionTypeEnum = pgEnum('quiz_question_type', ['single_choice', 'multiple_choice', 'true_false']);

export const quizAttemptStatusEnum = pgEnum('quiz_attempt_status', ['in_progress', 'submitted']);

/** Where a gradebook entry comes from: the best quiz attempt or a graded assignment submission. */
export const gradeSourceEnum = pgEnum('grade_source', ['quiz', 'assignment']);

/** Tutor usage accounting: request kind and grounding outcome (never the question text). */
export const tutorRequestKindEnum = pgEnum('tutor_request_kind', ['message', 'practice']);
export const tutorOutcomeEnum = pgEnum('tutor_outcome', ['grounded', 'insufficient_material']);

export const localeEnum = pgEnum('locale', ['es', 'en']);

/** Accepted upload formats (verified from the file's signature and container structure). */
export const documentFormatEnum = pgEnum('document_format', ['pdf', 'docx', 'pptx']);
/** `no_text`: the file is valid but has no selectable text (for example scanned or image-only pages). */
export const documentExtractionStatusEnum = pgEnum('document_extraction_status', ['extracted', 'no_text']);
/** Malware scanning hook result. No scanning service is connected yet, so uploads are `not_scanned`. */
export const malwareScanStatusEnum = pgEnum('malware_scan_status', ['not_scanned', 'clean']);
export const documentSummaryStatusEnum = pgEnum('document_summary_status', ['ready', 'insufficient_text']);

export type SystemRole = (typeof systemRoleEnum.enumValues)[number];
export type CourseRole = (typeof courseRoleEnum.enumValues)[number];
export type CourseStatus = (typeof courseStatusEnum.enumValues)[number];
export type EnrollmentStatus = (typeof enrollmentStatusEnum.enumValues)[number];
export type ActivityType = (typeof activityTypeEnum.enumValues)[number];
export type Locale = (typeof localeEnum.enumValues)[number];
export type ActivityReviewStatus = (typeof activityReviewStatusEnum.enumValues)[number];
export type QuizQuestionType = (typeof quizQuestionTypeEnum.enumValues)[number];
export type QuizAttemptStatus = (typeof quizAttemptStatusEnum.enumValues)[number];
export type GradeSource = (typeof gradeSourceEnum.enumValues)[number];
export type DocumentFormat = (typeof documentFormatEnum.enumValues)[number];
export type DocumentExtractionStatus = (typeof documentExtractionStatusEnum.enumValues)[number];
export type DocumentSummaryStatus = (typeof documentSummaryStatusEnum.enumValues)[number];

/** The five AcademiaPath role categories: one system-level, four course-level. */
export type RoleCategory = Extract<SystemRole, 'administrator'> | CourseRole;
