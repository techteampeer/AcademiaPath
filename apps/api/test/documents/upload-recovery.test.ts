/**
 * AP-040R2: crash recovery of ordinary document uploads, through the real upload route, with the AP-040R write-ahead
 * journal. Crashes are real: the upload runs in a child process (test/helpers/storage-crash-child.ts) killed with
 * SIGKILL at an exact point, so no catch, finally or clean-up code runs. Handled failures (storage, database, clean-up)
 * run in-process with faulty storage or database wrappers. Synthetic documents, disposable local PostgreSQL and storage.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { LightMyRequestResponse } from 'fastify';
import { seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Database } from '../../src/db/client.js';
import { LocalDocumentStorage, type DocumentStorage } from '../../src/documents/storage.js';
import { planStorageRecovery, recoverAbandonedStorageWrites, type RecoveryReport } from '../../src/documents/storage-recovery.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { makePdf, multipartBody } from '../helpers/documents.js';

const PASSWORD = randomBytes(18).toString('base64url');
const COOKIE = 'ap_session';
const ORIGIN = 'http://localhost:3000';
const CHILD = fileURLToPath(new URL('../helpers/storage-crash-child.ts', import.meta.url));
const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHILD_APP = 'ap-upload-crash-child';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type App = Awaited<ReturnType<typeof buildApp>>;
type Intent = { id: string; storage_key: string; operation: string; attempts: number; expired: boolean };

describe('document upload crash recovery (AP-040R2, PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let storageDir: string;
  let filePath: string;
  let local: LocalDocumentStorage;
  let session: { token: string; csrf: string };
  const ids = {} as Record<'course' | 'section', string>;
  const logs: string[] = [];
  const apps: App[] = [];
  const file = makePdf([['Synthetic upload', 'A document for the crash recovery tests.']]);

  const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await database.pool.query<T>(text, params)).rows;
  const count = async (text: string, params: unknown[] = []) => Number((await q<{ n: string }>(text, params))[0]!.n);
  const files = async () => (await readdir(storageDir).catch(() => [] as string[])).sort();
  const intents = () => q<Intent>('SELECT id, storage_key, operation, attempts, lease_expires_at <= now() AS expired FROM document_storage_intents ORDER BY created_at, id');
  const expireLeases = () => q(`UPDATE document_storage_intents SET lease_expires_at = now() - interval '1 second'`);
  const unreferencedFiles = async () => {
    const known = new Set((await q<{ storage_key: string }>('SELECT storage_key FROM course_documents')).map((row) => row.storage_key));
    return (await files()).filter((name) => !known.has(name));
  };
  const documents = () => count('SELECT count(*) AS n FROM course_documents');
  const uploadAudits = () => count(`SELECT count(*) AS n FROM audit_log WHERE action = 'document.uploaded'`);
  const recover = () => recoverAbandonedStorageWrites({ db: database.db, storage: local });
  const plan = () => planStorageRecovery({ db: database.db, storage: local });
  const actions = (report: RecoveryReport) => report.entries.map((entry) => entry.action).sort();
  /** Every test ends here: nothing journaled, no stored file without a document. */
  const assertClean = async (label: string) => {
    assert.deepEqual(await intents(), [], `${label}: no journal entry is left`);
    assert.deepEqual(await unreferencedFiles(), [], `${label}: no unreferenced file is left`);
  };

  const appWith = async (options: { storage?: DocumentStorage; db?: Database } = {}) => {
    const instance = buildApp({
      config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir, DOCUMENT_MAX_UPLOAD_MB: '5' }),
      database: options.db ?? database.db,
      documents: { storage: options.storage ?? local },
      logger: { level: 'info', stream: { write: (line: string) => void logs.push(line) } },
    });
    await instance.ready();
    apps.push(instance);
    return instance;
  };
  const upload = (app: App, data = file) => {
    const { payload, contentType } = multipartBody([{ name: 'file', filename: 'upload.pdf', data }]);
    return app.inject({
      method: 'POST',
      url: `/api/v1/courses/${ids.course}/sections/${ids.section}/documents`,
      payload,
      cookies: { [COOKIE]: session.token },
      headers: { 'content-type': contentType, 'x-csrf-token': session.csrf, origin: ORIGIN },
    });
  };
  const expectStatus = (res: LightMyRequestResponse, status: number, code?: string) => {
    assert.equal(res.statusCode, status, res.body);
    if (code) assert.equal(res.json().code, code);
    return res.json();
  };
  /** Local storage with hooks after a write and around removals. */
  const wrapped = (hooks: { afterPut?: (key: string) => Promise<void>; put?: DocumentStorage['put']; remove?: DocumentStorage['remove'] }): DocumentStorage => ({
    put:
      hooks.put ??
      (async (bytes, key) => {
        const stored = await local.put(bytes, key);
        await hooks.afterPut?.(stored);
        return stored;
      }),
    read: (key) => local.read(key),
    remove: hooks.remove ?? ((key) => local.remove(key)),
    exists: (key) => local.exists(key),
  });
  const failingTransactions = () => Object.create(database.db, { transaction: { value: async () => Promise.reject(new Error('simulated database failure')) } }) as Database;

  const childGone = async () => {
    for (let i = 0; i < 200 && (await count('SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = $1', [CHILD_APP])) > 0; i += 1) await sleep(50);
  };
  /** One upload through the real route in a child process; `paused` resolves at CRASH_PAUSE, `kill` sends SIGKILL. */
  const child = (env: Record<string, string>) => {
    const url = new URL(database.url);
    url.searchParams.set('application_name', CHILD_APP);
    const proc = spawn(process.execPath, ['--import', 'tsx', CHILD], {
      cwd: API_ROOT,
      env: {
        ...process.env,
        CRASH_MODE: 'upload',
        CRASH_DATABASE_URL: url.toString(),
        CRASH_STORAGE_DIR: storageDir,
        CRASH_FILE: filePath,
        CRASH_COURSE: ids.course,
        CRASH_SECTION: ids.section,
        CRASH_SESSION: session.token,
        CRASH_CSRF: session.csrf,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    const line = async (prefix: string) => {
      for (let i = 0; i < 1200; i += 1) {
        const found = out.split('\n').find((text) => text.startsWith(prefix));
        if (found !== undefined) return found.slice(prefix.length).trim();
        if (proc.exitCode !== null) break;
        await sleep(50);
      }
      throw new Error(`child gave no "${prefix}": ${out.slice(-400)} ${err.slice(-400)}`);
    };
    return {
      paused: () => line('PAUSED '),
      result: async () => JSON.parse(await line('RESULT ')) as { status: number; code: string | null },
      async kill(options: { waitForDatabase?: boolean } = {}) {
        proc.kill('SIGKILL');
        await exited;
        if (options.waitForDatabase !== false) await childGone();
      },
    };
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-upload-recovery-'));
    storageDir = join(root, 'store');
    filePath = join(root, 'upload.pdf');
    await writeFile(filePath, file);
    local = new LocalDocumentStorage(storageDir);
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const app = await appWith();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@academiapath.example', password: PASSWORD }, headers: { origin: ORIGIN } });
    session = { token: login.cookies.find((cookie) => cookie.name === COOKIE)!.value, csrf: expectStatus(login, 200).csrfToken };
    const call = async (method: 'GET' | 'POST', url: string, payload?: object) =>
      (await app.inject({ method, url: `/api/v1${url}`, ...(payload ? { payload } : {}), cookies: { [COOKIE]: session.token }, headers: { 'x-csrf-token': session.csrf, origin: ORIGIN } })).json();
    const program = (await call('POST', '/programs', { code: 'UPR', name: 'Upload recovery' })).id;
    const term = (await call('POST', '/terms', { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' })).id;
    const template = (await call('POST', '/course-templates', { code: 'UPR-T', programId: program, title: 'Upload recovery course', sections: [{ title: 'Unit 1' }] })).templateId;
    ids.course = (await call('POST', '/courses', { programId: program, termId: term, templateId: template, code: 'UPR-1', status: 'published' })).id;
    ids.section = (await call('GET', `/courses/${ids.course}/sections`)).items[0].id;
  });

  after(async () => {
    for (const app of apps) await app.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('a successful upload journals its key before the write and settles the entry in the same commit', async () => {
    const seen: Intent[][] = [];
    const app = await appWith({ storage: wrapped({ afterPut: async () => void seen.push(await intents()) }) });
    const before = { documents: await documents(), audits: await uploadAudits() };
    const res = await upload(app);
    const body = expectStatus(res, 201);
    const [written] = await q<{ storage_key: string }>('SELECT storage_key FROM course_documents WHERE id = $1', [body.document.id]);
    assert.equal(seen.length, 1);
    assert.deepEqual(
      seen[0]!.map((row) => [row.storage_key, row.operation, row.expired]),
      [[written!.storage_key, 'document_upload', false]],
      'while the file was written, its key was journaled with a running lease',
    );
    assert.equal(await documents(), before.documents + 1);
    assert.equal(await uploadAudits(), before.audits + 1);
    assert.ok(!res.body.includes(written!.storage_key), 'the response never contains the storage key');
    await assertClean('success');
  });

  it('crash before the storage write: the journaled key has no file, and recovery forgets it once the lease has run out', async () => {
    const before = await documents();
    const run = child({ CRASH_PAUSE: 'before-put:1' });
    await run.paused();
    await run.kill();
    assert.deepEqual(await unreferencedFiles(), []);
    const [entry, ...rest] = await intents();
    assert.deepEqual([entry?.operation, entry?.expired, rest.length], ['document_upload', false, 0]);
    assert.deepEqual(actions(await recover()), ['wait_active_lease'], 'a possibly running upload is never touched');
    await expireLeases();
    assert.deepEqual(actions(await recover()), ['file_already_missing']);
    assert.equal(await documents(), before, 'no document was created');
    await assertClean('crash before the write');
  });

  it('crash right after the file is written: the file is journaled, left alone while its lease runs, then recovered', async () => {
    const events = await count(`SELECT count(*) AS n FROM audit_log WHERE action = 'storage.write_recovered'`);
    const run = child({ CRASH_PAUSE: 'after-put:1' });
    await run.paused();
    await run.kill();
    const left = await unreferencedFiles();
    assert.equal(left.length, 1);
    assert.deepEqual(
      (await intents()).map((row) => [row.storage_key, row.operation]),
      [[left[0], 'document_upload']],
    );
    assert.deepEqual(actions(await recover()), ['wait_active_lease']);
    assert.deepEqual(await unreferencedFiles(), left);
    await expireLeases();
    assert.deepEqual(actions(await plan()), ['remove_file']);
    assert.deepEqual(await unreferencedFiles(), left, 'the dry run removed nothing');
    assert.deepEqual(actions(await recover()), ['file_removed']);
    const [event] = await q<{ metadata: Record<string, any> }>(`SELECT metadata FROM audit_log WHERE action = 'storage.write_recovered' ORDER BY created_at DESC, id DESC LIMIT 1`);
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE action = 'storage.write_recovered'`), events + 1);
    assert.equal(event!.metadata.before.operation, 'document_upload');
    assert.ok(!JSON.stringify(event!.metadata).includes(left[0]!), 'no storage key in the audit event');
    await assertClean('crash after the write');
  });

  it('crash before the database commit: nothing is created, the entry is back after the rollback, and the file is recovered', async () => {
    const before = await documents();
    // Hold the upload inside its transaction (after it took back its entry) by locking the activities table.
    const locker = await database.pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE activities IN EXCLUSIVE MODE');
      const run = child({});
      let blocked = false;
      for (let i = 0; i < 1200 && !blocked; i += 1) {
        blocked = (await count(`SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [CHILD_APP])) > 0;
        if (!blocked) await sleep(50);
      }
      assert.ok(blocked, 'the upload is waiting inside its transaction');
      assert.equal((await unreferencedFiles()).length, 1, 'the file was written');
      // Its entry is still visible to others (the deletion is not committed), and a recovery now touches nothing.
      assert.deepEqual(actions(await recover()), ['wait_active_lease']);
      assert.equal((await unreferencedFiles()).length, 1);
      await run.kill({ waitForDatabase: false });
      await locker.query('ROLLBACK');
    } finally {
      locker.release();
    }
    await childGone();
    assert.equal(await documents(), before, 'the killed transaction rolled back');
    assert.equal((await intents()).length, 1, 'and its journal entry is back');
    await expireLeases();
    assert.deepEqual(actions(await recover()), ['file_removed']);
    await assertClean('crash before the commit');
  });

  it('crash during the clean-up of a failed upload: recovery removes what the clean-up left', async () => {
    for (const [pause, expected] of [
      ['before-remove:1', 'file_removed'],
      ['after-remove:1', 'file_already_missing'],
    ] as const) {
      const run = child({ CRASH_FAIL_TRANSACTION: '1', CRASH_PAUSE: pause });
      await run.paused();
      await run.kill();
      assert.equal((await intents()).length, 1, `${pause}: the entry was not forgotten`);
      await expireLeases();
      assert.deepEqual(actions(await recover()), [expected], pause);
      await assertClean(`crash during clean-up (${pause})`);
    }
  });

  it('a failed storage write is refused (503), and any part of the file is removed or stays journaled', async () => {
    const before = await documents();
    const eio = () => Promise.reject(Object.assign(new Error('EIO: i/o error, write /srv/storage/x'), { code: 'EIO' }));
    // Nothing was written: the entry is simply released.
    expectStatus(await upload(await appWith({ storage: wrapped({ put: eio }) })), 503, 'DOCUMENT_STORAGE_UNAVAILABLE');
    await assertClean('write failure');
    // Part of the file was written and cannot be removed: it stays journaled, and recovery removes it later.
    const partial = wrapped({ put: async (bytes, key) => (await local.put(bytes.subarray(0, 100), key), eio()), remove: eio });
    expectStatus(await upload(await appWith({ storage: partial })), 503, 'DOCUMENT_STORAGE_UNAVAILABLE');
    assert.equal((await unreferencedFiles()).length, 1);
    assert.deepEqual(
      (await intents()).map((row) => row.storage_key),
      await unreferencedFiles(),
    );
    await expireLeases();
    assert.deepEqual(actions(await recover()), ['file_removed']);
    assert.equal(await documents(), before);
    await assertClean('partial write');
  });

  it('a failed database transaction removes the file and releases the entry; no document or upload audit', async () => {
    const before = { documents: await documents(), audits: await uploadAudits() };
    const res = await upload(await appWith({ db: failingTransactions() }));
    assert.equal(res.statusCode, 500, res.body);
    assert.deepEqual({ documents: await documents(), audits: await uploadAudits() }, before);
    await assertClean('transaction failure');
  });

  it('a failed transaction whose clean-up also fails leaves a journaled file, which recovery removes after the lease', async () => {
    const before = await documents();
    const logged = logs.length;
    const stuck = wrapped({ remove: async () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })) });
    const res = await upload(await appWith({ db: failingTransactions(), storage: stuck }));
    assert.equal(res.statusCode, 500, res.body);
    const left = await unreferencedFiles();
    assert.equal(left.length, 1, 'the file could not be removed');
    assert.deepEqual(
      (await intents()).map((row) => row.storage_key),
      left,
      'and it stays journaled',
    );
    const text = logs.slice(logged).join('\n');
    assert.match(text, /stays journaled for storage recovery/);
    assert.ok(!text.includes(left[0]!), 'the log never contains the storage key');
    assert.deepEqual(actions(await recover()), ['wait_active_lease']);
    await expireLeases();
    assert.deepEqual(actions(await recover()), ['file_removed']);
    assert.equal(await documents(), before);
    await assertClean('failed clean-up');
  });

  it('recovery while an upload is active touches nothing, and the upload completes', async () => {
    const app = await appWith({
      storage: wrapped({
        afterPut: async () => {
          const report = await recover();
          assert.deepEqual(actions(report), ['wait_active_lease']);
        },
      }),
    });
    expectStatus(await upload(app), 201);
    await assertClean('active upload');
  });

  it('a lease that ran out mid-upload: recovery reclaims the file, and the upload is refused instead of committing', async () => {
    const before = { documents: await documents(), audits: await uploadAudits() };
    const app = await appWith({
      storage: wrapped({
        afterPut: async () => {
          await expireLeases();
          assert.deepEqual(actions(await recover()), ['file_removed']);
        },
      }),
    });
    expectStatus(await upload(app), 503, 'DOCUMENT_STORAGE_UNAVAILABLE');
    assert.deepEqual({ documents: await documents(), audits: await uploadAudits() }, before, 'no document refers to a reclaimed file');
    await assertClean('reclaimed mid-upload');
  });

  it('repeated recovery changes nothing more', async () => {
    const run = child({ CRASH_PAUSE: 'after-put:1' });
    await run.paused();
    await run.kill();
    await expireLeases();
    assert.deepEqual(actions(await recover()), ['file_removed']);
    const events = await count(`SELECT count(*) AS n FROM audit_log WHERE action LIKE 'storage.write_recover%'`);
    const stored = await files();
    for (let i = 0; i < 2; i += 1) assert.equal((await recover()).counts.journaled, 0);
    assert.equal(await count(`SELECT count(*) AS n FROM audit_log WHERE action LIKE 'storage.write_recover%'`), events);
    assert.deepEqual(await files(), stored);
    await assertClean('repeated recovery');
  });

  it('a file a document refers to is never deleted, even with an abandoned upload entry for it', async () => {
    const body = expectStatus(await upload(await appWith()), 201);
    const [row] = await q<{ storage_key: string }>('SELECT storage_key FROM course_documents WHERE id = $1', [body.document.id]);
    const bytes = await local.read(row!.storage_key);
    await q(`INSERT INTO document_storage_intents (storage_key, operation, operation_id, lease_expires_at) VALUES ($1, 'document_upload', gen_random_uuid(), now() - interval '1 hour')`, [
      row!.storage_key,
    ]);
    assert.deepEqual(actions(await plan()), ['forget_entry_file_referenced']);
    assert.deepEqual(actions(await recover()), ['file_kept_referenced']);
    assert.deepEqual(await local.read(row!.storage_key), bytes, 'the document file is intact');
    await assertClean('referenced file');
  });

  it('logs never contain storage keys', async () => {
    const text = logs.join('\n');
    for (const key of await files()) assert.ok(!text.includes(key), 'no storage key in the logs');
    for (const row of await q<{ storage_key: string }>('SELECT storage_key FROM course_documents')) assert.ok(!text.includes(row.storage_key));
  });
});
