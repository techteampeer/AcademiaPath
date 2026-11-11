import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId } from './columns.js';
import { courses } from './courses.js';
import { users } from './users.js';

/**
 * Course discussion forums (AP-027). Every published course has one forum: topics (a title and an opening
 * text) and their replies. A reply answers the topic or another reply; replies to replies are one level deep.
 * Who may read, post and moderate is derived from current active enrollments on every request, never stored.
 * Texts are plain text. Nothing is ever deleted: moderators hide and restore topics and replies instead.
 */
export const forumTopics = pgTable(
  'forum_topics',
  {
    id: primaryId(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Chosen by the client per new topic: a retried create returns the first topic instead of a duplicate. */
    clientRequestId: uuid('client_request_id').notNull(),
    /** The number given to the latest reply (replies are numbered 1, 2, 3… within the topic, in commit order). */
    lastPostNumber: integer('last_post_number').notNull().default(0),
    /** The latest visible activity (the topic or its newest visible reply): orders the topic list. */
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    pinnedByUserId: uuid('pinned_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /** While locked, only moderators can reply and nobody can edit. */
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedByUserId: uuid('locked_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /** Hidden by a moderator: kept, but only moderators can see the topic and its replies. */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    hiddenByUserId: uuid('hidden_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Lets replies reference their topic together with its course (both must match).
    unique('forum_topics_id_course_unique').on(t.id, t.courseId),
    uniqueIndex('forum_topics_client_request_unique').on(t.courseId, t.authorUserId, t.clientRequestId),
    index('forum_topics_course_activity_idx').on(t.courseId, t.lastActivityAt),
    index('forum_topics_author_created_idx').on(t.authorUserId, t.createdAt),
    check('forum_topics_title_check', sql`char_length(${t.title}) BETWEEN 1 AND 200 AND ${t.title} ~ '\\S'`),
    check('forum_topics_body_check', sql`char_length(${t.body}) BETWEEN 1 AND 10000 AND ${t.body} ~ '\\S'`),
    check('forum_topics_post_number_check', sql`${t.lastPostNumber} >= 0`),
    check('forum_topics_pinned_check', sql`(${t.pinnedAt} IS NULL) = (${t.pinnedByUserId} IS NULL)`),
    check('forum_topics_locked_check', sql`(${t.lockedAt} IS NULL) = (${t.lockedByUserId} IS NULL)`),
    check('forum_topics_hidden_check', sql`(${t.hiddenAt} IS NULL) = (${t.hiddenByUserId} IS NULL)`),
  ],
);

export const forumPosts = pgTable(
  'forum_posts',
  {
    id: primaryId(),
    courseId: uuid('course_id').notNull(),
    topicId: uuid('topic_id').notNull(),
    /** The reply this one answers (one level deep), or null for a reply to the topic itself. */
    parentPostId: uuid('parent_post_id'),
    /** 1, 2, 3… within the topic, assigned under the topic's row lock: stable order without gaps or ties. */
    postNumber: integer('post_number').notNull(),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    clientRequestId: uuid('client_request_id').notNull(),
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    hiddenByUserId: uuid('hidden_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'forum_posts_topic_fk', columns: [t.topicId, t.courseId], foreignColumns: [forumTopics.id, forumTopics.courseId] }).onDelete('restrict'),
    // A parent reply always belongs to the same topic.
    foreignKey({ name: 'forum_posts_parent_fk', columns: [t.parentPostId, t.topicId], foreignColumns: [t.id, t.topicId] }).onDelete('restrict'),
    unique('forum_posts_id_topic_unique').on(t.id, t.topicId),
    uniqueIndex('forum_posts_topic_number_unique').on(t.topicId, t.postNumber),
    uniqueIndex('forum_posts_client_request_unique').on(t.topicId, t.authorUserId, t.clientRequestId),
    index('forum_posts_parent_idx').on(t.parentPostId),
    index('forum_posts_author_created_idx').on(t.authorUserId, t.createdAt),
    check('forum_posts_body_check', sql`char_length(${t.body}) BETWEEN 1 AND 10000 AND ${t.body} ~ '\\S'`),
    check('forum_posts_number_check', sql`${t.postNumber} >= 1`),
    check('forum_posts_parent_check', sql`${t.parentPostId} IS NULL OR ${t.parentPostId} <> ${t.id}`),
    check('forum_posts_hidden_check', sql`(${t.hiddenAt} IS NULL) = (${t.hiddenByUserId} IS NULL)`),
  ],
);
