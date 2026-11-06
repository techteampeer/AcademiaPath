import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './columns.js';
import { activities, sections } from './content.js';
import { courses, enrollments } from './courses.js';
import { users } from './users.js';

/**
 * A student's own "I have completed this" mark on a reading activity (lesson, link or document).
 * Only reading activities can be marked: quiz and assignment completion is never stored here, it is
 * derived from submitted quiz attempts and assignment submissions, which only the server writes.
 * A trigger (migration 0017) checks that the activity is a reading activity of the same course and
 * that the enrollment is the student's own; the composite foreign key ties the row to that enrollment.
 */
export const activityCompletions = pgTable(
  'activity_completions',
  {
    id: primaryId(),
    activityId: uuid('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    enrollmentId: uuid('enrollment_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One completion per student and activity: repeated marks are no-ops.
    unique('activity_completions_activity_user_unique').on(t.activityId, t.userId),
    index('activity_completions_course_user_idx').on(t.courseId, t.userId),
    foreignKey({
      name: 'activity_completions_enrollment_fk',
      columns: [t.enrollmentId, t.courseId, t.userId],
      foreignColumns: [enrollments.id, enrollments.courseId, enrollments.userId],
    }).onDelete('cascade'),
  ],
);

/**
 * "Section X opens once section Y is complete" for one course. Both sections must belong to the
 * row's course (composite foreign keys); the API rejects cycles while holding the course row lock.
 */
export const sectionPrerequisites = pgTable(
  'section_prerequisites',
  {
    id: primaryId(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id').notNull(),
    requiredSectionId: uuid('required_section_id').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (t) => [
    unique('section_prerequisites_section_required_unique').on(t.sectionId, t.requiredSectionId),
    index('section_prerequisites_course_id_idx').on(t.courseId),
    check('section_prerequisites_not_self_check', sql`${t.sectionId} <> ${t.requiredSectionId}`),
    foreignKey({
      name: 'section_prerequisites_section_fk',
      columns: [t.sectionId, t.courseId],
      foreignColumns: [sections.id, sections.courseId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'section_prerequisites_required_section_fk',
      columns: [t.requiredSectionId, t.courseId],
      foreignColumns: [sections.id, sections.courseId],
    }).onDelete('cascade'),
  ],
);
