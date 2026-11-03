import { sql } from 'drizzle-orm';
import { index, inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { primaryId } from './columns.js';
import { users } from './users.js';

/**
 * Append-only audit trail. Rows are never updated or deleted: a database
 * trigger (migration 0001_audit_log_append_only) rejects UPDATE, DELETE and
 * TRUNCATE. For that reason this table has created_at but no updated_at.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: primaryId(),
    /** Null for system-initiated actions. Users with audit history cannot be deleted. */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /** Dotted action name, e.g. `course.published`. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
    index('audit_log_actor_user_id_idx').on(t.actorUserId),
    index('audit_log_created_at_idx').on(t.createdAt),
  ],
);
