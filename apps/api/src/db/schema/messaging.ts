import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './columns.js';
import { courses } from './courses.js';
import { conversationKindEnum, notificationTypeEnum } from './enums.js';
import { users } from './users.js';

/**
 * Messaging (AP-026). Every conversation belongs to one course.
 * - A direct conversation joins one student and one teaching-staff member (instructor or non-editing
 *   instructor) of that course. `participant_low_id`/`participant_high_id` are the two user ids in order, so
 *   each pair has at most one conversation per course.
 * - The course conversation (at most one per course) is open to the course's current students and teaching
 *   staff.
 * Who may read and write is derived from current active enrollments on every request; no participant list is
 * stored or accepted from clients. Messages are plain text and never deleted (instructors can hide one).
 */
export const conversations = pgTable(
  'conversations',
  {
    id: primaryId(),
    kind: conversationKindEnum('kind').notNull(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    participantLowId: uuid('participant_low_id').references(() => users.id, { onDelete: 'restrict' }),
    participantHighId: uuid('participant_high_id').references(() => users.id, { onDelete: 'restrict' }),
    /** Course conversations only: while locked, nobody can post (instructors and administrators lock). */
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedByUserId: uuid('locked_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('conversations_course_unique').on(t.courseId).where(sql`${t.kind} = 'course'`),
    uniqueIndex('conversations_direct_pair_unique').on(t.courseId, t.participantLowId, t.participantHighId).where(sql`${t.kind} = 'direct'`),
    index('conversations_participant_low_idx').on(t.participantLowId),
    index('conversations_participant_high_idx').on(t.participantHighId),
    check('conversations_kind_check', sql`(${t.kind} = 'direct') = (${t.participantLowId} IS NOT NULL AND ${t.participantHighId} IS NOT NULL)`),
    check('conversations_pair_order_check', sql`${t.participantLowId} IS NULL OR ${t.participantLowId} < ${t.participantHighId}`),
    check('conversations_lock_check', sql`(${t.kind} = 'course' OR ${t.lockedAt} IS NULL) AND (${t.lockedAt} IS NULL) = (${t.lockedByUserId} IS NULL)`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: primaryId(),
    /** Strictly increasing insertion order: stable ordering, pagination cursors and read positions. */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    /** Chosen by the client per message: a retried send returns the first message instead of a duplicate. */
    clientMessageId: uuid('client_message_id'),
    /** Hidden by an instructor (course conversations): kept, but its text is no longer returned. */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    hiddenByUserId: uuid('hidden_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('messages_seq_unique').on(t.seq),
    index('messages_conversation_seq_idx').on(t.conversationId, t.seq),
    index('messages_sender_created_idx').on(t.senderUserId, t.createdAt),
    uniqueIndex('messages_client_message_unique').on(t.conversationId, t.senderUserId, t.clientMessageId),
    check('messages_body_check', sql`char_length(${t.body}) BETWEEN 1 AND 4000 AND ${t.body} ~ '\\S'`),
    check('messages_hidden_check', sql`(${t.hiddenAt} IS NULL) = (${t.hiddenByUserId} IS NULL)`),
  ],
);

/** How far each person has read a conversation (the highest message seq seen). Only ever moves forward. */
export const conversationReads = pgTable(
  'conversation_reads',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'conversation_reads_pkey', columns: [t.conversationId, t.userId] }), index('conversation_reads_user_idx').on(t.userId)],
);

/**
 * In-app notifications (AP-026), one per recipient and event key (`dedupe_key`): a repeated event refreshes
 * the notification (unread again, new time) instead of adding another. `data` holds only what the recipient
 * may see (a title, a course code, a sender's name), never a message body, grade value or answer. Access is
 * re-checked when notifications are read: course notifications are shown only while the recipient still has
 * access to the course.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    courseId: uuid('course_id').references(() => courses.id, { onDelete: 'restrict' }),
    /** The conversation, announcement, activity or certificate the notification is about. */
    entityId: uuid('entity_id').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    data: jsonb('data')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** When the event last happened (ordering). */
    eventAt: timestamp('event_at', { withTimezone: true }).notNull().defaultNow(),
    /** Not shown before this instant (a scheduled announcement). */
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
    /** The event no longer applies (an archived or unscheduled announcement): hidden, but kept. */
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notifications_user_dedupe_unique').on(t.userId, t.dedupeKey),
    index('notifications_user_event_idx').on(t.userId, t.eventAt),
    index('notifications_dedupe_idx').on(t.dedupeKey),
    check('notifications_dedupe_check', sql`char_length(${t.dedupeKey}) BETWEEN 1 AND 200`),
  ],
);
