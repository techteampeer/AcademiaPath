import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { programs, terms } from './academic.js';
import { primaryId, timestamps } from './columns.js';
import { courseRoleEnum, courseStatusEnum, enrollmentStatusEnum } from './enums.js';
import { users } from './users.js';

/** Reusable master course from which term-specific courses are created. Content lives in versions. */
export const courseTemplates = pgTable(
  'course_templates',
  {
    id: primaryId(),
    /** Optional: general-education templates may not belong to a single program. */
    programId: uuid('program_id').references(() => programs.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    /** Title and description of the latest version. */
    title: text('title').notNull(),
    description: text('description'),
    ...timestamps(),
  },
  (t) => [
    unique('course_templates_code_unique').on(t.code),
    index('course_templates_program_id_idx').on(t.programId),
  ],
);

/**
 * Immutable snapshot of a template. New content creates a new version; earlier versions are kept
 * so courses created from them remain traceable.
 */
export const courseTemplateVersions = pgTable(
  'course_template_versions',
  {
    id: primaryId(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => courseTemplates.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    ...timestamps(),
  },
  (t) => [
    unique('course_template_versions_template_id_version_unique').on(t.templateId, t.version),
    // Target of the composite foreign key that ties a course's version to its template.
    unique('course_template_versions_id_template_id_unique').on(t.id, t.templateId),
    check('course_template_versions_version_check', sql`${t.version} >= 1`),
  ],
);

/** Ordered sections of a template version, copied into each course created from it. */
export const courseTemplateSections = pgTable(
  'course_template_sections',
  {
    id: primaryId(),
    templateVersionId: uuid('template_version_id')
      .notNull()
      .references(() => courseTemplateVersions.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    summary: text('summary'),
    position: integer('position').notNull(),
    isVisible: boolean('is_visible').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('course_template_sections_version_position_unique').on(t.templateVersionId, t.position),
    check('course_template_sections_position_check', sql`${t.position} >= 0`),
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
    /** Nullable only for rows created before programs were linked; the API always sets it. */
    programId: uuid('program_id').references(() => programs.id, { onDelete: 'restrict' }),
    templateId: uuid('template_id').references(() => courseTemplates.id, {
      onDelete: 'set null',
    }),
    /** The exact template version the course was created from. */
    templateVersionId: uuid('template_version_id'),
    code: text('code').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: courseStatusEnum('status').notNull().default('draft'),
    /**
     * Optimistic concurrency token for course administration: every lifecycle change (details,
     * publish, unpublish) must name the version it saw and increments it, so a stale edit fails.
     */
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    check('courses_version_check', sql`${t.version} >= 1`),
    unique('courses_term_id_code_unique').on(t.termId, t.code),
    index('courses_template_id_idx').on(t.templateId),
    index('courses_status_idx').on(t.status),
    index('courses_program_id_idx').on(t.programId),
    index('courses_template_version_id_idx').on(t.templateVersionId),
    // The version must belong to the course's template.
    foreignKey({
      name: 'courses_template_version_fk',
      columns: [t.templateVersionId, t.templateId],
      foreignColumns: [courseTemplateVersions.id, courseTemplateVersions.templateId],
    }).onDelete('restrict'),
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
    // Target of the composite foreign key that ties quiz attempts to the student's enrollment.
    unique('enrollments_id_course_id_user_id_unique').on(t.id, t.courseId, t.userId),
    index('enrollments_user_id_idx').on(t.userId),
    index('enrollments_course_id_role_idx').on(t.courseId, t.role),
  ],
);
