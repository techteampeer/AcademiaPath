import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './columns.js';
import { courses } from './courses.js';
import { activityReviewStatusEnum, activityTypeEnum } from './enums.js';
import { users } from './users.js';

/** Ordered, optionally hidden block of course content. */
export const sections = pgTable(
  'sections',
  {
    id: primaryId(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    summary: text('summary'),
    position: integer('position').notNull(),
    isVisible: boolean('is_visible').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    index('sections_course_id_position_idx').on(t.courseId, t.position),
    check('sections_position_check', sql`${t.position} >= 0`),
    // Target of composite foreign keys that keep section prerequisites inside one course.
    unique('sections_id_course_id_unique').on(t.id, t.courseId),
  ],
);

/**
 * A named group of reading resources (lessons, links, documents) inside one section, managed by course
 * editors. Folders only organize content: they have no visibility of their own, so a folder is shown to
 * students only when it holds an approved, visible activity in an open section.
 */
export const resourceFolders = pgTable(
  'resource_folders',
  {
    id: primaryId(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id').notNull(),
    title: text('title').notNull(),
    position: integer('position').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (t) => [
    index('resource_folders_section_id_position_idx').on(t.sectionId, t.position),
    check('resource_folders_position_check', sql`${t.position} >= 0`),
    check('resource_folders_title_check', sql`char_length(${t.title}) BETWEEN 1 AND 120`),
    // Target of the activities' composite key: an activity's folder is always in the activity's own section.
    unique('resource_folders_id_section_id_unique').on(t.id, t.sectionId),
    // The folder's section belongs to the folder's course.
    foreignKey({
      name: 'resource_folders_section_fk',
      columns: [t.sectionId, t.courseId],
      foreignColumns: [sections.id, sections.courseId],
    }).onDelete('cascade'),
  ],
);

/** Type-specific settings; validated by the API layer per activity type. */
export type ActivityConfig = Record<string, unknown>;

/**
 * A learning activity (page, quiz, assignment, SCORM package, LTI tool…) within a section.
 *
 * Review workflow: `title`/`config` hold the working copy edited by staff. Approval copies them
 * into `approved_title`/`approved_config`, the only version students can read, so editing approved
 * content never exposes unreviewed changes.
 */
export const activities = pgTable(
  'activities',
  {
    id: primaryId(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    type: activityTypeEnum('type').notNull(),
    title: text('title').notNull(),
    position: integer('position').notNull(),
    isVisible: boolean('is_visible').notNull().default(true),
    config: jsonb('config')
      .$type<ActivityConfig>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    reviewStatus: activityReviewStatusEnum('review_status').notNull().default('draft'),
    /** Latest reviewer comment; required when content is returned. */
    reviewComment: text('review_comment'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    submittedByUserId: uuid('submitted_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    approvedTitle: text('approved_title'),
    approvedConfig: jsonb('approved_config').$type<ActivityConfig>(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /** Optional resource folder (same section; reading activities only). Organization, not reviewed content. */
    folderId: uuid('folder_id'),
    ...timestamps(),
  },
  (t) => [
    index('activities_section_id_position_idx').on(t.sectionId, t.position),
    index('activities_folder_id_idx').on(t.folderId),
    foreignKey({
      name: 'activities_folder_fk',
      columns: [t.folderId, t.sectionId],
      foreignColumns: [resourceFolders.id, resourceFolders.sectionId],
    })
      // NO ACTION (checked at statement end): a folder with activities cannot be deleted on its own, while
      // a cascading section delete may remove the folder and its activities together.
      .onDelete('no action'),
    check('activities_folder_type_check', sql`${t.folderId} IS NULL OR ${t.type} IN ('page', 'link', 'file')`),
    check('activities_position_check', sql`${t.position} >= 0`),
    check('activities_config_object_check', sql`jsonb_typeof(${t.config}) = 'object'`),
    check(
      'activities_approved_version_check',
      sql`(${t.approvedTitle} IS NULL AND ${t.approvedConfig} IS NULL AND ${t.approvedAt} IS NULL) OR (${t.approvedTitle} IS NOT NULL AND jsonb_typeof(${t.approvedConfig}) = 'object' AND ${t.approvedAt} IS NOT NULL)`,
    ),
    check('activities_approved_status_check', sql`${t.reviewStatus} <> 'approved' OR ${t.approvedConfig} IS NOT NULL`),
    check('activities_returned_comment_check', sql`${t.reviewStatus} <> 'returned' OR ${t.reviewComment} IS NOT NULL`),
    check('activities_submitted_check', sql`${t.reviewStatus} <> 'submitted' OR ${t.submittedAt} IS NOT NULL`),
  ],
);
