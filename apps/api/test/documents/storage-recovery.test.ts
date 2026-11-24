/**
 * AP-040R: crash recovery of document storage writes. Course archive imports journal every file before writing it
 * (document_storage_intents); storage recovery removes the files of entries whose lease ran out and that no document
 * refers to. Crashes are real: the import (or the recovery) runs in a child process killed with SIGKILL at an exact
 * point, so no catch, finally or clean-up code runs. Synthetic archives, local disposable PostgreSQL and storage only.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { seedDevUsers } from '../../scripts/seed-dev-users.js';
import { main as recoverCli, RECOVERY_EXIT } from '../../scripts/storage-recover.js';
import type { Database } from '../../src/db/client.js';
import { programs, terms, users } from '../../src/db/schema/index.js';
import { extractInWorker } from '../../src/documents/extraction.js';
import { noMalwareScanner } from '../../src/documents/scanner.js';
import { LocalDocumentStorage, type DocumentStorage } from '../../src/documents/storage.js';
import { openStorageJournal } from '../../src/documents/storage-journal.js';
import { planStorageRecovery, recoverAbandonedStorageWrites, type RecoveryReport, type RecoveryStorage } from '../../src/documents/storage-recovery.js';
import { mockSummaryProvider } from '../../src/documents/summary.js';
import { ArchiveImportError, importCourseArchive, type ArchiveImportDeps } from '../../src/portability/archive-import.js';
import { exported } from '../helpers/archives.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const CHILD = fileURLToPath(new URL('../helpers/storage-crash-child.ts', import.meta.url));
const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHILD_APP = 'ap-storage-crash-child';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Intent = { id: string; storage_key: string; operation_id: string; attempts: number; last_error: string | null; expired: boolean };

describe('storage crash recovery (AP-040R, PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let storageDir: string;
  let archivePath: string;
  let archive: Buffer;
  let local: LocalDocumentStorage;
  let deps: ArchiveImportDeps;
  const ids = {} as Record<'admin' | 'program' | 'term', string>;
  let codes = 0;
  const nextCode = () => `REC-${(codes += 1)}`;

  const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await database.pool.query<T>(text, params)).rows;
  const files = async () => (await readdir(storageDir).catch(() => [] as string[])).sort();
  const intents = () => q<Intent>('SELECT id, storage_key, operation_id, attempts, last_error, lease_expires_at <= now() AS expired FROM document_storage_intents ORDER BY created_at, id');
  const expireLeases = (where = 'true', params: unknown[] = []) => q(`UPDATE document_storage_intents SET lease_expires_at = now() - interval '1 second' WHERE ${where}`, params);
  const referenced = async () => new Set((await q<{ storage_key: string }>('SELECT storage_key FROM course_documents')).map((row) => row.storage_key));
  const unreferencedFiles = async () => {
    const known = await referenced();
    return (await files()).filter((name) => !known.has(name));
  };
  const coursesWith = async (code: string) => Number((await q<{ n: string }>('SELECT count(*) AS n FROM courses WHERE code = $1', [code]))[0]!.n);
  const recoveryEvents = () =>
    q<{ action: string; entity_id: string; actor_user_id: string | null; metadata: Record<string, any> }>(
      `SELECT action, entity_id, actor_user_id, metadata FROM audit_log WHERE action LIKE 'storage.write_recover%' ORDER BY created_at, id`,
    );
  const recover = (storage: RecoveryStorage = local, db: Database = database.db) => recoverAbandonedStorageWrites({ db, storage });
  const plan = (storage: RecoveryStorage = local) => planStorageRecovery({ db: database.db, storage });
  const actions = (report: RecoveryReport) => report.entries.map((entry) => entry.action).sort();
  const importNow = (code: string, overrides: Partial<ArchiveImportDeps> = {}) =>
    importCourseArchive({ ...deps, ...overrides }, { archive, actor: { userId: ids.admin, ip: null }, programId: ids.program, termId: ids.term, code });
  /** Local storage whose `put` calls `onPut(n, key)` after the n-th file is stored (and before the import verifies it). */
  const hooked = (onPut: (n: number, key: string) => Promise<void>): DocumentStorage => {
    let n = 0;
    return {
      put: async (bytes, key) => {
        const stored = await local.put(bytes, key);
        n += 1;
        await onPut(n, stored);
        return stored;
      },
      read: (key) => local.read(key),
      remove: (key) => local.remove(key),
      exists: (key) => local.exists(key),
    };
  };
  /** Every test ends here: nothing journaled, no stored file without a document. */
  const assertClean = async (label: string) => {
    assert.deepEqual(await intents(), [], `${label}: no journal entry is left`);
    assert.deepEqual(await unreferencedFiles(), [], `${label}: no unreferenced file is left`);
  };
  /** Abandoned writes as a dead writer leaves them: journaled, stored, lease run out. */
  const abandonedWrites = async (count: number) => {
    const journal = openStorageJournal(database.db, 'archive_import', ids.admin);
    const keys: string[] = [];
    for (let i = 0; i < count; i += 1) keys.push(await local.put(Buffer.from(`synthetic abandoned file ${i}`), await journal.reserve()));
    await expireLeases('operation_id = $1', [journal.operationId]);
    return keys;
  };

  /** The import or recovery in a child process; `paused` resolves when it stops at CRASH_PAUSE, `kill` sends SIGKILL. */
  /** Waits until PostgreSQL has noticed that the killed child is gone (its open transaction holds row locks until then). */
  const childGone = async () => {
    for (let i = 0; i < 200 && Number((await q<{ n: string }>('SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = $1', [CHILD_APP]))[0]!.n) > 0; i += 1) await sleep(50);
  };
  const child = (mode: 'import' | 'recover', env: Record<string, string>) => {
    const url = new URL(database.url);
    url.searchParams.set('application_name', CHILD_APP);
    const proc = spawn(process.execPath, ['--import', 'tsx', CHILD], {
      cwd: API_ROOT,
      env: {
        ...process.env,
        CRASH_MODE: mode,
        CRASH_DATABASE_URL: url.toString(),
        CRASH_STORAGE_DIR: storageDir,
        CRASH_ARCHIVE: archivePath,
        CRASH_ACTOR: ids.admin,
        CRASH_PROGRAM: ids.program,
        CRASH_TERM: ids.term,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
    const line = (prefix: string) =>
      new Promise<string>((resolve, reject) => {
        const check = () => {
          const found = out.split('\n').find((text) => text.startsWith(prefix));
          if (found !== undefined) resolve(found.slice(prefix.length).trim());
        };
        proc.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8');
          check();
        });
        proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
        void exited.then(() => {
          check();
          reject(new Error(`child exited before "${prefix}": ${out.slice(-500)} ${err.slice(-500)}`));
        });
      });
    const paused = line('PAUSED ');
    const result = line('RESULT ').then((json) => JSON.parse(json) as Record<string, unknown>);
    paused.catch(() => undefined);
    result.catch(() => undefined);
    return {
      paused,
      result,
      async kill(options: { waitForDatabase?: boolean } = {}) {
        proc.kill('SIGKILL');
        await exited;
        if (options.waitForDatabase !== false) await childGone();
      },
    };
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-storage-recovery-'));
    storageDir = join(root, 'store');
    archivePath = join(root, 'course.zip');
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const [admin] = await database.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.systemRole, 'administrator'), eq(users.isActive, true)));
    ids.admin = admin!.id;
    ids.program = (await database.db.insert(programs).values({ code: 'REC', name: 'Recovery tests' }).returning({ id: programs.id }))[0]!.id;
    ids.term = (await database.db.insert(terms).values({ code: '2026-2', name: '2026-II', academicYear: 2026, startsOn: '2026-08-17', endsOn: '2026-12-11' }).returning({ id: terms.id }))[0]!.id;
    archive = await exported();
    await writeFile(archivePath, archive);
    local = new LocalDocumentStorage(storageDir);
    deps = { db: database.db, storage: local, scanner: noMalwareScanner, provider: mockSummaryProvider, extract: (bytes, format) => extractInWorker(bytes, format, 20_000) };
  });

  after(async () => {
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('a successful import leaves no pending work: its journal entries are settled in the same commit', async () => {
    const code = nextCode();
    const result = await importNow(code);
    assert.equal(await coursesWith(code), 1);
    const known = await referenced();
    assert.equal((await files()).length, 3);
    for (const name of await files()) assert.ok(known.has(name), 'every stored file belongs to a document');
    const dryRun = await plan();
    assert.equal(dryRun.counts.journaled, 0);
    assert.equal(dryRun.status, 'complete');
    assert.equal((await recover()).counts.journaled, 0);
    assert.ok(result.course.id);
    await assertClean('success');
  });

  it('a failed transaction after every file was written: files removed and entries released; if removal fails too, recovery finishes the job', async () => {
    const failingDb = Object.create(database.db, { transaction: { value: async () => Promise.reject(new Error('simulated database failure')) } }) as Database;
    const before = await files();
    await assert.rejects(importNow(nextCode(), { db: failingDb }), (error: unknown) => error instanceof ArchiveImportError && error.problem === 'IMPORT_FAILED' && error.orphanedFiles === 0);
    assert.deepEqual(await files(), before, 'its own clean-up removed every file');
    await assertClean('rollback');

    const stuck: DocumentStorage = { ...hooked(async () => undefined), remove: async () => Promise.reject(Object.assign(new Error('EIO /srv/storage'), { code: 'EIO' })) };
    const code = nextCode();
    await assert.rejects(importNow(code, { db: failingDb, storage: stuck }), (error: unknown) => error instanceof ArchiveImportError && error.orphanedFiles === 3);
    const left = await unreferencedFiles();
    assert.equal(left.length, 3, 'three files could not be removed');
    assert.deepEqual((await intents()).map((row) => row.storage_key).sort(), left, 'and all three stay journaled');
    assert.deepEqual(actions(await recover()), ['wait_active_lease', 'wait_active_lease', 'wait_active_lease'], 'not before their lease runs out');
    await expireLeases();
    assert.deepEqual(actions(await recover()), ['file_removed', 'file_removed', 'file_removed']);
    assert.equal(await coursesWith(code), 0);
    await assertClean('failed clean-up');
  });

  it('process killed after the first file: the file is journaled, left alone while its lease runs, then recovered', async () => {
    const code = nextCode();
    const events = (await recoveryEvents()).length;
    const run = child('import', { CRASH_PAUSE: 'after-put:1', CRASH_CODE: code });
    assert.equal(await run.paused, 'after-put:1');
    await run.kill();
    const left = await unreferencedFiles();
    assert.equal(left.length, 1);
    const journal = await intents();
    assert.deepEqual(
      journal.map((row) => [row.storage_key, row.expired]),
      [[left[0], false]],
      'journaled before it was written, with a running lease',
    );
    // A recent (possibly slow) import is never cleaned.
    assert.deepEqual(actions(await plan()), ['wait_active_lease']);
    assert.deepEqual(actions(await recover()), ['wait_active_lease']);
    assert.deepEqual(await unreferencedFiles(), left);
    // Once the lease has run out: the dry run proposes, and changes nothing.
    await expireLeases();
    const dryRun = await plan();
    assert.deepEqual(actions(dryRun), ['remove_file']);
    assert.equal(dryRun.entries[0]!.storageKey, left[0]);
    assert.deepEqual(await unreferencedFiles(), left, 'a dry run removes nothing');
    assert.equal((await intents()).length, 1, 'a dry run forgets nothing');
    const applied = await recover();
    assert.deepEqual(actions(applied), ['file_removed']);
    assert.equal(applied.status, 'complete');
    const recorded = (await recoveryEvents()).slice(events);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.action, 'storage.write_recovered');
    assert.equal(recorded[0]!.entity_id, journal[0]!.id);
    assert.equal(recorded[0]!.actor_user_id, null);
    assert.equal(recorded[0]!.metadata.after.outcome, 'file_removed');
    assert.equal(recorded[0]!.metadata.before.operationId, journal[0]!.operation_id);
    assert.ok(!JSON.stringify(recorded[0]!.metadata).includes(left[0]!), 'the audit event holds no storage key');
    assert.equal(await coursesWith(code), 0);
    await assertClean('crash after the first file');
  });

  it('process killed after every file was written, just before the transaction: all of them are recovered', async () => {
    const code = nextCode();
    const run = child('import', { CRASH_PAUSE: 'after-put:3', CRASH_CODE: code });
    assert.equal(await run.paused, 'after-put:3');
    await run.kill();
    assert.equal((await unreferencedFiles()).length, 3);
    assert.equal((await intents()).length, 3);
    await expireLeases();
    assert.deepEqual(actions(await recover()), ['file_removed', 'file_removed', 'file_removed']);
    assert.equal(await coursesWith(code), 0);
    await assertClean('crash after several files');
  });

  it('process killed between journaling a key and writing its file: the missing file is fine', async () => {
    const run = child('import', { CRASH_PAUSE: 'before-put:2', CRASH_CODE: nextCode() });
    await run.paused;
    await run.kill();
    assert.equal((await unreferencedFiles()).length, 1);
    assert.equal((await intents()).length, 2, 'the second key was journaled, its file never written');
    await expireLeases();
    assert.deepEqual(actions(await plan()), ['forget_entry_file_missing', 'remove_file']);
    assert.deepEqual(actions(await recover()), ['file_already_missing', 'file_removed']);
    await assertClean('crash before a write');
  });

  it('process killed during the import transaction: it rolls back, and its locked entries are never taken meanwhile', async () => {
    const code = nextCode();
    // Hold the import inside its transaction (after it settled its journal entries) by locking the courses table.
    const locker = await database.pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE courses IN EXCLUSIVE MODE');
      const run = child('import', { CRASH_CODE: code, CRASH_LEASE_SECONDS: '1' });
      for (let i = 0; i < 1200; i += 1) {
        const waiting = await q<{ n: string }>(`SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [CHILD_APP]);
        if (Number(waiting[0]!.n) > 0) break;
        await sleep(50);
      }
      for (let i = 0; i < 100 && (await intents()).some((row) => !row.expired); i += 1) await sleep(50);
      const journal = await intents();
      assert.equal(journal.length, 3, 'its uncommitted settlement is not visible yet');
      assert.ok(
        journal.every((row) => row.expired),
        'and every lease has run out',
      );
      // The committing writer holds the entries: a recovery now skips every one of them and removes nothing.
      assert.deepEqual(actions(await recover()), ['skipped_concurrent', 'skipped_concurrent', 'skipped_concurrent']);
      assert.equal((await unreferencedFiles()).length, 3);
      // Its server process is still waiting for the lock: it notices the dead client only once the lock is released.
      await run.kill({ waitForDatabase: false });
      await locker.query('ROLLBACK');
    } finally {
      locker.release();
    }
    // The dead writer's transaction rolled back: no course, and its entries are back for recovery.
    await childGone();
    assert.equal(await coursesWith(code), 0);
    assert.equal((await intents()).length, 3);
    assert.deepEqual(actions(await recover()), ['file_removed', 'file_removed', 'file_removed']);
    await assertClean('crash in the transaction');
  });

  it('process killed during its own clean-up (after a handled failure): recovery removes what the clean-up left', async () => {
    const run = child('import', { CRASH_FAIL_PUT_AT: '3', CRASH_PAUSE: 'after-remove:1', CRASH_CODE: nextCode() });
    await run.paused;
    await run.kill();
    assert.equal((await unreferencedFiles()).length, 1, 'the clean-up removed the first file, not the second');
    assert.equal((await intents()).length, 3, 'no entry was forgotten yet');
    await expireLeases();
    assert.deepEqual(actions(await recover()), ['file_already_missing', 'file_already_missing', 'file_removed']);
    await assertClean('interrupted clean-up');
  });

  it('recovery is safe to repeat: a second and a third run change nothing', async () => {
    await abandonedWrites(2);
    assert.deepEqual(actions(await recover()), ['file_removed', 'file_removed']);
    const events = (await recoveryEvents()).length;
    const filesAfter = await files();
    for (const attempt of [1, 2]) {
      const again = await recover();
      assert.equal(again.counts.journaled, 0, `run ${attempt + 1} finds nothing`);
      assert.equal(again.status, 'complete');
    }
    assert.equal((await recoveryEvents()).length, events, 'no further audit events');
    assert.deepEqual(await files(), filesAfter);
    await assertClean('repeated recovery');
  });

  it('an active (slow) import is never cleaned: its lease is renewed with every file, and it completes', async () => {
    const leases: number[] = [];
    const code = nextCode();
    const storage = hooked(async () => {
      const [first] = await q<{ lease: Date }>('SELECT lease_expires_at AS lease FROM document_storage_intents ORDER BY created_at, id LIMIT 1');
      leases.push(first!.lease.getTime());
      // A recovery while the import is between files touches nothing of it.
      const report = await recover();
      assert.ok(report.entries.length > 0);
      assert.ok(report.entries.every((entry) => entry.action === 'wait_active_lease'));
      await sleep(30);
    });
    const result = await importNow(code, { storage });
    assert.equal(leases.length, 3);
    assert.ok(leases[1]! > leases[0]! && leases[2]! > leases[1]!, 'the first file’s lease was renewed as later files were journaled');
    assert.equal(await coursesWith(code), 1);
    const documents = await q<{ n: string }>('SELECT count(*) AS n FROM course_documents d JOIN activities a ON a.id = d.activity_id JOIN sections s ON s.id = a.section_id WHERE s.course_id = $1', [
      result.course.id,
    ]);
    assert.equal(Number(documents[0]!.n), 3);
    await assertClean('active import');
  });

  it('a lease that ran out mid-import: recovery reclaims the file, and the import then aborts instead of committing', async () => {
    const code = nextCode();
    const storage = hooked(async (n) => {
      if (n !== 3) return;
      // Every file is stored and journaled; the first one's lease runs out and recovery takes it.
      const [first] = await intents();
      await expireLeases('id = $1', [first!.id]);
      assert.deepEqual(actions(await recover()), ['file_removed', 'wait_active_lease', 'wait_active_lease']);
    });
    await assert.rejects(importNow(code, { storage }), (error: unknown) => error instanceof ArchiveImportError && error.problem === 'STORAGE_FAILED' && error.orphanedFiles === 0);
    assert.equal(await coursesWith(code), 0, 'no course refers to a reclaimed file');
    await assertClean('reclaimed mid-import');
  });

  it('a file a document refers to is never deleted, even with an abandoned entry for it', async () => {
    const code = nextCode();
    await importNow(code);
    const [document] = await q<{ storage_key: string; byte_size: number }>(
      'SELECT d.storage_key, d.byte_size FROM course_documents d JOIN activities a ON a.id = d.activity_id JOIN sections s ON s.id = a.section_id JOIN courses c ON c.id = s.course_id WHERE c.code = $1 LIMIT 1',
      [code],
    );
    const bytes = await local.read(document!.storage_key);
    await q(`INSERT INTO document_storage_intents (storage_key, operation, operation_id, lease_expires_at) VALUES ($1, 'archive_import', gen_random_uuid(), now() - interval '1 hour')`, [
      document!.storage_key,
    ]);
    assert.deepEqual(actions(await plan()), ['forget_entry_file_referenced']);
    assert.deepEqual(actions(await recover()), ['file_kept_referenced']);
    assert.deepEqual(await local.read(document!.storage_key), bytes, 'the document file is intact');
    await assertClean('referenced file');
  });

  it('a failed removal keeps the entry, counts the attempt with an error code only, and is retried', async () => {
    const keys = await abandonedWrites(2);
    const events = (await recoveryEvents()).length;
    const failing: RecoveryStorage = { exists: (key) => local.exists(key), remove: async () => Promise.reject(Object.assign(new Error(`EIO: i/o error, unlink '${storageDir}/x'`), { code: 'EIO' })) };
    for (const attempt of [1, 2]) {
      const report = await recover(failing);
      assert.deepEqual(actions(report), ['failed', 'failed']);
      assert.equal(report.status, 'incomplete');
      assert.deepEqual(report.incompleteReasons, ['failures']);
      assert.ok(report.entries.every((entry) => entry.errorCode === 'EIO' && entry.attempts === attempt));
      const journal = await intents();
      assert.deepEqual(
        journal.map((row) => [row.attempts, row.last_error]),
        [
          [attempt, 'EIO'],
          [attempt, 'EIO'],
        ],
      );
    }
    assert.deepEqual((await files()).filter((name) => keys.includes(name)).sort(), [...keys].sort(), 'the files are still there');
    const failures = (await recoveryEvents()).slice(events);
    assert.equal(failures.length, 4);
    for (const event of failures) {
      assert.equal(event.action, 'storage.write_recovery_failed');
      assert.equal(event.metadata.after.errorCode, 'EIO');
      const text = JSON.stringify(event.metadata);
      assert.ok(!text.includes(storageDir) && !keys.some((key) => text.includes(key)), 'no path or storage key in the audit event');
    }
    // An error without a plain code is stored as UNKNOWN, never as its message.
    const noCode: RecoveryStorage = { exists: (key) => local.exists(key), remove: async () => Promise.reject(new Error(`cannot remove ${storageDir}`)) };
    assert.ok((await recover(noCode)).entries.every((entry) => entry.errorCode === 'UNKNOWN'));
    assert.ok((await intents()).every((row) => row.last_error === 'UNKNOWN' && row.attempts === 3));
    assert.deepEqual(actions(await recover()), ['file_removed', 'file_removed'], 'retried once storage works again');
    await assertClean('failed removal');
  });

  it('process killed during recovery: before the removal nothing changed; after it, the next run finds the file already gone', async () => {
    await abandonedWrites(2);
    const early = child('recover', { CRASH_PAUSE: 'before-remove:1' });
    await early.paused;
    // While the dead-to-be recovery holds the first entry, a concurrent recovery skips it and takes the second.
    assert.deepEqual(actions(await recover()), ['file_removed', 'skipped_concurrent']);
    await early.kill();
    assert.equal((await unreferencedFiles()).length, 1, 'the killed recovery removed nothing');
    assert.equal((await intents()).length, 1);

    const late = child('recover', { CRASH_PAUSE: 'after-remove:1' });
    await late.paused;
    await late.kill();
    assert.deepEqual(await unreferencedFiles(), [], 'the file was removed before the crash');
    const [entry] = await intents();
    assert.equal(entry!.attempts, 0, 'but the entry and its transaction rolled back');
    assert.deepEqual(actions(await recover()), ['file_already_missing']);
    await assertClean('crash during recovery');
  });

  it('concurrent recoveries handle every entry exactly once', async () => {
    const keys = await abandonedWrites(6);
    const events = (await recoveryEvents()).length;
    const slow: RecoveryStorage = { exists: (key) => local.exists(key), remove: async (key) => (await sleep(40), local.remove(key)) };
    const reports = await Promise.all([recover(slow), recover(slow), recover(slow)]);
    const handled = reports.flatMap((report) => report.entries.filter((entry) => entry.action !== 'skipped_concurrent'));
    assert.deepEqual(handled.map((entry) => entry.storageKey).sort(), [...keys].sort(), 'each entry handled by exactly one recovery');
    assert.ok(handled.every((entry) => entry.action === 'file_removed'));
    assert.ok(reports.every((report) => report.status === 'complete'));
    assert.equal((await recoveryEvents()).length - events, 6, 'one audit event per entry');
    await assertClean('concurrent recovery');
  });

  it('the CLI is local-only, dry-run by default, refuses a missing storage directory, and applies only with --apply', async () => {
    const env = { DATABASE_URL: database.url, DOCUMENT_STORAGE_DIR: storageDir } as NodeJS.ProcessEnv;
    const quiet = async (run: () => Promise<number>) => {
      const { log, error } = console;
      console.log = () => undefined;
      console.error = () => undefined;
      try {
        return await run();
      } finally {
        console.log = log;
        console.error = error;
      }
    };
    const keys = await abandonedWrites(1);
    for (const refused of [
      { ...env, NODE_ENV: 'production' },
      { ...env, K_SERVICE: 'academiapath-api' },
      { ...env, DOCUMENT_STORAGE_DIR: '/mnt/documents' },
      { ...env, DATABASE_URL: 'postgresql://user@db.example.com:5432/app' },
    ]) {
      assert.equal(await quiet(() => recoverCli(['--apply'], refused)), RECOVERY_EXIT.refused);
    }
    assert.equal(await quiet(() => recoverCli(['--apply'], { ...env, DOCUMENT_STORAGE_DIR: join(root, 'not-mounted') })), RECOVERY_EXIT.failed);
    assert.equal(await quiet(() => recoverCli([], env)), RECOVERY_EXIT.pending, 'a dry run reports pending work');
    assert.ok((await files()).includes(keys[0]!), 'and changes nothing');
    assert.equal(await quiet(() => recoverCli(['--apply', '--json'], env)), RECOVERY_EXIT.clean);
    assert.equal(await quiet(() => recoverCli([], env)), RECOVERY_EXIT.clean);
    await assertClean('CLI');
  });

  it('the dry run is read-only', async () => {
    await abandonedWrites(1);
    const snapshot = JSON.stringify(await q('SELECT * FROM document_storage_intents ORDER BY id'));
    const before = await files();
    const dryRun = await plan();
    assert.equal(dryRun.mode, 'dry_run');
    assert.equal(JSON.stringify(await q('SELECT * FROM document_storage_intents ORDER BY id')), snapshot);
    assert.deepEqual(await files(), before);
    await recover();
    await assertClean('dry run');
  });

  it('AP-OPS-01: a removal the store does not reflect keeps the entry, flagged for review', async () => {
    const keys = await abandonedWrites(1);
    const events = (await recoveryEvents()).length;
    // A store that reports the removal as done but still shows the file (a stale or inconsistent view).
    const unreflected: RecoveryStorage = { exists: (key) => local.exists(key), remove: async () => undefined };
    const report = await recover(unreflected);
    assert.deepEqual(actions(report), ['failed']);
    assert.equal(report.entries[0]!.errorCode, 'STILL_PRESENT');
    assert.deepEqual(report.incompleteReasons, ['failures']);
    assert.ok((await files()).includes(keys[0]!), 'the file is still there');
    assert.deepEqual(
      (await intents()).map((row) => [row.storage_key, row.attempts, row.last_error]),
      [[keys[0], 1, 'STILL_PRESENT']],
      'and still journaled, never forgotten',
    );
    const [event] = (await recoveryEvents()).slice(events);
    assert.deepEqual([event!.action, event!.metadata.after.errorCode], ['storage.write_recovery_failed', 'STILL_PRESENT']);
    assert.deepEqual(actions(await recover()), ['file_removed'], 'a store that reflects the removal finishes it');
    await assertClean('unreflected removal');
  });

  it('AP-OPS-01: a store that shows none of the documents’ files is not trusted: nothing is planned, removed or forgotten', async () => {
    assert.ok(Number((await q<{ n: string }>('SELECT count(*) AS n FROM course_documents'))[0]!.n) > 0, 'documents refer to stored files');
    const keys = await abandonedWrites(2);
    const events = (await recoveryEvents()).length;
    const journal = await intents();
    // An empty directory, as an unmounted bucket looks; or a store that answers "missing" for everything.
    for (const elsewhere of [new LocalDocumentStorage(join(root, 'not-the-bucket')), { exists: async () => false, remove: async () => undefined } satisfies RecoveryStorage]) {
      for (const report of [await plan(elsewhere), await recover(elsewhere)]) {
        assert.equal(report.status, 'incomplete');
        assert.deepEqual(report.incompleteReasons, ['storage_unverified']);
        assert.deepEqual(report.entries, [], `${report.mode}: nothing planned or done`);
      }
    }
    assert.deepEqual(await intents(), journal, 'every entry kept as it was');
    assert.deepEqual((await files()).filter((name) => keys.includes(name)).sort(), [...keys].sort(), 'every file kept');
    assert.equal((await recoveryEvents()).length, events, 'no audit event');
    assert.deepEqual(actions(await recover()), ['file_removed', 'file_removed'], 'the real store is trusted');
    await assertClean('unverified store');
  });
});
