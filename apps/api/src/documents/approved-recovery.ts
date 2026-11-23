import { createHash, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { recordAuditAs } from '../audit.js';
import type { Database } from '../db/client.js';
import { courseDocuments, documentStorageIntents } from '../db/schema/index.js';
import { ObjectStoreError, type RecoveryObjectStore } from './object-store.js';
import { listJournal } from './storage-recovery.js';

/**
 * AP-OPS-02: storage recovery in two approved stages, against Cloud Storage itself (see object-store.ts), for the
 * production design in docs/production-storage-recovery.md. Not enabled in production in this build.
 *
 * Stage A, `planApprovedRecovery` (reads only): every journal entry, classified with the database clock and an exact
 * Cloud Storage observation; the plan proposes deleting exactly the observed generation of each abandoned, unreferenced
 * file. Its digest (SHA-256) binds the environment (database, storage API endpoint, bucket), an expiry time and every
 * proposed action. The plan holds no storage keys, only one-way references to them.
 *
 * Stage B, `applyApprovedRecovery`: only with the plan and its approved digest, before the plan expires, against the
 * same environment. Each planned item is handled in its own transaction holding the journal entry's row lock, and is
 * done only if nothing changed: the lease must still be expired (database clock), no document may refer to the file,
 * and the object must still be the planned generation. The deletion is conditional on that generation, and the object
 * must then be gone before the entry is deleted and the audit event written, in one commit. Anything else is refused
 * or retained and reported. Entries that were not in the plan are never touched, so an old digest can never authorize
 * a newly created or modified object. A crash after a deletion rolls back the entry, and the next apply of the same
 * plan finds the object already gone.
 */

export const PLAN_FORMAT = 'academiapath-storage-recovery-plan/1';

export type PlanAction = 'delete' | 'forget_missing' | 'forget_referenced';
export type PlanItem = { intentId: string; operation: string; keyRef: string; action: PlanAction; generation: string | null };
export type PlanSkip = { intentId: string; operation: string; keyRef: string; reason: 'lease_active' | 'storage_error'; errorCode: string | null };
export type PlanEnvironment = { database: string; endpoint: string; bucket: string };

export type RecoveryPlan = {
  format: typeof PLAN_FORMAT;
  environment: PlanEnvironment;
  createdAt: string;
  expiresAt: string;
  /** `refused`: the storage could not be trusted or read; nothing may be applied. */
  status: 'ready' | 'refused';
  refusal: 'storage_unverified' | 'storage_error' | null;
  counts: { journaled: number; active: number; abandoned: number; proposedDeletions: number; forgetMissing: number; forgetReferenced: number; uncertain: number };
  truncated: boolean;
  /** What an approval authorizes, and nothing more. */
  items: PlanItem[];
  /** Entries left alone, and why (not authorized by the plan). */
  skipped: PlanSkip[];
  digest: string;
};

export type ApplyOutcome =
  | 'file_removed'
  | 'file_already_missing'
  | 'file_kept_referenced'
  | 'skipped_entry_gone'
  | 'skipped_locked'
  | 'skipped_lease_active'
  | 'skipped_now_referenced'
  | 'skipped_state_changed'
  | 'skipped_approval_expired'
  | 'failed';

export type ApplyReport = {
  tool: 'academiapath-storage-recovery-approved';
  mode: 'apply';
  planDigest: string;
  status: 'complete' | 'incomplete' | 'refused';
  refusal: 'invalid_plan' | 'digest_mismatch' | 'plan_refused' | 'wrong_environment' | 'wrong_bucket' | 'approval_expired' | 'storage_unverified' | 'storage_error' | 'database_error' | null;
  counts: Partial<Record<ApplyOutcome, number>>;
  entries: Array<{ intentId: string; keyRef: string; outcome: ApplyOutcome; errorCode?: string }>;
};

type Deps = { db: Database; store: RecoveryObjectStore; /** The database's identity without credentials, e.g. host:port/name. */ database: string };

/** A one-way reference to a storage key: identifies it in plans and reports without revealing it. */
export const keyRef = (storageKey: string) => createHash('sha256').update(`academiapath-storage-key:${storageKey}`).digest('hex');

/** The digest an approval refers to: the environment, the expiry and exactly the proposed actions. */
export function planDigest(plan: Pick<RecoveryPlan, 'format' | 'environment' | 'expiresAt' | 'status' | 'items'>): string {
  const canonical = JSON.stringify({
    format: plan.format,
    environment: { database: plan.environment.database, endpoint: plan.environment.endpoint, bucket: plan.environment.bucket },
    expiresAt: plan.expiresAt,
    status: plan.status,
    items: [...plan.items]
      .sort((a, b) => (a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0))
      .map((item) => [item.intentId, item.operation, item.keyRef, item.action, item.generation]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

const errorCode = (error: unknown) => (error instanceof ObjectStoreError ? error.code : 'UNKNOWN');

/** Like the local recovery's witness, against Cloud Storage: a store that shows none of the documents' files is not trusted. */
async function witness(db: Pick<Database, 'select'>, store: RecoveryObjectStore): Promise<'verified' | 'no_documents' | 'storage_unverified' | 'storage_error'> {
  const sample = await db.select({ storageKey: courseDocuments.storageKey }).from(courseDocuments).orderBy(desc(courseDocuments.createdAt)).limit(3);
  if (!sample.length) return 'no_documents';
  for (const { storageKey } of sample) {
    try {
      if ((await store.stat(storageKey)).state === 'present') return 'verified';
    } catch {
      return 'storage_error';
    }
  }
  return 'storage_unverified';
}

/** Stage A: the plan. Reads only; never deletes or changes anything. */
export async function planApprovedRecovery(deps: Deps, options: { limit?: number; expiresInSeconds?: number } = {}): Promise<RecoveryPlan> {
  const limit = options.limit ?? 500;
  const expiresIn = options.expiresInSeconds ?? 3600;
  return deps.db.transaction(
    async (tx) => {
      const [clock] = (await tx.execute(sql`SELECT now() AS now, now() + make_interval(secs => ${expiresIn}) AS expires`)).rows as Array<{ now: Date | string; expires: Date | string }>;
      const plan: Omit<RecoveryPlan, 'digest'> = {
        format: PLAN_FORMAT,
        environment: { database: deps.database, endpoint: deps.store.endpoint, bucket: deps.store.bucket },
        createdAt: new Date(clock!.now).toISOString(),
        expiresAt: new Date(clock!.expires).toISOString(),
        status: 'ready',
        refusal: null,
        counts: { journaled: 0, active: 0, abandoned: 0, proposedDeletions: 0, forgetMissing: 0, forgetReferenced: 0, uncertain: 0 },
        truncated: false,
        items: [],
        skipped: [],
      };
      const trust = await witness(tx, deps.store);
      if (trust === 'storage_unverified' || trust === 'storage_error') {
        const refused = { ...plan, status: 'refused' as const, refusal: trust };
        return { ...refused, digest: planDigest(refused) };
      }
      const rows = await listJournal(tx, limit);
      plan.truncated = rows.length > limit;
      for (const row of rows.slice(0, limit)) {
        plan.counts.journaled += 1;
        const ref = { intentId: row.id, operation: row.operation, keyRef: keyRef(row.storageKey) };
        if (!row.expired) {
          plan.counts.active += 1;
          plan.skipped.push({ ...ref, reason: 'lease_active', errorCode: null });
          continue;
        }
        plan.counts.abandoned += 1;
        if (row.referenced) {
          plan.counts.forgetReferenced += 1;
          plan.items.push({ ...ref, action: 'forget_referenced', generation: null });
          continue;
        }
        try {
          const observed = await deps.store.stat(row.storageKey);
          if (observed.state === 'present') {
            plan.counts.proposedDeletions += 1;
            plan.items.push({ ...ref, action: 'delete', generation: observed.generation });
          } else {
            plan.counts.forgetMissing += 1;
            plan.items.push({ ...ref, action: 'forget_missing', generation: null });
          }
        } catch (error) {
          // Uncertain: neither deleted nor forgotten; it stays journaled for a later plan.
          plan.counts.uncertain += 1;
          plan.skipped.push({ ...ref, reason: 'storage_error', errorCode: errorCode(error) });
        }
      }
      return { ...plan, digest: planDigest(plan) };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A plan read back from a file is untrusted input: only the exact expected shape is accepted. */
function validPlan(value: unknown): value is RecoveryPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<RecoveryPlan>;
  const env = plan.environment;
  return (
    plan.format === PLAN_FORMAT &&
    !!env &&
    typeof env.database === 'string' &&
    typeof env.endpoint === 'string' &&
    typeof env.bucket === 'string' &&
    typeof plan.expiresAt === 'string' &&
    !Number.isNaN(Date.parse(plan.expiresAt)) &&
    (plan.status === 'ready' || plan.status === 'refused') &&
    typeof plan.digest === 'string' &&
    HEX64.test(plan.digest) &&
    Array.isArray(plan.items) &&
    plan.items.length <= 10_000 &&
    plan.items.every(
      (item) =>
        item &&
        UUID.test(item.intentId) &&
        typeof item.operation === 'string' &&
        HEX64.test(item.keyRef) &&
        (item.action === 'delete' ? typeof item.generation === 'string' && /^[1-9]\d{0,19}$/.test(item.generation) : (item.action === 'forget_missing' || item.action === 'forget_referenced') && item.generation === null),
    ) &&
    new Set(plan.items.map((item) => item.intentId)).size === plan.items.length
  );
}

const sameDigest = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const SYSTEM = { userId: null, ip: null };

/** Stage B: applies an approved plan (see the module comment). Never throws for storage or database failures. */
export async function applyApprovedRecovery(deps: Deps, input: { plan: unknown; approvedDigest: string }): Promise<ApplyReport> {
  const report: ApplyReport = { tool: 'academiapath-storage-recovery-approved', mode: 'apply', planDigest: '', status: 'complete', refusal: null, counts: {}, entries: [] };
  const refuse = (refusal: NonNullable<ApplyReport['refusal']>) => ({ ...report, status: 'refused' as const, refusal });
  if (!validPlan(input.plan)) return refuse('invalid_plan');
  const plan = input.plan;
  report.planDigest = plan.digest;
  // The plan must be exactly what was approved: its own digest recomputed, and the digest the approver typed.
  const recomputed = planDigest(plan);
  if (!sameDigest(recomputed, plan.digest) || !HEX64.test(input.approvedDigest) || !sameDigest(recomputed, input.approvedDigest)) return refuse('digest_mismatch');
  if (plan.status !== 'ready') return refuse('plan_refused');
  // Never across environments or buckets.
  if (plan.environment.database !== deps.database || plan.environment.endpoint !== deps.store.endpoint) return refuse('wrong_environment');
  if (plan.environment.bucket !== deps.store.bucket) return refuse('wrong_bucket');
  try {
    const [clock] = (await deps.db.execute(sql`SELECT now() <= ${plan.expiresAt}::timestamptz AS valid`)).rows as Array<{ valid: boolean }>;
    if (!clock?.valid) return refuse('approval_expired');
    const trust = await witness(deps.db, deps.store);
    if (trust === 'storage_unverified' || trust === 'storage_error') return refuse(trust);
  } catch {
    return refuse('database_error');
  }

  const t = documentStorageIntents;
  const add = (item: PlanItem, outcome: ApplyOutcome, code?: string) => {
    report.entries.push({ intentId: item.intentId, keyRef: item.keyRef, outcome, ...(code ? { errorCode: code } : {}) });
    report.counts[outcome] = (report.counts[outcome] ?? 0) + 1;
    if (outcome === 'failed') report.status = 'incomplete';
  };
  const items = [...plan.items].sort((a, b) => (a.intentId < b.intentId ? -1 : 1));
  for (const item of items) {
    try {
      const result = await deps.db.transaction(async (tx): Promise<{ outcome: ApplyOutcome; code?: string }> => {
        // The approval must still be valid, the entry abandoned and not held by anyone else.
        const [row] = await tx
          .select()
          .from(t)
          .where(and(eq(t.id, item.intentId), sql`${t.leaseExpiresAt} <= now()`, sql`now() <= ${plan.expiresAt}::timestamptz`))
          .for('update', { skipLocked: true });
        if (!row) {
          const [state] = (
            await tx.execute(sql`SELECT (SELECT lease_expires_at > now() FROM document_storage_intents WHERE id = ${item.intentId}) AS active, now() > ${plan.expiresAt}::timestamptz AS expired`)
          ).rows as Array<{ active: boolean | null; expired: boolean }>;
          if (state?.expired) return { outcome: 'skipped_approval_expired' };
          if (state?.active === null || state?.active === undefined) return { outcome: 'skipped_entry_gone' };
          return { outcome: state.active ? 'skipped_lease_active' : 'skipped_locked' };
        }
        if (keyRef(row.storageKey) !== item.keyRef || row.operation !== item.operation) return { outcome: 'skipped_state_changed' };
        const before = { operation: row.operation, operationId: row.operationId, journaledAt: row.createdAt.toISOString(), attempts: row.attempts };
        const done = async (outcome: 'file_removed' | 'file_already_missing' | 'file_kept_referenced', generation: string | null) => {
          await tx.delete(t).where(eq(t.id, row.id));
          await recordAuditAs(tx, SYSTEM, {
            action: 'storage.write_recovered',
            entityType: 'document_storage_intent',
            entityId: row.id,
            before,
            after: { outcome, mode: 'approved', planDigest: plan.digest, generation },
          });
          return { outcome };
        };
        const failed = async (code: string) => {
          await tx
            .update(t)
            .set({ attempts: sql`${t.attempts} + 1`, lastError: code, lastAttemptAt: sql`now()` })
            .where(eq(t.id, row.id));
          await recordAuditAs(tx, SYSTEM, {
            action: 'storage.write_recovery_failed',
            entityType: 'document_storage_intent',
            entityId: row.id,
            before,
            after: { outcome: 'failed', mode: 'approved', planDigest: plan.digest, errorCode: code, attempts: row.attempts + 1 },
          });
          return { outcome: 'failed' as const, code };
        };

        const [reference] = await tx.select({ id: courseDocuments.id }).from(courseDocuments).where(eq(courseDocuments.storageKey, row.storageKey)).limit(1);
        if (item.action === 'forget_referenced') return reference ? done('file_kept_referenced', null) : { outcome: 'skipped_state_changed' };
        // A document referring to the file now: never deleted or forgotten under this approval.
        if (reference) return { outcome: 'skipped_now_referenced' };

        let observed;
        try {
          observed = await deps.store.stat(row.storageKey);
        } catch (error) {
          return failed(errorCode(error));
        }
        if (item.action === 'forget_missing') {
          // A file that appeared since the plan was approved needs a new plan.
          return observed.state === 'missing' ? done('file_already_missing', null) : { outcome: 'skipped_state_changed' };
        }
        if (observed.state === 'missing') return done('file_already_missing', item.generation);
        // Only the approved generation is ever deleted.
        if (observed.generation !== item.generation) return failed('GENERATION_CHANGED');
        try {
          const deleted = await deps.store.deleteGeneration(row.storageKey, item.generation!);
          const after = await deps.store.stat(row.storageKey);
          if (after.state === 'present') return failed(after.generation === item.generation ? 'STILL_PRESENT' : 'GENERATION_CHANGED');
          return done(deleted === 'deleted' ? 'file_removed' : 'file_already_missing', item.generation);
        } catch (error) {
          if (error instanceof ObjectStoreError && error.kind === 'precondition_failed') {
            // Changed between the check and the deletion: never delete it under this approval.
            return failed('GENERATION_CHANGED');
          }
          return failed(errorCode(error));
        }
      });
      add(item, result.outcome, result.code);
    } catch {
      // The transaction rolled back: the entry is as it was; a later apply (or a new plan) retries it.
      add(item, 'failed', 'DATABASE_ERROR');
    }
  }
  return report;
}
