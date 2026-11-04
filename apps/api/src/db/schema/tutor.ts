import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { primaryId } from './columns.js';
import { courses, enrollments } from './courses.js';
import { localeEnum, tutorOutcomeEnum, tutorRequestKindEnum } from './enums.js';
import { users } from './users.js';

/**
 * Minimal per-user, per-course tutor usage records, used for accounting and rate limiting. The
 * question text, response text and any personal data are deliberately not stored.
 */
export const tutorUsage = pgTable(
  'tutor_usage',
  {
    id: primaryId(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    enrollmentId: uuid('enrollment_id').notNull(),
    kind: tutorRequestKindEnum('kind').notNull(),
    language: localeEnum('language').notNull(),
    providerMode: text('provider_mode').notNull(),
    outcome: tutorOutcomeEnum('outcome').notNull(),
    sourceActivityIds: uuid('source_activity_ids').array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tutor_usage_course_user_created_idx').on(t.courseId, t.userId, t.createdAt),
    // The usage belongs to the user's own enrollment in this course.
    foreignKey({
      name: 'tutor_usage_enrollment_fk',
      columns: [t.enrollmentId, t.courseId, t.userId],
      foreignColumns: [enrollments.id, enrollments.courseId, enrollments.userId],
    }).onDelete('restrict'),
    check('tutor_usage_provider_mode_check', sql`${t.providerMode} IN ('mock')`),
    check('tutor_usage_sources_check', sql`cardinality(${t.sourceActivityIds}) <= 3`),
  ],
);
