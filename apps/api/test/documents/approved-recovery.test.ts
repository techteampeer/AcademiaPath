/**
 * AP-OPS-02: approval-based storage recovery against a simulated Cloud Storage JSON API (test/helpers/fake-gcs.ts),
 * backed by the same directory the application writes to (as production writes through the FUSE mount and recovery
 * reads the bucket directly). Abandoned files come from real uploads and archive imports killed with SIGKILL
 * (test/helpers/storage-crash-child.ts). Disposable PostgreSQL, synthetic files, no real Cloud Storage. Numbers in the
 * test names refer to the AP-OPS-02 test list.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { main as approvedCli, APPROVED_EXIT } from '../../scripts/storage-recover-approved.js';
import { seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { programs, terms, users } from '../../src/db/schema/index.js';
import { applyApprovedRecovery, keyRef, planApprovedRecovery, planDigest, type ApplyReport, type RecoveryPlan } from '../../src/documents/approved-recovery.js';
import { GcsJsonObjectStore, type RecoveryObjectStore } from '../../src/documents/object-store.js';
import { LocalDocumentStorage } from '../../src/documents/storage.js';
import { openStorageJournal } from '../../src/documents/storage-journal.js';
import { exported } from '../helpers/archives.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { makePdf, multipartBody } from '../helpers/documents.js';
import { generationOf, startFakeGcs, type FakeGcs } from '../helpers/fake-gcs.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const BUCKET = 'ap-test-documents';
const DATABASE_ID = 'test-host:5432/approved-recovery';
const CHILD = fileURLToPath(new URL('../helpers/storage-crash-child.ts', import.meta.url));
const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHILD_APP = 'ap-approved-recovery-child';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Intent = { id: string; storage_key: string; operation: string; attempts: number; last_error: string | null };

describe('approval-based storage recovery against Cloud Storage (AP-OPS-02, PostgreSQL, simulated API)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let storageDir: string;
  let local: LocalDocumentStorage;
  let gcs: FakeGcs;
  let store: GcsJsonObjectStore;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let session: { token: string; csrf: string };
  const ids = {} as Record<'admin' | 'program' | 'term' | 'course' | 'section', string>;
  let archivePath: string;

  const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await database.pool.query<T>(text, params)).rows;
  const files = async () => (await readdir(storageDir).catch(() => [] as string[])).sort();
  const intents = () => q<Intent>('SELECT id, storage_key, operation, attempts, last_error FROM document_storage_intents ORDER BY created_at, id');
  const expireLeases = () => q(`UPDATE document_storage_intents SET lease_expires_at = now() - interval '1 second'`);
  const unreferenced = async () => {
    const known = new Set((await q<{ storage_key: string }>('SELECT storage_key FROM course_documents')).map((row) => row.storage_key));
    return (await files()).filter((name) => !known.has(name));
  };
  const recoveryEvents = () => q<{ action: string; metadata: Record<string, any> }>(`SELECT action, metadata FROM audit_log WHERE action LIKE 'storage.write_recover%' ORDER BY created_at, id`);
  const snapshot = async () => ({ intents: await intents(), files: await files(), events: (await recoveryEvents()).length });
  const assertClean = async (label: string) => {
    assert.deepEqual(await intents(), [], `${label}: no journal entry left`);
    assert.deepEqual(await unreferenced(), [], `${label}: no unreferenced file left`);
  };
  const deps = (overrides: { store?: RecoveryObjectStore; database?: string } = {}) => ({ db: database.db, store: overrides.store ?? store, database: overrides.database ?? DATABASE_ID });
  const plan = (options: Parameters<typeof planApprovedRecovery>[1] = {}, overrides: Parameters<typeof deps>[0] = {}) => planApprovedRecovery(deps(overrides), options);
  const apply = (recoveryPlan: unknown, approvedDigest: string, overrides: Parameters<typeof deps>[0] = {}) => applyApprovedRecovery(deps(overrides), { plan: recoveryPlan, approvedDigest });
  const outcomes = (report: ApplyReport) => report.entries.map((entry) => entry.outcome).sort();
  /** Abandoned writes as a dead writer leaves them: journaled, stored (unless `unwritten`), lease run out. */
  const abandoned = async (count: number, options: { unwritten?: boolean; expired?: boolean } = {}) => {
    const journal = openStorageJournal(database.db, 'document_upload', ids.admin);
    const keys: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const key = await journal.reserve();
      if (!options.unwritten) await local.put(Buffer.from(`synthetic abandoned file ${i} ${randomUUID()}`), key);
      keys.push(key);
    }
    if (options.expired !== false) await q(`UPDATE document_storage_intents SET lease_expires_at = now() - interval '1 second' WHERE operation_id = $1`, [journal.operationId]);
    return keys;
  };
  const uploadDocument = async () => {
    const { payload, contentType } = multipartBody([{ name: 'file', filename: 'kept.pdf', data: makePdf([['Kept', `A referenced document ${randomUUID()}.`]]) }]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/${ids.course}/sections/${ids.section}/documents`,
      payload,
      cookies: { ap_session: session.token },
      headers: { 'content-type': contentType, 'x-csrf-token': session.csrf, origin: ORIGIN },
    });
    assert.equal(res.statusCode, 201, res.body);
    return (await q<{ storage_key: string }>('SELECT storage_key FROM course_documents WHERE id = $1', [res.json().document.id]))[0]!.storage_key;
  };
  /** Rewrites an object with new content and a later modification time: a new generation, as in Cloud Storage. */
  const rewrite = async (key: string) => {
    await writeFile(join(storageDir, key), `rewritten ${randomUUID()}`);
    const later = new Date(Date.now() + 60_000);
    await utimes(join(storageDir, key), later, later);
  };

  const childGone = async () => {
    for (let i = 0; i < 200 && Number((await q<{ n: string }>('SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = $1', [CHILD_APP]))[0]!.n) > 0; i += 1) await sleep(50);
  };
  /** A child process (real SIGKILL): an upload, an archive import or an approved apply. */
  const child = (env: Record<string, string>) => {
    const url = new URL(database.url);
    url.searchParams.set('application_name', CHILD_APP);
    const proc = spawn(process.execPath, ['--import', 'tsx', CHILD], {
      cwd: API_ROOT,
      env: { ...process.env, CRASH_DATABASE_URL: url.toString(), CRASH_STORAGE_DIR: storageDir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    proc.stderr.on('data', () => undefined);
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    return {
      paused: async () => {
        for (let i = 0; i < 1200 && !out.includes('PAUSED'); i += 1) await sleep(50);
        assert.ok(out.includes('PAUSED'), `child did not pause: ${out.slice(-300)}`);
      },
      kill: async () => {
        proc.kill('SIGKILL');
        await exited;
        await childGone();
      },
    };
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-approved-recovery-'));
    storageDir = join(root, 'store');
    archivePath = join(root, 'course.zip');
    await writeFile(archivePath, await exported());
    local = new LocalDocumentStorage(storageDir);
    await local.put(Buffer.from('warm-up'), randomUUID()).then((key) => local.remove(key));
    gcs = await startFakeGcs({ bucket: BUCKET, dir: storageDir });
    store = new GcsJsonObjectStore({ bucket: BUCKET, baseUrl: gcs.url, getAccessToken: async () => 'local-emulator', timeoutMs: 400 });
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    ids.admin = (await database.db.select({ id: users.id }).from(users).where(and(eq(users.systemRole, 'administrator'), eq(users.isActive, true))))[0]!.id;
    app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir }), database: database.db, documents: { storage: local } });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@academiapath.example', password: PASSWORD }, headers: { origin: ORIGIN } });
    session = { token: login.cookies.find((c) => c.name === 'ap_session')!.value, csrf: login.json().csrfToken };
    const call = async (method: 'GET' | 'POST', url: string, payload?: object) =>
      (await app.inject({ method, url: `/api/v1${url}`, ...(payload ? { payload } : {}), cookies: { ap_session: session.token }, headers: { 'x-csrf-token': session.csrf, origin: ORIGIN } })).json();
    ids.program = (await database.db.insert(programs).values({ code: 'APR', name: 'Approved recovery' }).returning({ id: programs.id }))[0]!.id;
    ids.term = (await database.db.insert(terms).values({ code: '2026-2', name: '2026-II', academicYear: 2026, startsOn: '2026-08-17', endsOn: '2026-12-11' }).returning({ id: terms.id }))[0]!.id;
    const template = (await call('POST', '/course-templates', { code: 'APR-T', programId: ids.program, title: 'Approved recovery course', sections: [{ title: 'Unit 1' }] })).templateId;
    ids.course = (await call('POST', '/courses', { programId: ids.program, termId: ids.term, templateId: template, code: 'APR-1', status: 'published' })).id;
    ids.section = (await call('GET', `/courses/${ids.course}/sections`)).items[0].id;
  });

  after(async () => {
    await app?.close();
    await gcs?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('1, 5, 6, 7. an upload killed after writing: the dry run proposes its exact generation and changes nothing; the approved digest deletes exactly that', async () => {
    await writeFile(join(root, 'upload.pdf'), makePdf([['Crash', 'Interrupted upload.']]));
    const run = child({ CRASH_MODE: 'upload', CRASH_PAUSE: 'after-put:1', CRASH_FILE: join(root, 'upload.pdf'), CRASH_COURSE: ids.course, CRASH_SECTION: ids.section, CRASH_SESSION: session.token, CRASH_CSRF: session.csrf });
    await run.paused();
    await run.kill();
    await expireLeases();
    const [key] = await unreferenced();
    assert.ok(key);
    gcs.reset();
    const before = await snapshot();
    const recoveryPlan = await plan();
    assert.equal(recoveryPlan.status, 'ready');
    assert.deepEqual(recoveryPlan.counts, { journaled: 1, active: 0, abandoned: 1, proposedDeletions: 1, forgetMissing: 0, forgetReferenced: 0, uncertain: 0 });
    assert.deepEqual(
      recoveryPlan.items.map((item) => [item.operation, item.action, item.keyRef, item.generation]),
      [['document_upload', 'delete', keyRef(key), await generationOf(join(storageDir, key))]],
    );
    assert.equal(recoveryPlan.digest, planDigest(recoveryPlan), 'the digest is reproducible from the plan');
    assert.ok(!JSON.stringify(recoveryPlan).includes(key), 'the plan holds no storage key');
    // 6. A dry run alone (no approval) changes nothing.
    assert.deepEqual(await snapshot(), before);
    assert.ok(gcs.requests.every((request) => request.method === 'GET'), 'the dry run only reads');
    // 7. The approved digest deletes exactly the planned generation.
    const report = await apply(recoveryPlan, recoveryPlan.digest);
    assert.equal(report.status, 'complete');
    assert.deepEqual(outcomes(report), ['file_removed']);
    assert.ok(!(await files()).includes(key));
    const deletes = gcs.requests.filter((request) => request.method === 'DELETE');
    assert.deepEqual(
      deletes.map((request) => [request.bucket, request.query.ifGenerationMatch]),
      [[BUCKET, recoveryPlan.items[0]!.generation]],
      'one delete, conditional on the planned generation',
    );
    assert.ok(gcs.requests.every((request) => request.name !== null && request.query.alt === undefined), 'nothing listed or downloaded');
    const [event] = (await recoveryEvents()).slice(before.events);
    assert.deepEqual([event!.action, event!.metadata.after.outcome, event!.metadata.after.planDigest, event!.metadata.after.generation], ['storage.write_recovered', 'file_removed', recoveryPlan.digest, recoveryPlan.items[0]!.generation]);
    assert.ok(!JSON.stringify(event!.metadata).includes(key), 'no storage key in the audit event');
    assert.ok(!JSON.stringify(report).includes(key), 'no storage key in the report');
    await assertClean('upload crash');
  });

  it('4. an archive import killed after two files: both are planned and deleted', async () => {
    const run = child({ CRASH_MODE: 'import', CRASH_PAUSE: 'after-put:2', CRASH_ARCHIVE: archivePath, CRASH_ACTOR: ids.admin, CRASH_PROGRAM: ids.program, CRASH_TERM: ids.term, CRASH_CODE: 'APR-CRASH' });
    await run.paused();
    await run.kill();
    await expireLeases();
    const recoveryPlan = await plan();
    assert.deepEqual(
      recoveryPlan.items.map((item) => [item.operation, item.action]),
      [
        ['archive_import', 'delete'],
        ['archive_import', 'delete'],
      ],
    );
    assert.deepEqual(outcomes(await apply(recoveryPlan, recoveryPlan.digest)), ['file_removed', 'file_removed']);
    await assertClean('import crash');
  });

  it('2, 12. an active upload is left alone; a lease renewed after the plan stops its deletion', async () => {
    const [key] = await abandoned(1, { expired: false });
    const active = await plan();
    assert.deepEqual([active.items, active.skipped.map((skip) => skip.reason)], [[], ['lease_active']]);
    await expireLeases();
    const recoveryPlan = await plan();
    assert.equal(recoveryPlan.items[0]!.action, 'delete');
    await q(`UPDATE document_storage_intents SET lease_expires_at = now() + interval '30 minutes'`);
    const before = await snapshot();
    assert.deepEqual(outcomes(await apply(recoveryPlan, recoveryPlan.digest)), ['skipped_lease_active']);
    assert.deepEqual(await snapshot(), before, 'nothing changed');
    assert.ok((await files()).includes(key!));
    await expireLeases();
    const again = await plan();
    assert.deepEqual(outcomes(await apply(again, again.digest)), ['file_removed']);
    await assertClean('active upload');
  });

  it('3, 11. a referenced document is never deleted, including one that becomes referenced after the plan', async () => {
    const kept = await uploadDocument();
    const bytes = await readFile(join(storageDir, kept));
    await q(`INSERT INTO document_storage_intents (storage_key, operation, operation_id, lease_expires_at) VALUES ($1, 'document_upload', gen_random_uuid(), now() - interval '1 hour')`, [kept]);
    const [other] = await abandoned(1);
    const recoveryPlan = await plan();
    assert.deepEqual(recoveryPlan.items.map((item) => item.action).sort(), ['delete', 'forget_referenced']);
    // 11. After the plan, a document comes to refer to the planned file (documents are immutable: a new row).
    const [added] = await q<{ id: string }>(
      `INSERT INTO course_documents (activity_id, storage_key, file_name, format, byte_size, sha256, extraction_status, extraction_detail, segments, character_count, truncated, malware_scan_status, malware_scanner, uploaded_by_user_id)
       SELECT activity_id, $1, file_name, format, byte_size, sha256, extraction_status, extraction_detail, segments, character_count, truncated, malware_scan_status, malware_scanner, uploaded_by_user_id
       FROM course_documents WHERE storage_key = $2 RETURNING id`,
      [other, kept],
    );
    const report = await apply(recoveryPlan, recoveryPlan.digest);
    assert.deepEqual(outcomes(report), ['file_kept_referenced', 'skipped_now_referenced']);
    assert.ok((await files()).includes(other!), 'the now-referenced file was not deleted');
    assert.deepEqual(await readFile(join(storageDir, kept)), bytes, 'the document file is intact');
    assert.deepEqual((await intents()).map((row) => [row.storage_key, row.attempts]), [[other, 0]], 'the referenced entry is forgotten; the other one is kept untouched');
    // Once that document is gone again, the abandoned file is deleted.
    await q('DELETE FROM course_documents WHERE id = $1', [added!.id]);
    const again = await plan();
    assert.deepEqual(outcomes(await apply(again, again.digest)), ['file_removed']);
    await assertClean('referenced');
  });

  it('8. without the approved digest nothing happens: no approval, a wrong digest, a tampered or malformed plan', async () => {
    await abandoned(1);
    const recoveryPlan = await plan();
    const before = await snapshot();
    gcs.reset();
    const tampered: RecoveryPlan = { ...recoveryPlan, items: recoveryPlan.items.map((item) => ({ ...item, generation: item.action === 'delete' ? '1' : item.generation })) };
    for (const [label, report] of [
      ['no approval', await apply(recoveryPlan, '')],
      ['wrong digest', await apply(recoveryPlan, 'a'.repeat(64))],
      ['another plan’s digest', await apply(recoveryPlan, planDigest({ ...recoveryPlan, expiresAt: new Date(0).toISOString() }))],
      ['tampered plan', await apply(tampered, recoveryPlan.digest)],
    ] as const) {
      assert.deepEqual([report.status, report.refusal], ['refused', 'digest_mismatch'], label);
    }
    for (const malformed of [null, {}, { ...recoveryPlan, format: 'other' }, { ...recoveryPlan, items: [{ ...recoveryPlan.items[0], intentId: 'x' }] }]) {
      assert.equal((await apply(malformed, recoveryPlan.digest)).refusal, 'invalid_plan');
    }
    assert.deepEqual(await snapshot(), before, 'nothing changed');
    assert.equal(gcs.requests.filter((request) => request.method === 'DELETE').length, 0, 'nothing was even attempted');
    assert.deepEqual(outcomes(await apply(recoveryPlan, recoveryPlan.digest)), ['file_removed']);
    await assertClean('approval');
  });

  it('9. an expired approval is refused, including one that expires during the run', async () => {
    await abandoned(1);
    const expired = await plan({ expiresInSeconds: 0 });
    const before = await snapshot();
    assert.deepEqual([(await apply(expired, expired.digest)).refusal], ['approval_expired']);
    assert.deepEqual(await snapshot(), before);
    // A short approval runs out while the first item is being handled: the next items are not touched.
    const keys = await abandoned(1);
    const short = await plan({ expiresInSeconds: 2 });
    const [first, second] = [...short.items].sort((a, b) => (a.intentId < b.intentId ? -1 : 1));
    const [firstKey] = [...keys, ...before.intents.map((row) => row.storage_key)].filter((key) => keyRef(key) === first!.keyRef);
    let delayed = false;
    const slow: RecoveryObjectStore = {
      bucket: store.bucket,
      endpoint: store.endpoint,
      stat: async (k) => {
        if (k === firstKey && !delayed) {
          delayed = true;
          await sleep(2_500);
        }
        return store.stat(k);
      },
      deleteGeneration: (k, generation) => store.deleteGeneration(k, generation),
    };
    const report = await apply(short, short.digest, { store: slow });
    assert.deepEqual(
      report.entries.map((entry) => [entry.keyRef, entry.outcome]),
      [
        [first!.keyRef, 'file_removed'],
        [second!.keyRef, 'skipped_approval_expired'],
      ],
    );
    assert.equal((await intents()).length, 1, 'the entry after the expiry is kept');
    const fresh = await plan();
    assert.deepEqual(outcomes(await apply(fresh, fresh.digest)), ['file_removed']);
    await assertClean('expiry');
  });

  it('10. an object that changed after the plan (or between the check and the deletion) is never deleted under it', async () => {
    const [key] = await abandoned(1);
    const recoveryPlan = await plan();
    await rewrite(key!);
    const changed = await generationOf(join(storageDir, key!));
    gcs.reset();
    const report = await apply(recoveryPlan, recoveryPlan.digest);
    assert.deepEqual(report.entries.map((entry) => [entry.outcome, entry.errorCode]), [['failed', 'GENERATION_CHANGED']]);
    assert.equal(gcs.requests.filter((request) => request.method === 'DELETE').length, 0, 'a changed object is not even asked to be deleted');
    assert.equal(await generationOf(join(storageDir, key!)), changed, 'the new generation is intact');
    assert.deepEqual((await intents()).map((row) => [row.attempts, row.last_error]), [[1, 'GENERATION_CHANGED']], 'kept and flagged');
    // Changed between the generation check and the deletion: the precondition refuses it.
    const second = await plan();
    const racing: RecoveryObjectStore = {
      bucket: store.bucket,
      endpoint: store.endpoint,
      stat: (k) => store.stat(k),
      deleteGeneration: async (k, generation) => {
        await rewrite(k);
        return store.deleteGeneration(k, generation);
      },
    };
    assert.deepEqual((await apply(second, second.digest, { store: racing })).entries.map((entry) => entry.errorCode), ['GENERATION_CHANGED']);
    assert.ok((await files()).includes(key!), 'still there');
    const third = await plan();
    assert.deepEqual(outcomes(await apply(third, third.digest)), ['file_removed']);
    await assertClean('generation');
  });

  it('13. an object already gone: never written, or removed after the plan', async () => {
    await abandoned(1, { unwritten: true });
    const [gone] = await abandoned(1);
    const recoveryPlan = await plan();
    assert.deepEqual(recoveryPlan.items.map((item) => item.action).sort(), ['delete', 'forget_missing']);
    await unlink(join(storageDir, gone!));
    assert.deepEqual(outcomes(await apply(recoveryPlan, recoveryPlan.digest)), ['file_already_missing', 'file_already_missing']);
    await assertClean('missing');
  });

  it('14, 15, 16. permission denied, a timeout or an unavailable API never deletes or forgets anything', async () => {
    await uploadDocument(); // a referenced file for the storage witness
    const [key] = await abandoned(1);
    // In the plan: uncertain, not authorized.
    gcs.reset();
    gcs.faults.set(key!, 'forbidden');
    const uncertain = await plan();
    assert.deepEqual([uncertain.items.length, uncertain.counts.uncertain, uncertain.skipped[0]?.errorCode], [0, 1, 'PERMISSION_DENIED']);
    // At apply time: each failure keeps the entry, counts the attempt and records the code.
    gcs.reset();
    const recoveryPlan = await plan();
    for (const [fault, code] of [
      ['forbidden', 'PERMISSION_DENIED'],
      ['hang', 'TIMEOUT'],
      ['unavailable', 'UNAVAILABLE'],
    ] as const) {
      gcs.faults.set(key!, fault);
      const report = await apply(recoveryPlan, recoveryPlan.digest);
      assert.deepEqual(report.entries.map((entry) => [entry.outcome, entry.errorCode]), [['failed', code]], fault);
      assert.equal(report.status, 'incomplete');
    }
    assert.deepEqual((await intents()).map((row) => [row.storage_key, row.attempts, row.last_error]), [[key, 3, 'UNAVAILABLE']]);
    assert.ok((await files()).includes(key!));
    // The whole API unavailable: no plan, no apply (the storage cannot even be verified).
    gcs.reset();
    gcs.faults.set('*', 'unavailable');
    assert.deepEqual([(await plan()).status, (await plan()).refusal], ['refused', 'storage_error']);
    assert.equal((await apply(recoveryPlan, recoveryPlan.digest)).refusal, 'storage_error');
    gcs.reset();
    assert.ok((await files()).includes(key!));
    const again = await plan();
    assert.deepEqual(outcomes(await apply(again, again.digest)), ['file_removed']);
    await assertClean('failures');
  });

  it('17. concurrent recovery jobs handle each approved item exactly once', async () => {
    const keys = await abandoned(4);
    const recoveryPlan = await plan();
    const events = (await recoveryEvents()).length;
    const reports = await Promise.all([1, 2, 3].map(() => apply(recoveryPlan, recoveryPlan.digest)));
    const removed = reports.flatMap((report) => report.entries.filter((entry) => entry.outcome === 'file_removed').map((entry) => entry.keyRef));
    assert.deepEqual(removed.sort(), keys.map(keyRef).sort(), 'each file removed by exactly one job');
    assert.ok(reports.flatMap((report) => report.entries).every((entry) => ['file_removed', 'skipped_locked', 'skipped_entry_gone'].includes(entry.outcome)));
    assert.equal((await recoveryEvents()).length - events, 4, 'one audit event per file');
    await assertClean('concurrent');
  });

  it('18, 19. killed after the deletion and before the journal update: the same approval finishes it; repeating changes nothing', async () => {
    const [key] = await abandoned(1);
    const recoveryPlan = await plan();
    const planFile = join(root, `plan-${randomUUID()}.json`);
    await writeFile(planFile, JSON.stringify(recoveryPlan));
    const events = (await recoveryEvents()).length;
    let deleted!: () => void;
    const wasDeleted = new Promise<void>((resolve) => (deleted = resolve));
    // After the object is deleted, its verification hangs: the job is killed inside its transaction.
    gcs.onDelete = (name) => {
      gcs.faults.set(name, 'hang');
      deleted();
    };
    const run = child({ CRASH_MODE: 'approved-apply', CRASH_PLAN: planFile, CRASH_DIGEST: recoveryPlan.digest, CRASH_BUCKET: BUCKET, CRASH_API_URL: gcs.url, CRASH_DATABASE_ID: DATABASE_ID });
    await wasDeleted;
    await run.kill();
    gcs.reset();
    assert.ok(!(await files()).includes(key!), 'the object was deleted');
    assert.deepEqual((await intents()).map((row) => row.storage_key), [key], 'but the journal entry rolled back');
    assert.equal((await recoveryEvents()).length, events, 'and no audit event was committed');
    assert.deepEqual(outcomes(await apply(recoveryPlan, recoveryPlan.digest)), ['file_already_missing'], 'the same approval finishes it');
    const after = await snapshot();
    for (let i = 0; i < 2; i += 1) assert.deepEqual(outcomes(await apply(recoveryPlan, recoveryPlan.digest)), ['skipped_entry_gone']);
    assert.deepEqual(await snapshot(), after, 'repeating changes nothing');
    assert.equal((await plan()).items.length, 0);
    await assertClean('crash after deletion');
  });

  it('20. an approval never crosses buckets, endpoints or databases; the adapter reaches no other bucket', async () => {
    await abandoned(1);
    const recoveryPlan = await plan();
    const before = await snapshot();
    const otherBucket = new GcsJsonObjectStore({ bucket: 'ap-other-bucket', baseUrl: gcs.url, getAccessToken: async () => 'local-emulator' });
    const otherApi = await startFakeGcs({ bucket: BUCKET, dir: storageDir });
    try {
      const otherEndpoint = new GcsJsonObjectStore({ bucket: BUCKET, baseUrl: otherApi.url, getAccessToken: async () => 'local-emulator' });
      assert.equal((await apply(recoveryPlan, recoveryPlan.digest, { store: otherBucket })).refusal, 'wrong_bucket');
      assert.equal((await apply(recoveryPlan, recoveryPlan.digest, { store: otherEndpoint })).refusal, 'wrong_environment');
      assert.equal(otherApi.requests.length, 0, 'the other API was never called');
    } finally {
      await otherApi.close();
    }
    assert.equal((await apply(recoveryPlan, recoveryPlan.digest, { database: 'other-host:5432/other' })).refusal, 'wrong_environment');
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(outcomes(await apply(recoveryPlan, recoveryPlan.digest)), ['file_removed']);
    await assertClean('environment');
  });

  it('22. no deletion when storage observations cannot be trusted', async () => {
    await uploadDocument();
    const [key] = await abandoned(1);
    // A store that shows none of the documents' files (a wrong prefix or bucket): the plan is refused.
    const blind = new GcsJsonObjectStore({ bucket: BUCKET, baseUrl: gcs.url, prefix: 'elsewhere/', getAccessToken: async () => 'local-emulator' });
    assert.deepEqual([(await plan({}, { store: blind })).status, (await plan({}, { store: blind })).refusal], ['refused', 'storage_unverified']);
    const refused = await plan({}, { store: blind });
    assert.equal((await apply(refused, refused.digest, { store: blind })).refusal, 'plan_refused');
    // A deletion the store does not reflect: kept and flagged.
    const recoveryPlan = await plan();
    gcs.faults.set(key!, 'ignore_delete');
    const report = await apply(recoveryPlan, recoveryPlan.digest);
    assert.deepEqual(report.entries.map((entry) => [entry.outcome, entry.errorCode]), [['failed', 'STILL_PRESENT']]);
    assert.deepEqual((await intents()).map((row) => [row.storage_key, row.last_error]), [[key, 'STILL_PRESENT']]);
    gcs.reset();
    const again = await plan();
    assert.deepEqual(outcomes(await apply(again, again.digest)), ['file_removed']);
    await assertClean('untrusted');
  });

  it('21. production execution is refused; the command works only against a local emulator', async () => {
    const env = { DATABASE_URL: database.url } as NodeJS.ProcessEnv;
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
    const [key] = await abandoned(1);
    gcs.reset();
    const out = join(root, `cli-plan-${randomUUID()}.json`);
    const args = ['--bucket', BUCKET, '--api-url', gcs.url];
    for (const [label, argv, environment] of [
      ['production', ['plan', ...args, '--out', out], { ...env, NODE_ENV: 'production' }],
      ['Cloud Run service', ['plan', ...args, '--out', out], { ...env, K_SERVICE: 'academiapath-api' }],
      ['Cloud Run job', ['apply', ...args, '--plan', out, '--approve', 'a'.repeat(64)], { ...env, CLOUD_RUN_JOB: 'academiapath-storage-recover' }],
      ['remote database', ['plan', ...args, '--out', out], { DATABASE_URL: 'postgresql://user@db.example.com:5432/app' }],
      ['real Cloud Storage API', ['plan', '--bucket', BUCKET, '--api-url', 'https://storage.googleapis.com', '--out', out], env],
      ['remote emulator', ['plan', '--bucket', BUCKET, '--api-url', 'http://10.0.0.5:4443', '--out', out], env],
    ] as const) {
      assert.equal(await quiet(() => approvedCli([...argv], environment)), APPROVED_EXIT.refused, label);
    }
    assert.equal(gcs.requests.length, 0, 'no storage request was made');
    // Locally, against the emulator: plan (pending approval), then the approved apply.
    assert.equal(await quiet(() => approvedCli(['plan', ...args, '--out', out], env)), APPROVED_EXIT.pending);
    const written = await readFile(out, 'utf8');
    assert.ok(!written.includes(key!), 'the plan file holds no storage key');
    const { digest } = JSON.parse(written) as RecoveryPlan;
    assert.equal(await quiet(() => approvedCli(['apply', ...args, '--plan', out], env)), APPROVED_EXIT.failed, 'no apply without an approval');
    assert.ok((await files()).includes(key!));
    assert.equal(await quiet(() => approvedCli(['apply', ...args, '--plan', out, '--approve', digest], env)), APPROVED_EXIT.clean);
    assert.ok(!(await files()).includes(key!));
    await assertClean('CLI');
  });
});
