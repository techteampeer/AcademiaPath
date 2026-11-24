import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { primaryId } from './columns.js';

/** What a plan showed its reviewers besides its entries: counts and the entries left alone (one-way key references only). */
export type StorageRecoveryPlanSummary = {
  counts: { journaled: number; active: number; abandoned: number; proposedDeletions: number; forgetMissing: number; forgetReferenced: number; uncertain: number };
  truncated: boolean;
  skipped: Array<{ intentId: string; operation: string; keyRef: string; reason: 'lease_active' | 'storage_error'; errorCode: string | null }>;
};

/**
 * AP-OPS-03: durable storage recovery plans and their approvals (documents/approved-recovery.ts). A plan is created by
 * a verified operator, bound to one environment (database, storage API, bucket and object prefix) and expires at a
 * fixed time. Its contents and digest are immutable once created, and the approval, revocation and execution claim are
 * recorded on it by verified identities (issuer and subject), never by caller-supplied names. Database triggers
 * (migration 0038) reject edits to the contents, invalid status transitions and deletions; every lifecycle event is
 * also written to the append-only audit log. Storage keys are never stored here: entries name journal entries and
 * one-way key references.
 */
export const storageRecoveryPlans = pgTable(
  'storage_recovery_plans',
  {
    id: primaryId(),
    format: text('format').notNull(),
    /** The environment label, database identity (no credentials), storage endpoint, bucket and object prefix. */
    environment: text('environment').notNull(),
    databaseIdentity: text('database_identity').notNull(),
    storageEndpoint: text('storage_endpoint').notNull(),
    bucket: text('bucket').notNull(),
    objectPrefix: text('object_prefix').notNull(),
    /** SHA-256 over the plan's identity, binding, creator, times and every entry. Identifies the contents; it authorizes nothing. */
    digest: text('digest').notNull(),
    status: text('status').notNull().default('draft'),
    summary: jsonb('summary').$type<StorageRecoveryPlanSummary>().notNull(),
    createdByIssuer: text('created_by_issuer').notNull(),
    createdBySubject: text('created_by_subject').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    approvedByIssuer: text('approved_by_issuer'),
    approvedBySubject: text('approved_by_subject'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    revokedByIssuer: text('revoked_by_issuer'),
    revokedBySubject: text('revoked_by_subject'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revocationReason: text('revocation_reason'),
    /** The execution claim: a fencing token, who holds it and until when (renewed with every entry). */
    claimToken: uuid('claim_token'),
    claimedByIssuer: text('claimed_by_issuer'),
    claimedBySubject: text('claimed_by_subject'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('storage_recovery_plans_status_idx').on(t.status),
    check('storage_recovery_plans_status_check', sql`${t.status} IN ('draft', 'awaiting_approval', 'approved', 'applying', 'partially_completed', 'completed', 'expired', 'revoked')`),
    check('storage_recovery_plans_digest_check', sql`${t.digest} ~ '^[0-9a-f]{64}$'`),
    check('storage_recovery_plans_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      'storage_recovery_plans_approval_check',
      sql`(${t.approvedAt} IS NULL) = (${t.approvedBySubject} IS NULL) AND (${t.approvedAt} IS NULL) = (${t.approvedByIssuer} IS NULL) AND (${t.status} NOT IN ('approved', 'applying', 'partially_completed', 'completed') OR ${t.approvedAt} IS NOT NULL)`,
    ),
    check('storage_recovery_plans_separation_check', sql`${t.approvedBySubject} IS NULL OR NOT (${t.approvedByIssuer} = ${t.createdByIssuer} AND ${t.approvedBySubject} = ${t.createdBySubject})`),
    check(
      'storage_recovery_plans_revocation_check',
      sql`(${t.status} = 'revoked') = (${t.revokedAt} IS NOT NULL) AND (${t.revokedAt} IS NULL) = (${t.revokedBySubject} IS NULL) AND (${t.revokedAt} IS NULL) = (${t.revocationReason} IS NULL)`,
    ),
    check('storage_recovery_plans_claim_check', sql`${t.status} <> 'applying' OR (${t.claimToken} IS NOT NULL AND ${t.claimExpiresAt} IS NOT NULL AND ${t.claimedBySubject} IS NOT NULL)`),
  ],
);

/**
 * The journal entries a plan covers, exactly as reviewed (operation, one-way key reference, action and, for a deletion,
 * the object generation), with their execution outcome. `intent_id` names the `document_storage_intents` row reviewed;
 * it is not a foreign key because journal entries are deleted once their file is resolved, while this record stays.
 */
export const storageRecoveryPlanEntries = pgTable(
  'storage_recovery_plan_entries',
  {
    planId: uuid('plan_id')
      .notNull()
      .references(() => storageRecoveryPlans.id, { onDelete: 'restrict' }),
    intentId: uuid('intent_id').notNull(),
    operation: text('operation').notNull(),
    keyRef: text('key_ref').notNull(),
    action: text('action').notNull(),
    generation: text('generation'),
    /** pending → done | skipped | failed (retryable) | failed_final (the object changed or would not go: needs a new plan). */
    state: text('state').notNull().default('pending'),
    outcome: text('outcome'),
    errorCode: text('error_code'),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.planId, t.intentId] }),
    index('storage_recovery_plan_entries_intent_idx').on(t.intentId),
    check('storage_recovery_plan_entries_operation_check', sql`${t.operation} IN ('archive_import', 'document_upload')`),
    check('storage_recovery_plan_entries_key_ref_check', sql`${t.keyRef} ~ '^[0-9a-f]{64}$'`),
    check('storage_recovery_plan_entries_action_check', sql`${t.action} IN ('delete', 'forget_missing', 'forget_referenced')`),
    check('storage_recovery_plan_entries_generation_check', sql`(${t.action} = 'delete') = (${t.generation} IS NOT NULL) AND (${t.generation} IS NULL OR ${t.generation} ~ '^[1-9][0-9]{0,19}$')`),
    check('storage_recovery_plan_entries_state_check', sql`${t.state} IN ('pending', 'done', 'skipped', 'failed', 'failed_final')`),
    check('storage_recovery_plan_entries_attempts_check', sql`${t.attempts} >= 0`),
  ],
);
