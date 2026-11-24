import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { recordAuditAs } from '../audit.js';
import type { Database } from '../db/client.js';
import { auditLog, courseDocuments, documentStorageIntents, storageRecoveryPlanEntries, storageRecoveryPlans, type StorageRecoveryPlanSummary } from '../db/schema/index.js';
import { ObjectStoreError, type ObjectObservation, type RecoveryObjectStore } from './object-store.js';
import { sameOperator, verifyOperator, type OperatorIdentityProvider, type RecoveryRole, type VerifiedOperator } from './operator-identity.js';
import { listJournal } from './storage-recovery.js';

/**
 * AP-OPS-03: durable, approval-based storage recovery against Cloud Storage itself (object-store.ts), for the production
 * design in docs/production-storage-recovery.md. NOT ENABLED IN PRODUCTION IN THIS BUILD (see `productionRecoveryRefused`
 * and operator-identity.ts).
 *
 * Lifecycle (storage_recovery_plans, migration 0038):
 *
 *   createRecoveryPlan   a verified planner; the plan is observed (journal, database clock, exact object generations)
 *                        and stored with a server-generated id, its binding (environment, database, storage endpoint,
 *                        bucket, prefix), an explicit expiry and a digest: AWAITING_APPROVAL.
 *   reviewRecoveryPlan   any verified recovery operator; read-only, recomputes the digest.
 *   approveRecoveryPlan  a verified approver who did not create the plan, quoting the digest they reviewed: APPROVED.
 *   revokeRecoveryPlan   an approver or the plan's creator, with a reason, at any time before it is finished: REVOKED.
 *   claimRecoveryPlan    a verified executor; atomically takes the approved plan with a fencing token and a short claim
 *                        lease (renewed with every entry): APPLYING. A plan whose claim lapsed (a crashed worker) or that
 *                        was left PARTIALLY_COMPLETED is resumed the same way; a live claim is never shared.
 *   executeRecoveryPlan  the claim holder handles only the plan's own entries, each at most once, and finishes the plan:
 *                        COMPLETED, or PARTIALLY_COMPLETED when retryable failures remain. Plans past their expiry
 *                        become EXPIRED; nothing can act on an expired, revoked or completed plan.
 *
 * The digest identifies the reviewed contents (it lets an approver confirm that what they approve is exactly what they
 * reviewed, and lets every later step detect tampering); it is not a credential and authorizes nothing. Authorization
 * comes from verified identities, their roles, separation of duties and the database state machine.
 *
 * Each entry is handled in its own short transaction, after its object was observed outside any transaction: with the
 * plan row locked (the claim and the approval are rechecked, so a revocation or a takeover takes effect between
 * entries), the entry locked, and the journal entry locked (SKIP LOCKED) only while its lease is expired by the
 * database clock. References are rechecked and the object must still be the planned generation. The only network calls
 * made inside a transaction are the generation-matched deletion and its verification: the journal entry's lock must be
 * held across them, because writers (storage-journal.ts) commit by deleting their journal entries and would otherwise
 * be able to reference a file in the middle of its deletion. Those transactions are bounded by the store's request
 * timeouts and by PostgreSQL's lock, statement and idle-in-transaction limits.
 */

export const PLAN_FORMAT = 'academiapath-storage-recovery-plan/2';
/** Plans expire after a short, explicit period: 1 second to 4 hours (default 1 hour). */
export const PLAN_TTL_LIMITS = { min: 1, max: 4 * 60 * 60, default: 60 * 60 } as const;
/** An execution claim lapses unless renewed (with every entry): 1 second to 1 hour (default 5 minutes). */
export const CLAIM_TTL_LIMITS = { min: 1, max: 60 * 60, default: 5 * 60 } as const;

export type PlanAction = 'delete' | 'forget_missing' | 'forget_referenced';
export type PlanStatus = 'draft' | 'awaiting_approval' | 'approved' | 'applying' | 'partially_completed' | 'completed' | 'expired' | 'revoked';
export type EntryState = 'pending' | 'done' | 'skipped' | 'failed' | 'failed_final';
export type EntryOutcome =
  | 'file_removed'
  | 'file_already_missing'
  | 'file_kept_referenced'
  | 'skipped_entry_gone'
  | 'skipped_lease_active'
  | 'skipped_now_referenced'
  | 'skipped_state_changed'
  | 'skipped_locked'
  | 'failed';

export type RecoveryDeps = {
  db: Database;
  store: RecoveryObjectStore;
  identity: OperatorIdentityProvider;
  /** The database's identity without credentials (host:port/name), from configuration. */
  database: string;
  /** The environment label (for example `demo`), from configuration, never from an operator. */
  environment: string;
};

export type Refusal =
  | 'identity_rejected'
  | 'not_authorized'
  | 'self_approval'
  | 'invalid_request'
  | 'not_found'
  | 'invalid_state'
  | 'expired'
  | 'revoked'
  | 'completed'
  | 'in_progress'
  | 'digest_mismatch'
  | 'integrity_failure'
  | 'wrong_environment'
  | 'wrong_bucket'
  | 'production_disabled'
  | 'storage_unverified'
  | 'storage_error';
export type Refused = { ok: false; refusal: Refusal };

export type PlanReview = {
  id: string;
  status: PlanStatus;
  /** True once the expiry has passed (by the database clock), even before the status says so. */
  expired: boolean;
  binding: { environment: string; database: string; endpoint: string; bucket: string; prefix: string };
  createdBy: { issuer: string; subject: string };
  createdAt: string;
  expiresAt: string;
  approvedBy: { issuer: string; subject: string; at: string } | null;
  revokedBy: { issuer: string; subject: string; at: string; reason: string } | null;
  claimedBy: { issuer: string; subject: string; until: string | null } | null;
  finishedAt: string | null;
  digest: string;
  /** Whether the stored contents still match the stored digest. */
  integrity: 'intact' | 'mismatch';
  summary: StorageRecoveryPlanSummary;
  entries: Array<{ intentId: string; operation: string; keyRef: string; action: PlanAction; generation: string | null; state: EntryState; outcome: string | null; errorCode: string | null; attempts: number }>;
};

/** Held by the worker that claimed a plan; the token fences out every other worker. */
export type RecoveryClaim = { readonly planId: string; readonly token: string; readonly digest: string; readonly ttlSeconds: number; readonly executor: { issuer: string; subject: string } };

export type StopReason = 'revoked' | 'expired' | 'claim_lost' | 'production_disabled' | 'wrong_environment' | 'wrong_bucket' | 'integrity_failure' | 'database_error';
export type ExecutionReport = {
  planId: string;
  digest: string;
  status: 'completed' | 'partially_completed' | 'stopped';
  stopReason: StopReason | null;
  counts: Partial<Record<EntryOutcome, number>>;
  entries: Array<{ intentId: string; keyRef: string; outcome: EntryOutcome; errorCode?: string; final?: boolean }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;
/** Failures that mean the object is not the one approved: only a new plan, with a new approval, can act on it. */
const FINAL_FAILURES = new Set(['GENERATION_CHANGED', 'STILL_PRESENT']);
const SYSTEM = { userId: null, ip: null };

/**
 * PRODUCTION RECOVERY IS NOT ENABLED IN THIS BUILD. Every lifecycle step that reads or changes storage refuses unless it
 * runs outside production and Cloud Run and its store is a local emulator (a loopback http endpoint), whatever the
 * caller passes. Enabling production is a separate, approved change (docs/production-storage-recovery.md).
 */
export function productionRecoveryRefused(store: { endpoint: string }): boolean {
  if (process.env.NODE_ENV === 'production' || process.env.K_SERVICE || process.env.CLOUD_RUN_JOB) return true;
  let url: URL;
  try {
    url = new URL(store.endpoint);
  } catch {
    return true;
  }
  return url.protocol !== 'http:' || !LOOPBACK.test(url.hostname);
}

/** A one-way reference to a storage key: identifies it in plans, reports and audit records without revealing it. */
export const keyRef = (storageKey: string) => createHash('sha256').update(`academiapath-storage-key:${storageKey}`).digest('hex');

/** JSON with sorted keys: the same value always serializes the same way (jsonb does not keep key order). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

type PlanRow = typeof storageRecoveryPlans.$inferSelect;
type EntryRow = typeof storageRecoveryPlanEntries.$inferSelect;
type DigestEntry = Pick<EntryRow, 'intentId' | 'operation' | 'keyRef' | 'action' | 'generation'>;

/** The digest of a plan's identity, binding, creator, times, summary and every entry (sorted by journal entry). */
export function planDigest(plan: Omit<PlanRow, 'digest' | 'status' | `approved${string}` | `revoke${string}` | `claim${string}` | 'finishedAt'>, entries: DigestEntry[]): string {
  return createHash('sha256')
    .update(
      canonical({
        format: plan.format,
        id: plan.id,
        binding: { environment: plan.environment, database: plan.databaseIdentity, endpoint: plan.storageEndpoint, bucket: plan.bucket, prefix: plan.objectPrefix },
        createdBy: { issuer: plan.createdByIssuer, subject: plan.createdBySubject },
        createdAt: plan.createdAt.toISOString(),
        expiresAt: plan.expiresAt.toISOString(),
        summary: plan.summary,
        entries: [...entries]
          .sort((a, b) => (a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0))
          .map((entry) => [entry.intentId, entry.operation, entry.keyRef, entry.action, entry.generation]),
      }),
    )
    .digest('hex');
}

const sameDigest = (a: string, b: string) => HEX64.test(a) && HEX64.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const errorCode = (error: unknown) => (error instanceof ObjectStoreError ? error.code : 'UNKNOWN');
const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

/** A plan lifecycle event (system actor; the verified operator is in the metadata). Refusals may name no valid plan. */
async function audit(db: Pick<Database, 'insert'>, action: string, planId: string | null, after: Record<string, unknown>) {
  await db.insert(auditLog).values({ actorUserId: null, action, entityType: 'storage_recovery_plan', entityId: planId, metadata: { before: null, after } });
}
const who = (operator: { issuer: string; subject: string }) => ({ issuer: operator.issuer, subject: operator.subject });

/** A refused request is recorded too (who tried what, and why), then answered. */
async function refuse(deps: RecoveryDeps, attempted: string, refusal: Refusal, operator: VerifiedOperator | null, planId: string | null): Promise<Refused> {
  await audit(deps.db, 'storage.recovery_request_rejected', planId && UUID.test(planId) ? planId : null, { attempted, refusal, operator: operator ? who(operator) : null });
  return { ok: false, refusal };
}

/** The verified operator, or a refusal: the credential must verify and carry one of the roles. */
async function authorize(deps: RecoveryDeps, credential: unknown, roles: RecoveryRole[], attempted: string, planId: string | null): Promise<{ ok: true; operator: VerifiedOperator } | Refused> {
  const operator = await verifyOperator(deps.identity, credential);
  if (!operator) return refuse(deps, attempted, 'identity_rejected', null, planId);
  if (!roles.some((role) => operator.roles.has(role))) return refuse(deps, attempted, 'not_authorized', operator, planId);
  return { ok: true, operator };
}

/** Plans are bound to one environment: an approval or claim from anywhere else is refused. */
function bindingRefusal(deps: RecoveryDeps, plan: PlanRow): 'wrong_environment' | 'wrong_bucket' | null {
  if (plan.environment !== deps.environment || plan.databaseIdentity !== deps.database || plan.storageEndpoint !== deps.store.endpoint) return 'wrong_environment';
  if (plan.bucket !== deps.store.bucket || plan.objectPrefix !== deps.store.prefix) return 'wrong_bucket';
  return null;
}

type LoadedPlan = PlanRow & { past: boolean; claimLive: boolean; entries: EntryRow[] };

async function loadPlan(db: Pick<Database, 'select'>, planId: string, lock: boolean): Promise<LoadedPlan | null> {
  const t = storageRecoveryPlans;
  const query = db
    .select({ plan: t, past: sql<boolean>`now() > ${t.expiresAt}`, claimLive: sql<boolean>`coalesce(${t.claimExpiresAt} > now(), false)` })
    .from(t)
    .where(eq(t.id, planId));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) return null;
  const entries = await db.select().from(storageRecoveryPlanEntries).where(eq(storageRecoveryPlanEntries.planId, planId)).orderBy(asc(storageRecoveryPlanEntries.intentId));
  return { ...row.plan, past: row.past, claimLive: row.claimLive, entries };
}

const intact = (plan: LoadedPlan) => sameDigest(planDigest(plan, plan.entries), plan.digest);

async function expire(tx: Pick<Database, 'update' | 'insert'>, plan: { id: string; status: string }, during: string) {
  await tx.update(storageRecoveryPlans).set({ status: 'expired' }).where(eq(storageRecoveryPlans.id, plan.id));
  await audit(tx, 'storage.recovery_plan_expired', plan.id, { previousStatus: plan.status, during });
}

function review(plan: LoadedPlan): PlanReview {
  return {
    id: plan.id,
    status: plan.status as PlanStatus,
    expired: plan.status === 'expired' || (plan.past && !['completed', 'revoked'].includes(plan.status)),
    binding: { environment: plan.environment, database: plan.databaseIdentity, endpoint: plan.storageEndpoint, bucket: plan.bucket, prefix: plan.objectPrefix },
    createdBy: { issuer: plan.createdByIssuer, subject: plan.createdBySubject },
    createdAt: iso(plan.createdAt)!,
    expiresAt: iso(plan.expiresAt)!,
    approvedBy: plan.approvedAt ? { issuer: plan.approvedByIssuer!, subject: plan.approvedBySubject!, at: iso(plan.approvedAt)! } : null,
    revokedBy: plan.revokedAt ? { issuer: plan.revokedByIssuer!, subject: plan.revokedBySubject!, at: iso(plan.revokedAt)!, reason: plan.revocationReason! } : null,
    claimedBy: plan.claimedBySubject ? { issuer: plan.claimedByIssuer!, subject: plan.claimedBySubject, until: iso(plan.claimExpiresAt) } : null,
    finishedAt: iso(plan.finishedAt),
    digest: plan.digest,
    integrity: intact(plan) ? 'intact' : 'mismatch',
    summary: plan.summary,
    entries: plan.entries.map((entry) => ({
      intentId: entry.intentId,
      operation: entry.operation,
      keyRef: entry.keyRef,
      action: entry.action as PlanAction,
      generation: entry.generation,
      state: entry.state as EntryState,
      outcome: entry.outcome,
      errorCode: entry.errorCode,
      attempts: entry.attempts,
    })),
  };
}

/** Like the local recovery's witness: a store that shows none of the documents' files is not trusted. */
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

type Planned = { intentId: string; operation: string; keyRef: string; action: PlanAction; generation: string | null };

/** Observes what a plan would contain. Reads only; storage is read outside any transaction. */
async function observe(db: Database, store: RecoveryObjectStore, limit: number): Promise<{ trust: Awaited<ReturnType<typeof witness>>; items: Planned[]; summary: StorageRecoveryPlanSummary }> {
  const summary: StorageRecoveryPlanSummary = {
    counts: { journaled: 0, active: 0, abandoned: 0, proposedDeletions: 0, forgetMissing: 0, forgetReferenced: 0, uncertain: 0 },
    truncated: false,
    skipped: [],
  };
  const items: Planned[] = [];
  const trust = await witness(db, store);
  if (trust === 'storage_unverified' || trust === 'storage_error') return { trust, items, summary };
  const rows = await listJournal(db, limit);
  summary.truncated = rows.length > limit;
  for (const row of rows.slice(0, limit)) {
    summary.counts.journaled += 1;
    const ref = { intentId: row.id, operation: row.operation, keyRef: keyRef(row.storageKey) };
    if (!row.expired) {
      summary.counts.active += 1;
      summary.skipped.push({ ...ref, reason: 'lease_active', errorCode: null });
      continue;
    }
    summary.counts.abandoned += 1;
    if (row.referenced) {
      summary.counts.forgetReferenced += 1;
      items.push({ ...ref, action: 'forget_referenced', generation: null });
      continue;
    }
    try {
      const observed = await store.stat(row.storageKey);
      if (observed.state === 'present') {
        summary.counts.proposedDeletions += 1;
        items.push({ ...ref, action: 'delete', generation: observed.generation });
      } else {
        summary.counts.forgetMissing += 1;
        items.push({ ...ref, action: 'forget_missing', generation: null });
      }
    } catch (error) {
      // Uncertain: left out of the plan, still journaled for a later one.
      summary.counts.uncertain += 1;
      summary.skipped.push({ ...ref, reason: 'storage_error', errorCode: errorCode(error) });
    }
  }
  return { trust, items, summary };
}

/** A read-only preview of what a plan would contain (the local command); stores nothing and authorizes nothing. */
export async function previewRecovery(deps: { db: Database; store: RecoveryObjectStore }, options: { limit?: number } = {}) {
  if (productionRecoveryRefused(deps.store)) return { status: 'refused' as const, refusal: 'production_disabled' as const, summary: null };
  const seen = await observe(deps.db, deps.store, options.limit ?? 500);
  if (seen.trust === 'storage_unverified' || seen.trust === 'storage_error') return { status: 'refused' as const, refusal: seen.trust, summary: seen.summary };
  return { status: 'ready' as const, refusal: null, summary: seen.summary };
}

/** Creates a plan from the current journal and storage, for review and approval. */
export async function createRecoveryPlan(
  deps: RecoveryDeps,
  input: { credential: unknown; ttlSeconds?: number; limit?: number },
): Promise<{ ok: true; plan: PlanReview | null; summary: StorageRecoveryPlanSummary } | Refused> {
  const auth = await authorize(deps, input.credential, ['storage_recovery.planner'], 'create', null);
  if (!auth.ok) return auth;
  const { operator } = auth;
  if (productionRecoveryRefused(deps.store)) return refuse(deps, 'create', 'production_disabled', operator, null);
  const ttl = input.ttlSeconds ?? PLAN_TTL_LIMITS.default;
  const limit = input.limit ?? 500;
  if (!Number.isInteger(ttl) || ttl < PLAN_TTL_LIMITS.min || ttl > PLAN_TTL_LIMITS.max || !Number.isInteger(limit) || limit < 1 || limit > 5000 || !LABEL.test(deps.environment)) {
    return refuse(deps, 'create', 'invalid_request', operator, null);
  }
  const seen = await observe(deps.db, deps.store, limit);
  if (seen.trust === 'storage_unverified' || seen.trust === 'storage_error') return refuse(deps, 'create', seen.trust, operator, null);
  if (!seen.items.length) return { ok: true, plan: null, summary: seen.summary };
  const planId = await deps.db.transaction(async (tx) => {
    const t = storageRecoveryPlans;
    const [plan] = await tx
      .insert(t)
      .values({
        format: PLAN_FORMAT,
        environment: deps.environment,
        databaseIdentity: deps.database,
        storageEndpoint: deps.store.endpoint,
        bucket: deps.store.bucket,
        objectPrefix: deps.store.prefix,
        digest: '0'.repeat(64),
        summary: seen.summary,
        createdByIssuer: operator.issuer,
        createdBySubject: operator.subject,
        createdAt: sql`date_trunc('milliseconds', now())`,
        expiresAt: sql`date_trunc('milliseconds', now()) + make_interval(secs => ${ttl})`,
      })
      .returning();
    await tx.insert(storageRecoveryPlanEntries).values(seen.items.map((item) => ({ planId: plan!.id, ...item })));
    const digest = planDigest(plan!, seen.items);
    await tx.update(t).set({ digest, status: 'awaiting_approval' }).where(eq(t.id, plan!.id));
    await audit(tx, 'storage.recovery_plan_created', plan!.id, { operator: who(operator), digest, expiresAt: iso(plan!.expiresAt), counts: seen.summary.counts, entries: seen.items.length });
    return plan!.id;
  });
  return { ok: true, plan: review((await loadPlan(deps.db, planId, false))!), summary: seen.summary };
}

/** Reads a plan for review (any verified recovery operator). Changes nothing. */
export async function reviewRecoveryPlan(deps: RecoveryDeps, input: { credential: unknown; planId: string }): Promise<{ ok: true; plan: PlanReview } | Refused> {
  const operator = await verifyOperator(deps.identity, input.credential);
  if (!operator) return { ok: false, refusal: 'identity_rejected' };
  if (!operator.roles.size) return { ok: false, refusal: 'not_authorized' };
  const plan = UUID.test(input.planId) ? await loadPlan(deps.db, input.planId, false) : null;
  return plan ? { ok: true, plan: review(plan) } : { ok: false, refusal: 'not_found' };
}

const CLOSED: Partial<Record<string, Refusal>> = { completed: 'completed', revoked: 'revoked', expired: 'expired' };

/** Approves a plan: a verified approver who is not its creator, quoting the digest of the contents they reviewed. */
export async function approveRecoveryPlan(deps: RecoveryDeps, input: { credential: unknown; planId: string; digest: string }): Promise<{ ok: true; plan: PlanReview } | Refused> {
  const auth = await authorize(deps, input.credential, ['storage_recovery.approver'], 'approve', input.planId);
  if (!auth.ok) return auth;
  const { operator } = auth;
  if (!UUID.test(input.planId) || typeof input.digest !== 'string') return refuse(deps, 'approve', UUID.test(input.planId) ? 'invalid_request' : 'not_found', operator, input.planId);
  const refusal = await deps.db.transaction(async (tx): Promise<Refusal | null> => {
    const plan = await loadPlan(tx, input.planId, true);
    if (!plan) return 'not_found';
    if (CLOSED[plan.status]) return CLOSED[plan.status]!;
    if (plan.status !== 'awaiting_approval') return 'invalid_state';
    if (plan.past) {
      await expire(tx, plan, 'approval');
      return 'expired';
    }
    const binding = bindingRefusal(deps, plan);
    if (binding) return binding;
    if (!intact(plan)) return 'integrity_failure';
    if (!sameDigest(input.digest, plan.digest)) return 'digest_mismatch';
    if (sameOperator(operator, { issuer: plan.createdByIssuer, subject: plan.createdBySubject })) return 'self_approval';
    await tx
      .update(storageRecoveryPlans)
      .set({ status: 'approved', approvedByIssuer: operator.issuer, approvedBySubject: operator.subject, approvedAt: sql`now()` })
      .where(eq(storageRecoveryPlans.id, plan.id));
    await audit(tx, 'storage.recovery_plan_approved', plan.id, { operator: who(operator), digest: plan.digest, expiresAt: iso(plan.expiresAt), entries: plan.entries.length });
    return null;
  });
  if (refusal) return refuse(deps, 'approve', refusal, operator, input.planId);
  return { ok: true, plan: review((await loadPlan(deps.db, input.planId, false))!) };
}

/** Revokes a plan before it is finished (an approver, or the plan's creator), with a reason. Takes effect between entries. */
export async function revokeRecoveryPlan(deps: RecoveryDeps, input: { credential: unknown; planId: string; reason: string }): Promise<{ ok: true; plan: PlanReview } | Refused> {
  const operator = await verifyOperator(deps.identity, input.credential);
  if (!operator) return refuse(deps, 'revoke', 'identity_rejected', null, input.planId);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!UUID.test(input.planId)) return refuse(deps, 'revoke', 'not_found', operator, input.planId);
  if (!reason || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) return refuse(deps, 'revoke', 'invalid_request', operator, input.planId);
  const refusal = await deps.db.transaction(async (tx): Promise<Refusal | null> => {
    const plan = await loadPlan(tx, input.planId, true);
    if (!plan) return 'not_found';
    const creator = sameOperator(operator, { issuer: plan.createdByIssuer, subject: plan.createdBySubject });
    if (!operator.roles.has('storage_recovery.approver') && !creator) return 'not_authorized';
    if (CLOSED[plan.status]) return CLOSED[plan.status]!;
    if (plan.past) {
      await expire(tx, plan, 'revocation');
      return 'expired';
    }
    await tx
      .update(storageRecoveryPlans)
      .set({ status: 'revoked', revokedByIssuer: operator.issuer, revokedBySubject: operator.subject, revokedAt: sql`now()`, revocationReason: reason })
      .where(eq(storageRecoveryPlans.id, plan.id));
    await audit(tx, 'storage.recovery_plan_revoked', plan.id, { operator: who(operator), reason, previousStatus: plan.status, digest: plan.digest });
    return null;
  });
  if (refusal) return refuse(deps, 'revoke', refusal, operator, input.planId);
  return { ok: true, plan: review((await loadPlan(deps.db, input.planId, false))!) };
}

/**
 * Claims an approved plan for execution (a verified executor), atomically with rechecking its approval: not revoked,
 * not expired, same environment, contents intact. A plan whose previous claim lapsed, or that was left partially
 * completed, is resumed; a live claim is never shared.
 */
export async function claimRecoveryPlan(
  deps: RecoveryDeps,
  input: { credential: unknown; planId: string; claimTtlSeconds?: number },
): Promise<{ ok: true; claim: RecoveryClaim; resumed: boolean } | Refused> {
  const auth = await authorize(deps, input.credential, ['storage_recovery.executor'], 'claim', input.planId);
  if (!auth.ok) return auth;
  const { operator } = auth;
  if (productionRecoveryRefused(deps.store)) return refuse(deps, 'claim', 'production_disabled', operator, input.planId);
  const ttl = input.claimTtlSeconds ?? CLAIM_TTL_LIMITS.default;
  if (!UUID.test(input.planId)) return refuse(deps, 'claim', 'not_found', operator, input.planId);
  if (!Number.isInteger(ttl) || ttl < CLAIM_TTL_LIMITS.min || ttl > CLAIM_TTL_LIMITS.max) return refuse(deps, 'claim', 'invalid_request', operator, input.planId);
  // A plan from another environment is refused before its storage is touched; then the storage must be trustworthy
  // before anything is claimed (read outside any transaction). Both are checked again under the lock below.
  const peek = await loadPlan(deps.db, input.planId, false);
  if (!peek) return refuse(deps, 'claim', 'not_found', operator, input.planId);
  const misbound = bindingRefusal(deps, peek);
  if (misbound) return refuse(deps, 'claim', misbound, operator, input.planId);
  const trust = await witness(deps.db, deps.store);
  if (trust === 'storage_unverified' || trust === 'storage_error') return refuse(deps, 'claim', trust, operator, input.planId);
  const token = randomUUID();
  const result = await deps.db.transaction(async (tx): Promise<{ refusal: Refusal } | { resumed: boolean; digest: string }> => {
    const plan = await loadPlan(tx, input.planId, true);
    if (!plan) return { refusal: 'not_found' };
    if (CLOSED[plan.status]) return { refusal: CLOSED[plan.status]! };
    if (!['approved', 'applying', 'partially_completed'].includes(plan.status)) return { refusal: 'invalid_state' };
    if (plan.past) {
      await expire(tx, plan, 'claim');
      return { refusal: 'expired' };
    }
    if (plan.status === 'applying' && plan.claimLive) return { refusal: 'in_progress' };
    const binding = bindingRefusal(deps, plan);
    if (binding) return { refusal: binding };
    if (!intact(plan)) return { refusal: 'integrity_failure' };
    if (!plan.approvedAt || sameOperator({ issuer: plan.createdByIssuer, subject: plan.createdBySubject }, { issuer: plan.approvedByIssuer, subject: plan.approvedBySubject })) return { refusal: 'invalid_state' };
    const resumed = plan.status !== 'approved';
    await tx
      .update(storageRecoveryPlans)
      .set({
        status: 'applying',
        claimToken: token,
        claimedByIssuer: operator.issuer,
        claimedBySubject: operator.subject,
        claimedAt: sql`now()`,
        claimExpiresAt: sql`now() + make_interval(secs => ${ttl})`,
      })
      .where(eq(storageRecoveryPlans.id, plan.id));
    await audit(tx, resumed ? 'storage.recovery_plan_resumed' : 'storage.recovery_plan_claimed', plan.id, {
      operator: who(operator),
      digest: plan.digest,
      previousStatus: plan.status,
      previousClaimant: resumed && plan.claimedBySubject ? { issuer: plan.claimedByIssuer, subject: plan.claimedBySubject } : null,
    });
    return { resumed, digest: plan.digest };
  });
  if ('refusal' in result) return refuse(deps, 'claim', result.refusal, operator, input.planId);
  return { ok: true, resumed: result.resumed, claim: Object.freeze({ planId: input.planId, token, digest: result.digest, ttlSeconds: ttl, executor: who(operator) }) };
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Bounds a transaction that may wait on storage: it can never hold its locks for long, even if the worker hangs. */
async function bounded(tx: Tx) {
  await tx.execute(
    sql`SELECT set_config('lock_timeout', '5s', true), set_config('statement_timeout', '15s', true), set_config('idle_in_transaction_session_timeout', '60s', true)`,
  );
}

/** With the plan row locked: the claim must still be this worker's, live, and the plan approved, unrevoked and unexpired. Renews the claim. */
async function fence(tx: Tx, claim: RecoveryClaim): Promise<StopReason | null> {
  const [plan] = (
    await tx.execute(
      sql`SELECT status, claim_token, coalesce(claim_expires_at > now(), false) AS live, now() > expires_at AS past FROM storage_recovery_plans WHERE id = ${claim.planId} FOR UPDATE`,
    )
  ).rows as Array<{ status: string; claim_token: string | null; live: boolean; past: boolean }>;
  if (!plan) return 'claim_lost';
  if (plan.status === 'revoked') return 'revoked';
  if (plan.status === 'expired') return 'expired';
  if (plan.status !== 'applying' || plan.claim_token !== claim.token) return 'claim_lost';
  if (plan.past) {
    await expire(tx, { id: claim.planId, status: plan.status }, 'execution');
    return 'expired';
  }
  if (!plan.live) return 'claim_lost';
  await tx.execute(sql`UPDATE storage_recovery_plans SET claim_expires_at = now() + make_interval(secs => ${claim.ttlSeconds}) WHERE id = ${claim.planId}`);
  return null;
}

type Observed = { kind: 'none' } | { kind: 'observed'; observation: ObjectObservation } | { kind: 'error'; code: string };

/** Observes an entry's object outside any transaction (the decision is taken later, under locks). */
async function observeEntry(deps: RecoveryDeps, entry: EntryRow): Promise<Observed> {
  if (entry.action === 'forget_referenced') return { kind: 'none' };
  const [row] = await deps.db.select({ storageKey: documentStorageIntents.storageKey }).from(documentStorageIntents).where(eq(documentStorageIntents.id, entry.intentId));
  if (!row || keyRef(row.storageKey) !== entry.keyRef) return { kind: 'none' };
  try {
    return { kind: 'observed', observation: await deps.store.stat(row.storageKey) };
  } catch (error) {
    return { kind: 'error', code: errorCode(error) };
  }
}

type EntryResult = { stop: StopReason } | { outcome: EntryOutcome; code?: string; final?: boolean } | { untouched: true };

/** One entry, in one short transaction (see the module comment). */
async function processEntry(tx: Tx, deps: RecoveryDeps, claim: RecoveryClaim, entry: EntryRow, observed: Observed): Promise<EntryResult> {
  await bounded(tx);
  const stop = await fence(tx, claim);
  if (stop) return { stop };
  const e = storageRecoveryPlanEntries;
  const t = documentStorageIntents;
  const [current] = await tx
    .select({ state: e.state, attempts: e.attempts })
    .from(e)
    .where(and(eq(e.planId, claim.planId), eq(e.intentId, entry.intentId)))
    .for('update');
  if (!current || (current.state !== 'pending' && current.state !== 'failed')) return { untouched: true };

  const record = async (state: EntryState, outcome: EntryOutcome, code: string | null) => {
    const finished = state !== 'failed';
    await tx
      .update(e)
      .set({
        state,
        outcome,
        errorCode: code,
        attempts: state === 'failed' || state === 'failed_final' ? sql`${e.attempts} + 1` : sql`${e.attempts}`,
        lastAttemptAt: sql`now()`,
        finishedAt: finished ? sql`now()` : null,
      })
      .where(and(eq(e.planId, claim.planId), eq(e.intentId, entry.intentId)));
  };
  const context = { mode: 'approved', planId: claim.planId, planDigest: claim.digest, executor: claim.executor };
  const skip = async (outcome: EntryOutcome) => {
    await record('skipped', outcome, null);
    await recordAuditAs(tx, SYSTEM, { action: 'storage.write_recovery_skipped', entityType: 'document_storage_intent', entityId: entry.intentId, before: null, after: { outcome, ...context } });
    return { outcome };
  };

  // The journal entry: locked only while its lease is expired by the database clock, and only if no one else holds it.
  const [row] = await tx
    .select()
    .from(t)
    .where(and(eq(t.id, entry.intentId), sql`${t.leaseExpiresAt} <= now()`))
    .for('update', { skipLocked: true });
  if (!row) {
    const [state] = (await tx.execute(sql`SELECT lease_expires_at > now() AS active FROM document_storage_intents WHERE id = ${entry.intentId}`)).rows as Array<{ active: boolean }>;
    if (!state) return skip('skipped_entry_gone');
    if (state.active) return skip('skipped_lease_active');
    return { untouched: true }; // another worker or recovery holds it: retried later
  }
  if (keyRef(row.storageKey) !== entry.keyRef || row.operation !== entry.operation) return skip('skipped_state_changed');
  const before = { operation: row.operation, operationId: row.operationId, journaledAt: row.createdAt.toISOString(), attempts: row.attempts };

  const done = async (outcome: 'file_removed' | 'file_already_missing' | 'file_kept_referenced', generation: string | null) => {
    await tx.delete(t).where(eq(t.id, row.id));
    await record('done', outcome, null);
    await recordAuditAs(tx, SYSTEM, { action: 'storage.write_recovered', entityType: 'document_storage_intent', entityId: row.id, before, after: { outcome, generation, ...context } });
    return { outcome };
  };
  const failed = async (code: string) => {
    const final = FINAL_FAILURES.has(code);
    await record(final ? 'failed_final' : 'failed', 'failed', code);
    await tx
      .update(t)
      .set({ attempts: sql`${t.attempts} + 1`, lastError: code, lastAttemptAt: sql`now()` })
      .where(eq(t.id, row.id));
    await recordAuditAs(tx, SYSTEM, {
      action: 'storage.write_recovery_failed',
      entityType: 'document_storage_intent',
      entityId: row.id,
      before,
      after: { outcome: 'failed', errorCode: code, final, attempts: current.attempts + 1, ...context },
    });
    return { outcome: 'failed' as const, code, final };
  };

  const [reference] = await tx.select({ id: courseDocuments.id }).from(courseDocuments).where(eq(courseDocuments.storageKey, row.storageKey)).limit(1);
  if (entry.action === 'forget_referenced') return reference ? done('file_kept_referenced', null) : skip('skipped_state_changed');
  // A document refers to the file now: never deleted or forgotten under this approval.
  if (reference) return skip('skipped_now_referenced');
  if (observed.kind === 'none') return failed('NOT_OBSERVED');
  if (observed.kind === 'error') return failed(observed.code);
  if (entry.action === 'forget_missing') {
    // A file that appeared since the plan was approved needs a new plan.
    return observed.observation.state === 'missing' ? done('file_already_missing', null) : skip('skipped_state_changed');
  }
  if (observed.observation.state === 'missing') return done('file_already_missing', entry.generation);
  // Only the approved generation is ever deleted; a replaced object is not even asked to be deleted.
  if (observed.observation.generation !== entry.generation) return failed('GENERATION_CHANGED');
  try {
    const deleted = await deps.store.deleteGeneration(row.storageKey, entry.generation!);
    const after = await deps.store.stat(row.storageKey);
    if (after.state === 'present') return failed(after.generation === entry.generation ? 'STILL_PRESENT' : 'GENERATION_CHANGED');
    return done(deleted === 'deleted' ? 'file_removed' : 'file_already_missing', entry.generation);
  } catch (error) {
    // 412: replaced between the check and the deletion; it is never deleted under this approval.
    if (error instanceof ObjectStoreError && error.kind === 'precondition_failed') return failed('GENERATION_CHANGED');
    return failed(errorCode(error));
  }
}

/** Ends this worker's pass: COMPLETED when every entry is finished, else PARTIALLY_COMPLETED (resumable until expiry). */
async function finish(deps: RecoveryDeps, claim: RecoveryClaim, report: ExecutionReport) {
  await deps.db.transaction(async (tx) => {
    const [plan] = (
      await tx.execute(sql`SELECT status, claim_token, now() > expires_at AS past FROM storage_recovery_plans WHERE id = ${claim.planId} FOR UPDATE`)
    ).rows as Array<{ status: string; claim_token: string | null; past: boolean }>;
    if (!plan || plan.status !== 'applying' || plan.claim_token !== claim.token) {
      report.status = 'stopped';
      report.stopReason = plan?.status === 'revoked' ? 'revoked' : plan?.status === 'expired' ? 'expired' : 'claim_lost';
      return;
    }
    if (plan.past) {
      await expire(tx, { id: claim.planId, status: plan.status }, 'execution');
      report.status = 'stopped';
      report.stopReason = 'expired';
      return;
    }
    const states = (
      await tx.select({ state: storageRecoveryPlanEntries.state, n: sql<number>`count(*)::int` }).from(storageRecoveryPlanEntries).where(eq(storageRecoveryPlanEntries.planId, claim.planId)).groupBy(storageRecoveryPlanEntries.state)
    ).reduce<Record<string, number>>((all, row) => ({ ...all, [row.state]: row.n }), {});
    const open = (states.pending ?? 0) + (states.failed ?? 0);
    report.status = open ? 'partially_completed' : 'completed';
    await tx
      .update(storageRecoveryPlans)
      .set({ status: report.status, claimToken: null, claimExpiresAt: null, finishedAt: open ? null : sql`now()` })
      .where(eq(storageRecoveryPlans.id, claim.planId));
    await audit(tx, open ? 'storage.recovery_plan_partially_completed' : 'storage.recovery_plan_completed', claim.planId, { executor: claim.executor, digest: claim.digest, entryStates: states, run: report.counts });
  });
}

/** Executes a claimed plan: only its own entries, each in its own transaction, as long as the claim holds. */
export async function executeRecoveryPlan(deps: RecoveryDeps, claim: RecoveryClaim): Promise<ExecutionReport> {
  const report: ExecutionReport = { planId: claim.planId, digest: claim.digest, status: 'stopped', stopReason: null, counts: {}, entries: [] };
  const stopWith = (reason: StopReason) => ({ ...report, status: 'stopped' as const, stopReason: reason });
  if (productionRecoveryRefused(deps.store)) return stopWith('production_disabled');
  const plan = await loadPlan(deps.db, claim.planId, false);
  if (!plan) return stopWith('claim_lost');
  const binding = bindingRefusal(deps, plan);
  if (binding) return stopWith(binding);
  if (!intact(plan) || !sameDigest(plan.digest, claim.digest)) return stopWith('integrity_failure');
  const add = (entry: EntryRow, outcome: EntryOutcome, code?: string, final?: boolean) => {
    report.entries.push({ intentId: entry.intentId, keyRef: entry.keyRef, outcome, ...(code ? { errorCode: code } : {}), ...(final !== undefined ? { final } : {}) });
    report.counts[outcome] = (report.counts[outcome] ?? 0) + 1;
  };
  for (const entry of plan.entries.filter((item) => item.state === 'pending' || item.state === 'failed')) {
    // Stop early, before reading storage, if the plan was revoked, expired or taken over.
    const early = await deps.db.transaction((tx) => fence(tx, claim)).catch(() => 'database_error' as const);
    if (early) return stopWith(early);
    const observed = await observeEntry(deps, entry);
    let result: EntryResult;
    try {
      result = await deps.db.transaction((tx) => processEntry(tx, deps, claim, entry, observed));
    } catch {
      // Rolled back: the entry and its journal entry are as they were; a resumed run retries it.
      add(entry, 'failed', 'DATABASE_ERROR', false);
      return stopWith('database_error');
    }
    if ('stop' in result) return stopWith(result.stop);
    if ('untouched' in result) add(entry, 'skipped_locked');
    else add(entry, result.outcome, result.code, result.final);
  }
  await finish(deps, claim, report);
  return report;
}

/** Claims (or resumes) and executes an approved plan. */
export async function runRecoveryPlan(deps: RecoveryDeps, input: { credential: unknown; planId: string; claimTtlSeconds?: number }): Promise<{ ok: true; resumed: boolean; report: ExecutionReport } | Refused> {
  const claimed = await claimRecoveryPlan(deps, input);
  if (!claimed.ok) return claimed;
  return { ok: true, resumed: claimed.resumed, report: await executeRecoveryPlan(deps, claimed.claim) };
}
