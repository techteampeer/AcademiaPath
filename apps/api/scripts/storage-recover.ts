/**
 * AP-040R storage recovery for files abandoned by interrupted course archive imports and document uploads (see
 * src/documents/storage-recovery.ts and docs/storage-integrity.md).
 *
 * Dry run by default: it lists the write-ahead journal and what recovery would do, and changes nothing. With
 * `--apply` it removes the files of entries whose lease has run out and that no document refers to, one entry per
 * transaction, with an audit event for each. Entries whose lease is still running are never touched. Files that were
 * never journaled (written before the journal existed) are not this tool's business: `pnpm storage:audit` reports them.
 *
 * LOCAL USE ONLY, like the storage audit: it refuses production, Cloud Run, the /mnt/documents bucket mount and any
 * non-local database. Nothing runs it automatically; recovering production storage needs a reviewed change and explicit
 * approval.
 *
 *   DATABASE_URL=postgresql://… DOCUMENT_STORAGE_DIR=/abs/dir pnpm storage:recover [-- --apply] [-- --json]
 */
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabase } from '../src/db/client.js';
import { LocalDocumentStorage } from '../src/documents/storage.js';
import { planStorageRecovery, recoverAbandonedStorageWrites, type RecoveryReport } from '../src/documents/storage-recovery.js';
import { auditRefusal } from './storage-audit.js';

/** 0: nothing left to do; 1: a dry run found entries to recover; 2: failures or an incomplete run; 3: refused. */
export const RECOVERY_EXIT = { clean: 0, pending: 1, failed: 2, refused: 3 } as const;

export function exitCodeFor(report: RecoveryReport): number {
  if (report.status === 'incomplete') return RECOVERY_EXIT.failed;
  if (report.mode === 'dry_run' && report.counts.abandoned > 0) return RECOVERY_EXIT.pending;
  return RECOVERY_EXIT.clean;
}

function summary(report: RecoveryReport): string {
  const c = report.counts;
  const actions = report.entries.length ? Object.entries(c).filter(([name]) => !['journaled', 'active', 'abandoned'].includes(name)) : [];
  return [
    `Storage recovery (${report.mode === 'dry_run' ? 'dry run: nothing was changed' : 'applied'}): ${report.status.toUpperCase()}${report.incompleteReasons.length ? ` (${report.incompleteReasons.join(', ')})` : ''}`,
    `  Journal entries: ${c.journaled}; lease running (never touched): ${c.active}; abandoned: ${c.abandoned}`,
    ...actions.map(([name, count]) => `  ${name}: ${count}`),
    report.mode === 'dry_run' && c.abandoned > 0 ? 'Re-run with --apply to recover the abandoned entries.' : '',
    'Re-run with --json for the machine-readable report.',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const storageDir = env.DOCUMENT_STORAGE_DIR?.trim() || resolve(homedir(), '.academiapath', 'documents');
  const refusal = auditRefusal(env, storageDir);
  if (refusal) {
    console.error(`Refusing to run storage recovery: ${refusal} It is for local, disposable environments only.`);
    return RECOVERY_EXIT.refused;
  }
  // A missing directory (an unmounted bucket, a mistyped path) would make every file look already removed, and recovery
  // would forget journal entries whose files still exist: refuse instead.
  if (!(await stat(storageDir).catch(() => null))?.isDirectory()) {
    console.error('Refusing to run storage recovery: DOCUMENT_STORAGE_DIR is not an existing directory. Nothing was changed.');
    return RECOVERY_EXIT.failed;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const { db, pool } = createDatabase(env.DATABASE_URL);
  try {
    const deps = { db, storage: new LocalDocumentStorage(storageDir, { createRoot: false }) };
    const report = argv.includes('--apply') ? await recoverAbandonedStorageWrites(deps, { signal: controller.signal }) : await planStorageRecovery(deps, { signal: controller.signal });
    console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : summary(report));
    return exitCodeFor(report);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error('Storage recovery failed unexpectedly; every entry it did not finish is unchanged and will be retried.');
      process.exitCode = RECOVERY_EXIT.failed;
    });
}
