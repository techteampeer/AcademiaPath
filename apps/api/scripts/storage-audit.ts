/**
 * AP-040B read-only storage consistency audit: compares the course document records in PostgreSQL with the files in
 * document storage and reports
 * - records whose stored file is missing,
 * - files whose size or SHA-256 differs from the record (corrupt),
 * - stored files no record refers to (orphaned; files newer than the grace period are reported as `recent` instead,
 *   because an upload stores its file just before its database transaction commits),
 * - entries that are not storage files at all (unrecognized) and read errors,
 * and whether the scan is complete.
 *
 * It never deletes, repairs, moves or writes a file, and never changes the database: every query runs in one
 * READ ONLY transaction that is rolled back. Files are hashed as streams, a few at a time, and records are read in
 * batches, so memory stays bounded. The report holds record ids and storage keys only: no file names, contents,
 * people or credentials.
 *
 * LOCAL USE ONLY: it refuses production, Cloud Run, the /mnt/documents bucket mount and any non-local database.
 * Scanning the production bucket needs a reviewed change and explicit approval (see docs/storage-integrity.md).
 *
 *   DATABASE_URL=postgresql://… DOCUMENT_STORAGE_DIR=/abs/dir pnpm storage:audit [-- --json]
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { isStorageKey } from '../src/documents/storage.js';
import { isLocalDatabase } from './seed-dev-users.js';

export const AUDIT_EXIT = { clean: 0, issues: 1, incomplete: 2, refused: 3 } as const;
const CLOUD_MOUNT = '/mnt/documents';

export type AuditIssue =
  | { kind: 'missing_file'; documentId: string; activityId: string; courseId: string; storageKey: string }
  | { kind: 'corrupt_file'; documentId: string; activityId: string; courseId: string; storageKey: string; reason: 'size' | 'sha256' }
  | { kind: 'orphaned_file'; storageKey: string; byteSize: number; modifiedAt: string }
  | { kind: 'unrecognized_entry'; entryType: 'file' | 'directory' | 'other' }
  | { kind: 'read_error'; storageKey: string; documentId: string | null; errorCode: string };

export type AuditReport = {
  tool: 'academiapath-storage-audit';
  reportVersion: 1;
  readOnly: true;
  startedAt: string;
  finishedAt: string;
  status: 'complete' | 'incomplete';
  incompleteReasons: Array<'interrupted' | 'time_limit' | 'storage_directory_unavailable' | 'listing_error' | 'read_errors' | 'database_error'>;
  counts: {
    documents: number;
    documentsChecked: number;
    valid: number;
    missing: number;
    corrupt: number;
    storedEntries: number;
    orphaned: number;
    recentUnreferenced: number;
    unrecognized: number;
    readErrors: number;
  };
  issues: AuditIssue[];
  issuesTruncated: boolean;
};

export type AuditOptions = {
  databaseUrl: string;
  storageDir: string;
  batchSize?: number;
  concurrency?: number;
  /** Unreferenced files modified more recently than this are `recent`, not orphaned (default 60). */
  graceMinutes?: number;
  maxIssues?: number;
  timeLimitMs?: number;
  signal?: AbortSignal;
  now?: () => Date;
};

/** Refuses anything that is not clearly a local, disposable environment. Returns the reason, or null when allowed. */
export function auditRefusal(env: NodeJS.ProcessEnv, storageDir: string): string | null {
  if (env.NODE_ENV === 'production') return 'NODE_ENV is production.';
  if (env.K_SERVICE || env.CLOUD_RUN_JOB) return 'this is a Cloud Run service or job.';
  if (!env.DATABASE_URL) return 'DATABASE_URL is not set.';
  if (!isLocalDatabase(env.DATABASE_URL, env)) return 'DATABASE_URL is not a database on this machine (value not shown).';
  if (!isAbsolute(storageDir)) return 'DOCUMENT_STORAGE_DIR must be an absolute path.';
  const resolved = resolve(storageDir);
  if (resolved === CLOUD_MOUNT || resolved.startsWith(`${CLOUD_MOUNT}/`)) return `${CLOUD_MOUNT} is the production bucket mount.`;
  return null;
}

async function hashFile(path: string, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024, signal }) as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

const codeOf = (error: unknown) => (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN');

/** Runs the audit. Never throws for scan problems: they make the report `incomplete`. */
export async function runStorageAudit(options: AuditOptions): Promise<AuditReport> {
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? 200;
  const concurrency = options.concurrency ?? 4;
  const graceMs = (options.graceMinutes ?? 60) * 60_000;
  const maxIssues = options.maxIssues ?? 1000;
  const started = now();
  const deadline = options.timeLimitMs ? started.getTime() + options.timeLimitMs : null;
  const report: AuditReport = {
    tool: 'academiapath-storage-audit',
    reportVersion: 1,
    readOnly: true,
    startedAt: started.toISOString(),
    finishedAt: started.toISOString(),
    status: 'complete',
    incompleteReasons: [],
    counts: { documents: 0, documentsChecked: 0, valid: 0, missing: 0, corrupt: 0, storedEntries: 0, orphaned: 0, recentUnreferenced: 0, unrecognized: 0, readErrors: 0 },
    issues: [],
    issuesTruncated: false,
  };
  const incomplete = (reason: AuditReport['incompleteReasons'][number]) => {
    if (!report.incompleteReasons.includes(reason)) report.incompleteReasons.push(reason);
  };
  const add = (issue: AuditIssue) => {
    if (report.issues.length < maxIssues) report.issues.push(issue);
    else report.issuesTruncated = true;
  };
  /** True when the scan must stop now (interrupted or out of time). */
  const stopped = () => {
    if (options.signal?.aborted) {
      incomplete('interrupted');
      return true;
    }
    if (deadline !== null && now().getTime() > deadline) {
      incomplete('time_limit');
      return true;
    }
    return false;
  };
  const storageDir = resolve(options.storageDir);

  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    // Read only, for the whole scan: PostgreSQL itself refuses any write in this transaction.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const total = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM course_documents');
    report.counts.documents = total.rows[0]!.n;

    const directory = await stat(storageDir).catch(() => null);
    if (!directory?.isDirectory()) {
      // Without the storage directory every file would look missing: report the scan as incomplete instead.
      incomplete('storage_directory_unavailable');
    } else {
      // 1. Every record: its file exists, has the recorded size and SHA-256.
      let after = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        if (stopped()) break;
        const batch = await client.query<{ id: string; storage_key: string; sha256: string; byte_size: number; activity_id: string; course_id: string }>(
          `SELECT d.id, d.storage_key, d.sha256, d.byte_size, d.activity_id, s.course_id
             FROM course_documents d JOIN activities a ON a.id = d.activity_id JOIN sections s ON s.id = a.section_id
            WHERE d.id > $1 ORDER BY d.id LIMIT $2`,
          [after, batchSize],
        );
        if (!batch.rows.length) break;
        after = batch.rows.at(-1)!.id;
        for (let start = 0; start < batch.rows.length; start += concurrency) {
          if (stopped()) break;
          await Promise.all(
            batch.rows.slice(start, start + concurrency).map(async (row) => {
              const ids = { documentId: row.id, activityId: row.activity_id, courseId: row.course_id, storageKey: row.storage_key };
              if (!isStorageKey(row.storage_key)) {
                report.counts.readErrors += 1;
                add({ kind: 'read_error', storageKey: row.storage_key, documentId: row.id, errorCode: 'INVALID_STORAGE_KEY' });
                return;
              }
              try {
                const file = await hashFile(join(storageDir, row.storage_key), options.signal);
                report.counts.documentsChecked += 1;
                if (file.bytes !== row.byte_size) {
                  report.counts.corrupt += 1;
                  add({ kind: 'corrupt_file', ...ids, reason: 'size' });
                } else if (file.sha256 !== row.sha256) {
                  report.counts.corrupt += 1;
                  add({ kind: 'corrupt_file', ...ids, reason: 'sha256' });
                } else {
                  report.counts.valid += 1;
                }
              } catch (error) {
                const code = codeOf(error);
                if (code === 'ENOENT') {
                  report.counts.documentsChecked += 1;
                  report.counts.missing += 1;
                  add({ kind: 'missing_file', ...ids });
                } else if (code === 'ABORT_ERR') {
                  incomplete('interrupted');
                } else {
                  report.counts.readErrors += 1;
                  add({ kind: 'read_error', storageKey: row.storage_key, documentId: row.id, errorCode: code });
                }
              }
            }),
          );
        }
      }

      // 2. Every stored entry: is a record referring to it? (Listing is streamed; lookups go in batches.)
      if (!stopped()) {
        try {
          const pending: Array<{ key: string; byteSize: number; modifiedAt: Date }> = [];
          const flush = async () => {
            if (!pending.length) return;
            const known = await client.query<{ storage_key: string }>('SELECT storage_key FROM course_documents WHERE storage_key = ANY($1::uuid[])', [pending.map((file) => file.key)]);
            const referenced = new Set(known.rows.map((row) => row.storage_key));
            for (const file of pending) {
              if (referenced.has(file.key)) continue;
              if (started.getTime() - file.modifiedAt.getTime() < graceMs) {
                report.counts.recentUnreferenced += 1;
              } else {
                report.counts.orphaned += 1;
                add({ kind: 'orphaned_file', storageKey: file.key, byteSize: file.byteSize, modifiedAt: file.modifiedAt.toISOString() });
              }
            }
            pending.length = 0;
          };
          const listing = await opendir(storageDir, { bufferSize: 64 });
          for await (const entry of listing) {
            if (stopped()) break;
            report.counts.storedEntries += 1;
            if (!entry.isFile() || !isStorageKey(entry.name)) {
              // Not a storage file (LocalDocumentStorage only ever writes UUID-named files): never called an orphan.
              report.counts.unrecognized += 1;
              add({ kind: 'unrecognized_entry', entryType: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other' });
              continue;
            }
            const info = await stat(join(storageDir, entry.name)).catch(() => null);
            if (!info) continue; // Removed while listing: nothing to report.
            pending.push({ key: entry.name, byteSize: info.size, modifiedAt: info.mtime });
            if (pending.length >= batchSize) await flush();
          }
          if (!stopped()) await flush();
        } catch {
          incomplete('listing_error');
        }
      }
    }
  } catch {
    incomplete('database_error');
  } finally {
    // Never commit: the transaction was read-only, and nothing in it is kept.
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
  if (report.counts.readErrors > 0) incomplete('read_errors');
  report.status = report.incompleteReasons.length ? 'incomplete' : 'complete';
  report.finishedAt = now().toISOString();
  return report;
}

export function exitCodeFor(report: AuditReport): number {
  if (report.status === 'incomplete') return AUDIT_EXIT.incomplete;
  return report.counts.missing + report.counts.corrupt + report.counts.orphaned > 0 ? AUDIT_EXIT.issues : AUDIT_EXIT.clean;
}

function summary(report: AuditReport): string {
  const c = report.counts;
  return [
    `Storage audit (read-only): ${report.status.toUpperCase()}${report.incompleteReasons.length ? ` (${report.incompleteReasons.join(', ')})` : ''}`,
    `  Document records: ${c.documents}; checked: ${c.documentsChecked}; valid: ${c.valid}; missing file: ${c.missing}; corrupt file: ${c.corrupt}`,
    `  Stored entries: ${c.storedEntries}; orphaned: ${c.orphaned}; recent, not yet referenced: ${c.recentUnreferenced}; unrecognized: ${c.unrecognized}`,
    `  Read errors: ${c.readErrors}${report.issuesTruncated ? `; issue list truncated to ${report.issues.length}` : ''}`,
    'Nothing was changed. Re-run with --json for the machine-readable report.',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const storageDir = env.DOCUMENT_STORAGE_DIR?.trim() || resolve(homedir(), '.academiapath', 'documents');
  const refusal = auditRefusal(env, storageDir);
  if (refusal) {
    console.error(`Refusing to run the storage audit: ${refusal} It is for local, disposable environments only.`);
    return AUDIT_EXIT.refused;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const report = await runStorageAudit({ databaseUrl: env.DATABASE_URL!, storageDir, signal: controller.signal });
    console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : summary(report));
    return exitCodeFor(report);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error('Storage audit failed unexpectedly; nothing was changed.');
      process.exitCode = AUDIT_EXIT.incomplete;
    });
}
