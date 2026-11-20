/**
 * AP-040R: one course archive import, or one storage recovery, run in a child process so that the test can kill it
 * with SIGKILL at an exact point (no try/catch, no `finally`, no clean-up runs, as when a container is stopped).
 *
 * Environment (set by test/documents/storage-recovery.test.ts):
 *   CRASH_MODE           import | recover
 *   CRASH_PAUSE          where to stop and wait to be killed, `<point>:<n>` (the n-th call), or empty for no pause:
 *                        before-put / after-put (import), before-remove / after-remove (either mode)
 *   CRASH_FAIL_PUT_AT    import: make the n-th file write fail (so the import's own clean-up runs)
 *   CRASH_DATABASE_URL, CRASH_STORAGE_DIR, CRASH_LEASE_SECONDS
 *   CRASH_ARCHIVE, CRASH_ACTOR, CRASH_PROGRAM, CRASH_TERM, CRASH_CODE   import input
 *
 * Writes `PAUSED <point>:<n>` when it stops, `RESULT <json>` when it finishes.
 */
import { readFile } from 'node:fs/promises';
import { createDatabase } from '../../src/db/client.js';
import { extractInWorker } from '../../src/documents/extraction.js';
import { noMalwareScanner } from '../../src/documents/scanner.js';
import { LocalDocumentStorage } from '../../src/documents/storage.js';
import { recoverAbandonedStorageWrites } from '../../src/documents/storage-recovery.js';
import { mockSummaryProvider } from '../../src/documents/summary.js';
import { ArchiveImportError, importCourseArchive } from '../../src/portability/archive-import.js';

const env = process.env;
const pause = env.CRASH_PAUSE ?? '';
const counts = new Map<string, number>();

/** Counts calls at `point`; at the configured one, reports it and waits forever for the SIGKILL. */
async function checkpoint(point: string) {
  const n = (counts.get(point) ?? 0) + 1;
  counts.set(point, n);
  if (pause !== `${point}:${n}`) return;
  process.stdout.write(`PAUSED ${pause}\n`);
  setInterval(() => undefined, 60_000);
  await new Promise<never>(() => undefined);
}

const { db } = createDatabase(env.CRASH_DATABASE_URL);
const local = new LocalDocumentStorage(env.CRASH_STORAGE_DIR!);
let puts = 0;
const storage = {
  put: async (bytes: Uint8Array, key?: string) => {
    puts += 1;
    await checkpoint('before-put');
    if (puts === Number(env.CRASH_FAIL_PUT_AT)) throw Object.assign(new Error('simulated write failure'), { code: 'ENOSPC' });
    const stored = await local.put(bytes, key);
    await checkpoint('after-put');
    return stored;
  },
  read: (key: string) => local.read(key),
  exists: (key: string) => local.exists(key),
  remove: async (key: string) => {
    await checkpoint('before-remove');
    await local.remove(key);
    await checkpoint('after-remove');
  },
};

async function run(): Promise<unknown> {
  if (env.CRASH_MODE === 'recover') return recoverAbandonedStorageWrites({ db, storage });
  try {
    const result = await importCourseArchive(
      {
        db,
        storage,
        scanner: noMalwareScanner,
        provider: mockSummaryProvider,
        extract: (bytes, format) => extractInWorker(bytes, format, 20_000),
        journalLeaseSeconds: Number(env.CRASH_LEASE_SECONDS) || undefined,
      },
      { archive: await readFile(env.CRASH_ARCHIVE!), actor: { userId: env.CRASH_ACTOR!, ip: null }, programId: env.CRASH_PROGRAM!, termId: env.CRASH_TERM!, code: env.CRASH_CODE! },
    );
    return { courseId: result.course.id };
  } catch (error) {
    if (error instanceof ArchiveImportError) return { error: error.problem, orphanedFiles: error.orphanedFiles };
    throw error;
  }
}

run().then(
  (result) => {
    process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
    process.exit(0);
  },
  () => {
    process.stdout.write('RESULT {"error":"UNEXPECTED"}\n');
    process.exit(1);
  },
);
