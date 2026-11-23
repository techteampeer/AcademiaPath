import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { recordAuditAs } from '../audit.js';
import type { Database } from '../db/client.js';
import { courseDocuments, documentStorageIntents } from '../db/schema/index.js';
import type { DocumentStorage } from './storage.js';

/**
 * AP-040R: recovery of document files abandoned by interrupted writers (course archive imports and, since AP-040R2,
 * document uploads), from the write-ahead journal (`document_storage_intents`, see storage-journal.ts).
 *
 * A journal entry whose lease is still running belongs to a writer that may be alive (a slow import renews its lease
 * with every file), so it is never touched. An entry whose lease ran out is abandoned: its writer died, or failed and
 * could not clean up. For each one, in its own transaction holding the entry's row lock (`FOR UPDATE SKIP LOCKED`, so
 * concurrent recoveries never take the same entry, and a writer committing that entry waits and then aborts):
 * - a file a course document refers to is kept, and only the entry is forgotten;
 * - otherwise the file is removed (one already missing is fine) and then the entry is deleted, in the same commit as an
 *   audit event. A crash in between leaves the entry, and the next run finds the file already missing.
 * - a removal that fails keeps the entry, counts the attempt and records the error code, with a failure audit event.
 *
 * Nothing else is ever removed: files that were never journaled (written before the journal existed) are only reported
 * by the read-only storage audit. Audit events and stored errors hold no storage keys, file
 * contents, paths or messages; the operator's report (never an API response) lists storage keys.
 */

export type RecoveryStorage = Pick<DocumentStorage, 'exists' | 'remove'>;

/** What a dry run proposes for an entry. */
export type ProposedAction = 'wait_active_lease' | 'remove_file' | 'forget_entry_file_missing' | 'forget_entry_file_referenced';
/** What a recovery run did with an entry. */
export type RecoveryOutcome = 'wait_active_lease' | 'file_removed' | 'file_already_missing' | 'file_kept_referenced' | 'skipped_concurrent' | 'failed';

export type RecoveryEntry = {
  intentId: string;
  operation: string;
  operationId: string;
  storageKey: string;
  journaledAt: string;
  leaseExpiresAt: string;
  attempts: number;
  lastError: string | null;
  action: ProposedAction | RecoveryOutcome;
  /** Error code of a failed removal or database step (never a message or a path). */
  errorCode?: string;
};

export type RecoveryReport = {
  tool: 'academiapath-storage-recovery';
  reportVersion: 1;
  mode: 'dry_run' | 'apply';
  startedAt: string;
  finishedAt: string;
  status: 'complete' | 'incomplete';
  incompleteReasons: Array<'interrupted' | 'failures' | 'database_error' | 'limit_reached'>;
  counts: Record<'journaled' | 'active' | 'abandoned', number> & Partial<Record<ProposedAction | RecoveryOutcome, number>>;
  entries: RecoveryEntry[];
};

export type RecoveryOptions = {
  /** Most journal entries looked at in one run (default 500); more make the run `incomplete` (`limit_reached`). */
  limit?: number;
  signal?: AbortSignal;
};

type Deps = { db: Database; storage: RecoveryStorage };
type Listed = typeof documentStorageIntents.$inferSelect & { expired: boolean; referenced: boolean };

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
/** An error's code (`EIO`, `ENOSPC`…) when it has a plain one, else UNKNOWN: messages can hold paths. */
export const errorCodeOf = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : 'UNKNOWN';
};

const SYSTEM = { userId: null, ip: null };

function newReport(mode: RecoveryReport['mode']): RecoveryReport {
  const now = new Date().toISOString();
  return {
    tool: 'academiapath-storage-recovery',
    reportVersion: 1,
    mode,
    startedAt: now,
    finishedAt: now,
    status: 'complete',
    incompleteReasons: [],
    counts: { journaled: 0, active: 0, abandoned: 0 },
    entries: [],
  };
}

function finish(report: RecoveryReport): RecoveryReport {
  report.status = report.incompleteReasons.length ? 'incomplete' : 'complete';
  report.finishedAt = new Date().toISOString();
  return report;
}

const incomplete = (report: RecoveryReport, reason: RecoveryReport['incompleteReasons'][number]) => {
  if (!report.incompleteReasons.includes(reason)) report.incompleteReasons.push(reason);
};

function entryOf(row: typeof documentStorageIntents.$inferSelect, action: RecoveryEntry['action'], extra: Partial<RecoveryEntry> = {}): RecoveryEntry {
  return {
    intentId: row.id,
    operation: row.operation,
    operationId: row.operationId,
    storageKey: row.storageKey,
    journaledAt: row.createdAt.toISOString(),
    leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    attempts: row.attempts,
    lastError: row.lastError,
    action,
    ...extra,
  };
}

function add(report: RecoveryReport, entry: RecoveryEntry) {
  report.entries.push(entry);
  report.counts[entry.action] = (report.counts[entry.action] ?? 0) + 1;
}

/** The journal, oldest first, with the lease judged by the database clock (one clock for every writer and recoverer). */
async function listJournal(db: Pick<Database, 'select'>, limit: number): Promise<Listed[]> {
  const t = documentStorageIntents;
  return db
    .select({
      id: t.id,
      storageKey: t.storageKey,
      operation: t.operation,
      operationId: t.operationId,
      actorUserId: t.actorUserId,
      createdAt: t.createdAt,
      leaseExpiresAt: t.leaseExpiresAt,
      attempts: t.attempts,
      lastError: t.lastError,
      lastAttemptAt: t.lastAttemptAt,
      expired: sql<boolean>`${t.leaseExpiresAt} <= now()`,
      // Qualified by hand: Drizzle renders both columns as a bare "storage_key" inside a subquery.
      referenced: sql<boolean>`exists (select 1 from course_documents d where d.storage_key = document_storage_intents.storage_key)`,
    })
    .from(t)
    .orderBy(asc(t.createdAt), asc(t.id))
    .limit(limit + 1);
}

/** Dry run: what recovery would do now. Reads only (a READ ONLY transaction); never touches a file or a row. */
export async function planStorageRecovery(deps: Deps, options: RecoveryOptions = {}): Promise<RecoveryReport> {
  const report = newReport('dry_run');
  const limit = options.limit ?? 500;
  try {
    await deps.db.transaction(
      async (tx) => {
        const rows = await listJournal(tx, limit);
        if (rows.length > limit) incomplete(report, 'limit_reached');
        for (const row of rows.slice(0, limit)) {
          if (options.signal?.aborted) {
            incomplete(report, 'interrupted');
            break;
          }
          report.counts.journaled += 1;
          if (!row.expired) {
            report.counts.active += 1;
            add(report, entryOf(row, 'wait_active_lease'));
            continue;
          }
          report.counts.abandoned += 1;
          if (row.referenced) add(report, entryOf(row, 'forget_entry_file_referenced'));
          else add(report, entryOf(row, (await deps.storage.exists(row.storageKey)) ? 'remove_file' : 'forget_entry_file_missing'));
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  } catch {
    incomplete(report, 'database_error');
  }
  return finish(report);
}

/**
 * Removes the files of abandoned journal entries (see the module comment). Safe to repeat and to run concurrently;
 * never touches an entry whose lease is running or a file a document refers to. Never throws for a storage or database
 * failure: it is reported on the entry and makes the run `incomplete`.
 */
export async function recoverAbandonedStorageWrites(deps: Deps, options: RecoveryOptions = {}): Promise<RecoveryReport> {
  const report = newReport('apply');
  const limit = options.limit ?? 500;
  const t = documentStorageIntents;
  let rows: Listed[];
  try {
    rows = await listJournal(deps.db, limit);
  } catch {
    incomplete(report, 'database_error');
    return finish(report);
  }
  if (rows.length > limit) incomplete(report, 'limit_reached');
  for (const listed of rows.slice(0, limit)) {
    if (options.signal?.aborted) {
      incomplete(report, 'interrupted');
      break;
    }
    report.counts.journaled += 1;
    if (!listed.expired) {
      report.counts.active += 1;
      add(report, entryOf(listed, 'wait_active_lease'));
      continue;
    }
    report.counts.abandoned += 1;
    try {
      const entry = await deps.db.transaction(async (tx) => {
        // Locked, and still abandoned now: another recovery holding it, a writer settling it, or a renewed lease all skip.
        const [row] = await tx
          .select()
          .from(t)
          .where(and(eq(t.id, listed.id), lte(t.leaseExpiresAt, sql`now()`)))
          .for('update', { skipLocked: true });
        if (!row) return entryOf(listed, 'skipped_concurrent');
        const before = { operation: row.operation, operationId: row.operationId, journaledAt: row.createdAt.toISOString(), leaseExpiresAt: row.leaseExpiresAt.toISOString(), attempts: row.attempts };
        const [reference] = await tx.select({ id: courseDocuments.id }).from(courseDocuments).where(eq(courseDocuments.storageKey, row.storageKey)).limit(1);
        if (reference) {
          await tx.delete(t).where(eq(t.id, row.id));
          await recordAuditAs(tx, SYSTEM, { action: 'storage.write_recovered', entityType: 'document_storage_intent', entityId: row.id, before, after: { outcome: 'file_kept_referenced' } });
          return entryOf(row, 'file_kept_referenced');
        }
        let existed: boolean;
        try {
          existed = await deps.storage.exists(row.storageKey);
          // Removal is the authority: it succeeds for a missing file and fails for one it cannot remove.
          await deps.storage.remove(row.storageKey);
        } catch (error) {
          const errorCode = errorCodeOf(error);
          await tx
            .update(t)
            .set({ attempts: sql`${t.attempts} + 1`, lastError: errorCode, lastAttemptAt: sql`now()` })
            .where(eq(t.id, row.id));
          await recordAuditAs(tx, SYSTEM, {
            action: 'storage.write_recovery_failed',
            entityType: 'document_storage_intent',
            entityId: row.id,
            before,
            after: { outcome: 'failed', errorCode, attempts: row.attempts + 1 },
          });
          return entryOf(row, 'failed', { errorCode, attempts: row.attempts + 1, lastError: errorCode });
        }
        const outcome = existed ? 'file_removed' : 'file_already_missing';
        await tx.delete(t).where(eq(t.id, row.id));
        await recordAuditAs(tx, SYSTEM, { action: 'storage.write_recovered', entityType: 'document_storage_intent', entityId: row.id, before, after: { outcome } });
        return entryOf(row, outcome);
      });
      add(report, entry);
      if (entry.action === 'failed') incomplete(report, 'failures');
    } catch {
      // The transaction rolled back: the entry is as it was, and the next run tries again.
      add(report, entryOf(listed, 'failed', { errorCode: 'DATABASE_ERROR' }));
      incomplete(report, 'database_error');
    }
  }
  return finish(report);
}
