import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId } from './columns.js';
import { courses, enrollments } from './courses.js';
import { users } from './users.js';

/**
 * Student groups (AP-028): instructor-managed collections of a course's students, each with a private
 * workspace whose discussions are course-forum topics scoped to the group (`forum_topics.group_id`).
 * Groups and memberships are never deleted: a group is archived (read-only history) and a removed member's
 * row is closed (`removed_at`), so membership changes stay on record. Who may see a group's discussions is
 * derived from current data on every request (an active membership, an active student enrollment and an
 * active account, or the course's teaching staff).
 */
export const studentGroups = pgTable(
  'student_groups',
  {
    id: primaryId(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Archived: kept as read-only history (no new posts, edits or membership changes). */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedByUserId: uuid('archived_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Lets memberships and group topics reference a group together with its course (both must match).
    unique('student_groups_id_course_unique').on(t.id, t.courseId),
    // Names are unique among a course's active groups (case-insensitive).
    uniqueIndex('student_groups_course_name_unique').on(t.courseId, sql`lower(${t.name})`).where(sql`${t.archivedAt} IS NULL`),
    index('student_groups_course_idx').on(t.courseId),
    check('student_groups_name_check', sql`char_length(${t.name}) BETWEEN 1 AND 100 AND ${t.name} ~ '\\S'`),
    check('student_groups_description_check', sql`${t.description} IS NULL OR char_length(${t.description}) <= 1000`),
    check('student_groups_archived_check', sql`(${t.archivedAt} IS NULL) = (${t.archivedByUserId} IS NULL)`),
  ],
);

/**
 * Group memberships, current and past. A student has at most one open membership per group
 * (`removed_at IS NULL`); removing them closes it, and adding them again opens a new one. The membership's
 * course is the group's course, and the student is enrolled in it (composite foreign keys).
 */
export const studentGroupMembers = pgTable(
  'student_group_members',
  {
    id: primaryId(),
    groupId: uuid('group_id').notNull(),
    courseId: uuid('course_id').notNull(),
    userId: uuid('user_id').notNull(),
    addedByUserId: uuid('added_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedByUserId: uuid('removed_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    foreignKey({ name: 'student_group_members_group_fk', columns: [t.groupId, t.courseId], foreignColumns: [studentGroups.id, studentGroups.courseId] }).onDelete('restrict'),
    foreignKey({ name: 'student_group_members_enrollment_fk', columns: [t.courseId, t.userId], foreignColumns: [enrollments.courseId, enrollments.userId] }).onDelete('restrict'),
    uniqueIndex('student_group_members_open_unique').on(t.groupId, t.userId).where(sql`${t.removedAt} IS NULL`),
    index('student_group_members_user_idx').on(t.userId, t.courseId),
    index('student_group_members_group_idx').on(t.groupId, t.addedAt),
    check('student_group_members_removed_check', sql`(${t.removedAt} IS NULL) = (${t.removedByUserId} IS NULL) AND (${t.removedAt} IS NULL OR ${t.removedAt} >= ${t.addedAt})`),
  ],
);
