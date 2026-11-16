import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './columns.js';
import { courses } from './courses.js';
import { activities, sections } from './content.js';
import { announcementStatusEnum, calendarEventStatusEnum, communicationScopeEnum, teachingSessionModeEnum } from './enums.js';
import { users } from './users.js';

/**
 * Announcements (AP-025): plain text only (no HTML), for one course or the whole institution. Students see
 * an announcement only when it is `published` and its `publish_at` has been reached on the server clock
 * (scheduling needs no background job); drafts and archived announcements never reach them.
 */
export const announcements = pgTable(
  'announcements',
  {
    id: primaryId(),
    scope: communicationScopeEnum('scope').notNull(),
    courseId: uuid('course_id').references(() => courses.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    status: announcementStatusEnum('status').notNull().default('draft'),
    pinned: boolean('pinned').notNull().default(false),
    /** When it becomes (or became) visible; set by publishing (now or a future, scheduled instant). */
    publishAt: timestamp('publish_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedByUserId: uuid('updated_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (t) => [
    index('announcements_course_visible_idx').on(t.courseId, t.status, t.publishAt),
    index('announcements_scope_status_idx').on(t.scope, t.status, t.publishAt),
    check('announcements_scope_check', sql`(${t.scope} = 'course') = (${t.courseId} IS NOT NULL)`),
    check('announcements_title_check', sql`char_length(${t.title}) BETWEEN 1 AND 200`),
    check('announcements_body_check', sql`char_length(${t.body}) BETWEEN 1 AND 10000`),
    check('announcements_publish_check', sql`${t.status} = 'draft' OR ${t.publishAt} IS NOT NULL OR ${t.status} = 'archived'`),
    check('announcements_archived_check', sql`(${t.status} = 'archived') = (${t.archivedAt} IS NOT NULL)`),
  ],
);

/** Who has read which announcement. One row per user and announcement, so repeated reads are no-ops. */
export const announcementReads = pgTable(
  'announcement_reads',
  {
    announcementId: uuid('announcement_id')
      .notNull()
      .references(() => announcements.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'announcement_reads_pkey', columns: [t.announcementId, t.userId] }), index('announcement_reads_user_idx').on(t.userId)],
);

/**
 * Academic calendar events (AP-025), for one course or the institution. Times are stored as UTC instants
 * (`starts_at` inclusive, `ends_at` exclusive) together with the IANA time zone they are shown in. All-day
 * events also keep their calendar dates (`start_date`..`end_date`, inclusive); their instants are the
 * midnights of those dates in the event's time zone, so range queries treat both kinds alike.
 *
 * AP-045: a course event can also be a teaching session: a session number and a delivery mode (both or
 * neither), optionally an external HTTPS link to a virtual classroom (live or presentation sessions only; not
 * hosted by AcademiaPath), one course activity to open, and the course units (sections) it covers
 * (`calendar_event_units`). Units and sessions are independent: a unit can span several sessions and a session
 * several units, or none. Ordinary events have no session details.
 */
export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: primaryId(),
    scope: communicationScopeEnum('scope').notNull(),
    courseId: uuid('course_id').references(() => courses.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    description: text('description'),
    allDay: boolean('all_day').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    timeZone: text('time_zone').notNull(),
    status: calendarEventStatusEnum('status').notNull().default('hidden'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    sessionNumber: integer('session_number'),
    sessionMode: teachingSessionModeEnum('session_mode'),
    joinUrl: text('join_url'),
    sessionActivityId: uuid('session_activity_id').references(() => activities.id, { onDelete: 'set null' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedByUserId: uuid('updated_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (t) => [
    index('calendar_events_course_range_idx').on(t.courseId, t.startsAt),
    index('calendar_events_scope_range_idx').on(t.scope, t.startsAt),
    check('calendar_events_scope_check', sql`(${t.scope} = 'course') = (${t.courseId} IS NOT NULL)`),
    check('calendar_events_title_check', sql`char_length(${t.title}) BETWEEN 1 AND 200`),
    check('calendar_events_description_check', sql`${t.description} IS NULL OR char_length(${t.description}) BETWEEN 1 AND 5000`),
    check('calendar_events_range_check', sql`${t.endsAt} > ${t.startsAt}`),
    check(
      'calendar_events_all_day_check',
      sql`(${t.allDay} AND ${t.startDate} IS NOT NULL AND ${t.endDate} IS NOT NULL AND ${t.endDate} >= ${t.startDate})
        OR (NOT ${t.allDay} AND ${t.startDate} IS NULL AND ${t.endDate} IS NULL)`,
    ),
    check('calendar_events_time_zone_check', sql`char_length(${t.timeZone}) BETWEEN 1 AND 64`),
    check('calendar_events_cancelled_check', sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL)`),
    // AP-045 teaching sessions.
    check('calendar_events_session_check', sql`(${t.sessionNumber} IS NULL) = (${t.sessionMode} IS NULL)`),
    check('calendar_events_session_scope_check', sql`${t.sessionMode} IS NULL OR ${t.scope} = 'course'`),
    check('calendar_events_session_number_check', sql`${t.sessionNumber} IS NULL OR ${t.sessionNumber} BETWEEN 1 AND 999`),
    check(
      'calendar_events_join_url_check',
      sql`${t.joinUrl} IS NULL OR (${t.sessionMode} IN ('live_online', 'presentation') AND ${t.joinUrl} LIKE 'https://%' AND char_length(${t.joinUrl}) <= 2000)`,
    ),
    check('calendar_events_session_activity_check', sql`${t.sessionActivityId} IS NULL OR ${t.sessionMode} IS NOT NULL`),
    // One session per number in a course, among events that are not cancelled (a cancelled session frees it).
    uniqueIndex('calendar_events_session_number_unique')
      .on(t.courseId, t.sessionNumber)
      .where(sql`${t.sessionNumber} IS NOT NULL AND ${t.status} <> 'cancelled'`),
    // Target of the composite foreign key that keeps session units inside the event's course.
    unique('calendar_events_id_course_id_unique').on(t.id, t.courseId),
  ],
);

/**
 * AP-045: the course units (sections) a teaching session covers. Both composite foreign keys share `course_id`,
 * so a unit of another course can never be linked. Removing a unit or deleting a (never published) event
 * removes its links.
 */
export const calendarEventUnits = pgTable(
  'calendar_event_units',
  {
    eventId: uuid('event_id').notNull(),
    courseId: uuid('course_id').notNull(),
    sectionId: uuid('section_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.sectionId] }),
    index('calendar_event_units_section_idx').on(t.sectionId),
    foreignKey({ name: 'calendar_event_units_event_fk', columns: [t.eventId, t.courseId], foreignColumns: [calendarEvents.id, calendarEvents.courseId] }).onDelete('cascade'),
    foreignKey({ name: 'calendar_event_units_section_fk', columns: [t.sectionId, t.courseId], foreignColumns: [sections.id, sections.courseId] }).onDelete('cascade'),
  ],
);
