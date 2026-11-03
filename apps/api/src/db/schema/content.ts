import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './columns.js';
import { courses } from './courses.js';
import { activityTypeEnum } from './enums.js';

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
  ],
);

/** Type-specific settings; validated by the API layer per activity type. */
export type ActivityConfig = Record<string, unknown>;

/** A learning activity (page, quiz, assignment, SCORM package, LTI tool…) within a section. */
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
    ...timestamps(),
  },
  (t) => [
    index('activities_section_id_position_idx').on(t.sectionId, t.position),
    check('activities_position_check', sql`${t.position} >= 0`),
    check('activities_config_object_check', sql`jsonb_typeof(${t.config}) = 'object'`),
  ],
);
