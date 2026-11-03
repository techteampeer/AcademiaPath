import { index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { programs, terms } from './academic.js';
import { primaryId, timestamps } from './columns.js';
import { courseRoleEnum, courseStatusEnum, enrollmentStatusEnum } from './enums.js';
import { users } from './users.js';

/** Reusable master course from which term-specific courses are created. */
export const courseTemplates = pgTable(
  'course_templates',
  {
    id: primaryId(),
    /** Optional: general-education templates may not belong to a single program. */
    programId: uuid('program_id').references(() => programs.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    ...timestamps(),
  },
  (t) => [
    unique('course_templates_code_unique').on(t.code),
    index('course_templates_program_id_idx').on(t.programId),
  ],
);

/** A course offering in a specific term. */
export const courses = pgTable(
  'courses',
  {
    id: primaryId(),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'restrict' }),
    templateId: uuid('template_id').references(() => courseTemplates.id, {
      onDelete: 'set null',
    }),
    code: text('code').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: courseStatusEnum('status').notNull().default('draft'),
    ...timestamps(),
  },
  (t) => [
    unique('courses_term_id_code_unique').on(t.termId, t.code),
    index('courses_template_id_idx').on(t.templateId),
    index('courses_status_idx').on(t.status),
  ],
);

/** A user's course-specific role. One enrollment (and therefore one role) per user per course. */
export const enrollments = pgTable(
  'enrollments',
  {
    id: primaryId(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: courseRoleEnum('role').notNull(),
    status: enrollmentStatusEnum('status').notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    unique('enrollments_course_id_user_id_unique').on(t.courseId, t.userId),
    index('enrollments_user_id_idx').on(t.userId),
    index('enrollments_course_id_role_idx').on(t.courseId, t.role),
  ],
);
