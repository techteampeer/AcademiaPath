/**
 * AP-040B storage readiness and document integrity. Readiness and mount detection run on disposable local
 * directories (never the production bucket); the API and the read-only consistency audit run against a temporary
 * PostgreSQL database (skipped unless TEST_DATABASE_URL is set) with synthetic documents in temporary storage.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { auditRefusal, AUDIT_EXIT, exitCodeFor, main as auditMain, runStorageAudit, type AuditReport } from '../../scripts/storage-audit.js';
import { seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { userCredentials, users } from '../../src/db/schema/index.js';
import { isMountPoint } from '../../src/documents/mounts.js';
import { acceptsUploads, checkStorageReadiness } from '../../src/documents/readiness.js';
import { LocalDocumentStorage, type DocumentStorage } from '../../src/documents/storage.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { makePdf, multipartBody } from '../helpers/documents.js';

const PASSWORD = randomBytes(18).toString('base64url');
const COOKIE = 'ap_session';
const ORIGIN = 'http://localhost:3000';
const isRoot = process.getuid?.() === 0;
const mounted = async () => true;
const notMounted = async () => false;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Names, sizes and SHA-256 of every entry of a directory (to prove nothing changed). */
async function snapshot(dir: string) {
  const names = (await readdir(dir).catch(() => [] as string[])).sort();
  return Promise.all(
    names.map(async (name) => {
      const info = await stat(join(dir, name));
      return info.isFile() ? `${name}:${info.size}:${sha256(await readFile(join(dir, name)))}:${info.mtimeMs}` : `${name}/`;
    }),
  );
}

describe('storage readiness (local directories only)', () => {
  let base: string;
  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'ap-readiness-'));
  });
  after(async () => {
    await chmod(join(base, 'locked'), 0o700).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  });

  it('detects real mount points from the mount table and does not mistake an ordinary directory for one', async () => {
    assert.equal(await isMountPoint('/proc'), true, '/proc is always a mount');
    const plain = join(base, 'plain');
    await mkdir(plain);
    assert.equal(await isMountPoint(plain), false, 'an existing directory is not proof of a mount');
    assert.equal(await isMountPoint(join(base, 'absent')), false);
  });

  it('is ready only for an existing, writable directory that is mounted; report mode never blocks, enforce does', async () => {
    const dir = join(base, 'store');
    await mkdir(dir);
    const before = await snapshot(dir);
    assert.deepEqual(
      await checkStorageReadiness(dir, 'report', { isMountPoint: mounted, now: () => new Date('2026-11-16T00:00:00Z') }),
      { status: 'ready', mountCheck: 'report', directory: 'present', access: 'read_write', mount: 'mounted', checkedAt: '2026-11-16T00:00:00.000Z' },
    );
    const report = await checkStorageReadiness(dir, 'report', { isMountPoint: notMounted, now: () => new Date() });
    assert.deepEqual([report.status, report.mount], ['degraded', 'not_mounted'], 'usable, but the mount is not confirmed');
    assert.equal(acceptsUploads(report), true, 'report mode never stops working uploads over the mount');
    const enforce = await checkStorageReadiness(dir, 'enforce', { isMountPoint: notMounted, now: () => new Date() });
    assert.deepEqual([enforce.status, enforce.mount], ['unavailable', 'not_mounted']);
    assert.equal(acceptsUploads(enforce), false);
    assert.equal(acceptsUploads(await checkStorageReadiness(dir, 'enforce', { isMountPoint: mounted, now: () => new Date() })), true);
    // With the real detector a temporary directory is an ordinary directory, as on a container's own disk.
    assert.equal((await checkStorageReadiness(dir, 'enforce')).status, 'unavailable');
    assert.deepEqual(await snapshot(dir), before, 'checking writes nothing');
  });

  it('reports a missing directory or a file without creating anything; off mode (local development) needs no mount', async () => {
    const missing = join(base, 'missing');
    for (const mode of ['report', 'enforce'] as const) {
      const result = await checkStorageReadiness(missing, mode, { isMountPoint: mounted, now: () => new Date() });
      assert.deepEqual([result.status, result.directory], ['unavailable', 'missing']);
      assert.equal(acceptsUploads(result), false, `${mode}: no uploads without a storage directory`);
    }
    await assert.rejects(stat(missing), 'still missing: never created');
    const file = join(base, 'a-file');
    await writeFile(file, 'x');
    assert.equal((await checkStorageReadiness(file, 'report', { isMountPoint: mounted, now: () => new Date() })).directory, 'not_a_directory');
    const off = await checkStorageReadiness(missing, 'off');
    assert.equal(off.status, 'ready', 'local storage is created on first use');
    assert.equal(acceptsUploads(off), true);
  });

  it('reports a directory the API cannot write to', { skip: isRoot ? 'root bypasses file permissions (runs in CI)' : false }, async () => {
    const locked = join(base, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o500);
    const result = await checkStorageReadiness(locked, 'report', { isMountPoint: mounted, now: () => new Date() });
    assert.deepEqual([result.status, result.access], ['unavailable', 'denied']);
    // Reported, but in report mode the write itself decides (a failed write is still a clean 503); enforce refuses.
    assert.equal(acceptsUploads(result), true);
    assert.equal(acceptsUploads(await checkStorageReadiness(locked, 'enforce', { isMountPoint: mounted, now: () => new Date() })), false);
  });

  it('configuration: production checks storage (report by default) and never creates it; local development does', () => {
    const production = { NODE_ENV: 'production', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: '/mnt/documents' };
    assert.deepEqual([loadConfig(production).documents.mountCheck, loadConfig(production).documents.createStorageDir], ['report', false]);
    assert.equal(loadConfig({ ...production, DOCUMENT_STORAGE_MOUNT_CHECK: 'enforce' }).documents.mountCheck, 'enforce');
    assert.throws(() => loadConfig({ ...production, DOCUMENT_STORAGE_MOUNT_CHECK: 'off' }), /cannot be off in production/);
    assert.throws(() => loadConfig({ NODE_ENV: 'test', DOCUMENT_STORAGE_MOUNT_CHECK: 'sometimes' }), /off, report or enforce/);
    const local = loadConfig({ NODE_ENV: 'test' }).documents;
    assert.deepEqual([local.mountCheck, local.createStorageDir], ['off', true]);
  });

  it('production storage never creates its directory: a missing mount point makes writes fail instead of landing on local disk', async () => {
    const missing = join(base, 'not-mounted');
    await assert.rejects(new LocalDocumentStorage(missing, { createRoot: false }).put(Buffer.from('data')), (error: { code?: string }) => error.code === 'ENOENT');
    await assert.rejects(stat(missing));
    const local = join(base, 'local-dev');
    await new LocalDocumentStorage(local).put(Buffer.from('data'));
    assert.equal((await readdir(local)).length, 1, 'local development still creates its storage');
  });
});

describe('storage integrity API and read-only audit (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let root: string;
  let storageDir: string;
  const logLines: string[] = [];
  const sessions = new Map<string, { token: string; csrf: string }>();
  const ids = {} as Record<'course' | 'otherCourse' | 'unit' | 'valid' | 'missing' | 'corrupt', string>;
  const keyOf = new Map<string, string>();

  const env = (extra: NodeJS.ProcessEnv = {}) => ({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir, ...extra });
  const makeApp = (extra: NodeJS.ProcessEnv = {}, options: { isMountPoint?: (path: string) => Promise<boolean>; storage?: DocumentStorage } = {}) =>
    buildApp({
      config: loadConfig(env(extra)),
      database: database.db,
      logger: { level: 'info', stream: { write: (line: string) => void logLines.push(line) } },
      ...(options.isMountPoint ? { isMountPoint: options.isMountPoint } : {}),
      ...(options.storage ? { documents: { storage: options.storage } } : {}),
    });
  const call = (target: ReturnType<typeof buildApp>, who: string | null, method: 'GET' | 'POST', url: string, payload?: object) => {
    const s = who ? sessions.get(who)! : null;
    return target.inject({ method, url: `/api/v1${url}`, ...(payload ? { payload } : {}), cookies: s ? { [COOKIE]: s.token } : {}, headers: method === 'POST' && s ? { 'x-csrf-token': s.csrf, origin: ORIGIN } : {} });
  };
  const ok = (res: LightMyRequestResponse, status = 200) => {
    assert.equal(res.statusCode, status, res.body);
    return res.json();
  };
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };
  const upload = (target: ReturnType<typeof buildApp>, courseId: string, unitId: string, fileName: string, text: string) => {
    const s = sessions.get('instructor')!;
    const { payload, contentType } = multipartBody([{ name: 'file', filename: fileName, data: makePdf([[text, 'Synthetic course material for the storage tests.']]) }]);
    return target.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/sections/${unitId}/documents`, payload, cookies: { [COOKIE]: s.token }, headers: { 'content-type': contentType, 'x-csrf-token': s.csrf, origin: ORIGIN } });
  };
  const approved = async (fileName: string, text: string) => {
    const activityId = ok(await upload(app, ids.course, ids.unit, fileName, text), 201).activityId as string;
    ok(await call(app, 'instructor', 'POST', `/courses/${ids.course}/activities/${activityId}/submit`));
    ok(await call(app, 'reviewer', 'POST', `/courses/${ids.course}/activities/${activityId}/review`, { decision: 'approve' }));
    const { rows } = await database.pool.query<{ storage_key: string }>('SELECT storage_key FROM course_documents WHERE activity_id = $1', [activityId]);
    keyOf.set(activityId, rows[0]!.storage_key);
    return activityId;
  };
  const download = (who: string, activityId: string, target = app) => call(target, who, 'GET', `/courses/${ids.course}/activities/${activityId}/document/file`);
  const tableFingerprint = async () =>
    (
      await database.pool.query<{ f: string }>(
        `SELECT string_agg(t.table_name || ':' || (xpath('/row/h/text()', query_to_xml(format('SELECT count(*) || md5(coalesce(string_agg(x::text, ''|'' ORDER BY x::text), '''')) AS h FROM %I x', t.table_name), false, true, '')))[1]::text, ',' ORDER BY t.table_name) AS f
           FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'`,
      )
    ).rows[0]!.f;
  const audit = (extra: Partial<Parameters<typeof runStorageAudit>[0]> = {}) => runStorageAudit({ databaseUrl: database.url, storageDir, graceMinutes: 60, ...extra });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-integrity-'));
    storageDir = join(root, 'store');
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const [outsider] = await database.db.insert(users).values({ email: 'outsider@academiapath.example', givenName: 'Test', familyName: 'Outsider' }).returning();
    await database.db.insert(userCredentials).values({ userId: outsider!.id, passwordHash: await hashPassword(PASSWORD) });
    app = makeApp();
    await app.ready();
    for (const [who, email] of [['admin', 'admin@academiapath.example'], ['instructor', 'instructor@academiapath.example'], ['reviewer', 'reviewer@academiapath.example'], ['ta', 'ta@academiapath.example'], ['student', 'student@academiapath.example'], ['outsider', 'outsider@academiapath.example']] as const) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD }, headers: { origin: ORIGIN } });
      sessions.set(who, { token: res.cookies.find((c) => c.name === COOKIE)!.value, csrf: ok(res).csrfToken });
    }
    const program = ok(await call(app, 'admin', 'POST', '/programs', { code: 'ST', name: 'Storage' }), 201).id;
    const term = ok(await call(app, 'admin', 'POST', '/terms', { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' }), 201).id;
    const template = ok(await call(app, 'admin', 'POST', '/course-templates', { code: 'ST-T', programId: program, title: 'Storage course', sections: [{ title: 'Unit 1' }] }), 201).templateId;
    for (const key of ['course', 'otherCourse'] as const) {
      ids[key] = ok(await call(app, 'admin', 'POST', '/courses', { programId: program, termId: term, templateId: template, code: `ST-${key}`, status: 'published' }), 201).id;
    }
    for (const [who, role] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['ta', 'non_editing_instructor'], ['student', 'student']] as const) {
      ok(await call(app, 'admin', 'POST', `/courses/${ids.course}/enrollments`, { email: `${who}@academiapath.example`, role }), 201);
    }
    ids.unit = ok(await call(app, 'admin', 'GET', `/courses/${ids.course}/sections`)).items[0].id;
    ids.valid = await approved('Juan Perez - private notes.pdf', 'Valid stored document');
    ids.missing = await approved('missing.pdf', 'Document whose stored file disappears');
    ids.corrupt = await approved('corrupt.pdf', 'Document whose stored file is altered');
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('downloads valid files unchanged, for every role that may read them', async () => {
    for (const who of ['student', 'instructor', 'reviewer', 'ta', 'admin']) {
      const res = await download(who, ids.valid);
      assert.equal(res.statusCode, 200, `${who}: ${res.body.slice(0, 200)}`);
      assert.equal(sha256(res.rawPayload), (await database.pool.query('SELECT sha256 FROM course_documents WHERE storage_key = $1', [keyOf.get(ids.valid)])).rows[0].sha256);
    }
  });

  it('audit: a consistent store is complete and clean — no false positives for valid files', async () => {
    const report = await audit();
    const documentCount = (await database.pool.query('SELECT count(*)::int AS n FROM course_documents')).rows[0].n as number;
    assert.equal(documentCount, 3);
    assert.deepEqual([report.status, report.readOnly, report.counts.documents, report.counts.documentsChecked, report.counts.valid, report.counts.storedEntries], ['complete', true, 3, 3, 3, 3]);
    assert.deepEqual(report.issues, []);
    assert.deepEqual([report.counts.missing, report.counts.corrupt, report.counts.orphaned, report.counts.unrecognized, report.counts.readErrors], [0, 0, 0, 0, 0]);
    assert.equal(exitCodeFor(report), AUDIT_EXIT.clean);
  });

  it('a missing stored file gives DOCUMENT_FILE_MISSING without revealing the storage key, path or content; access rules are unchanged', async () => {
    await rm(join(storageDir, keyOf.get(ids.missing)!));
    const lines = logLines.length;
    const res = await download('student', ids.missing);
    problem(res, 500, 'DOCUMENT_FILE_MISSING');
    for (const secret of [keyOf.get(ids.missing)!, storageDir, root]) assert.ok(!res.body.includes(secret), 'no storage key or path in the response');
    const logged = logLines.slice(lines).join('\n');
    assert.match(logged, /DOCUMENT_FILE_MISSING/);
    assert.ok(logged.includes(ids.missing), 'the log names the activity');
    for (const secret of [keyOf.get(ids.missing)!, storageDir]) assert.ok(!logged.includes(secret), 'no storage key or path in the log');
    // Callers without access still get the normal answers, whatever the state of the file.
    problem(await call(app, null, 'GET', `/courses/${ids.course}/activities/${ids.missing}/document/file`), 401, 'UNAUTHENTICATED');
    const denied = await call(app, 'outsider', 'GET', `/courses/${ids.course}/activities/${ids.missing}/document/file`);
    assert.ok([403, 404].includes(denied.statusCode), denied.body);
    assert.notEqual(denied.json().code, 'DOCUMENT_FILE_MISSING', 'an outsider learns nothing about the stored file');
    problem(await call(app, 'student', 'GET', `/courses/${ids.otherCourse}/activities/${ids.missing}/document/file`), 404, 'NOT_FOUND');
  });

  it('a corrupt stored file (changed bytes, or a different size) gives DOCUMENT_FILE_CORRUPT and is never sent', async () => {
    const path = join(storageDir, keyOf.get(ids.corrupt)!);
    const original = await readFile(path);
    const flipped = Buffer.from(original);
    flipped[flipped.length - 10] = flipped[flipped.length - 10]! ^ 0xff;
    await writeFile(path, flipped);
    let res = await download('instructor', ids.corrupt);
    problem(res, 500, 'DOCUMENT_FILE_CORRUPT');
    assert.ok(!res.body.includes('%PDF'), 'no file content in the error');
    await writeFile(path, Buffer.concat([original, Buffer.from('appended')]));
    res = await download('student', ids.corrupt);
    problem(res, 500, 'DOCUMENT_FILE_CORRUPT');
    await writeFile(path, original);
    assert.equal((await download('student', ids.corrupt)).statusCode, 200, 'restored: served again');
    await writeFile(path, flipped);
  });

  it('storage that cannot be read or written gives DOCUMENT_STORAGE_UNAVAILABLE, never a partial download or a half-created document', async () => {
    const broken: DocumentStorage = {
      put: async () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })),
      read: async () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })),
      remove: async () => undefined,
      exists: async () => false,
    };
    const flaky = makeApp({}, { storage: broken });
    await flaky.ready();
    try {
      problem(await download('student', ids.valid, flaky), 503, 'DOCUMENT_STORAGE_UNAVAILABLE');
      const before = await database.pool.query('SELECT count(*)::int AS n FROM course_documents');
      problem(await upload(flaky, ids.course, ids.unit, 'never-stored.pdf', 'Cannot be stored'), 503, 'DOCUMENT_STORAGE_UNAVAILABLE');
      assert.deepEqual((await database.pool.query('SELECT count(*)::int AS n FROM course_documents')).rows, before.rows);
    } finally {
      await flaky.close();
    }
  });

  it('startup: enforce refuses to start without a mount; report starts, warns and lets administrators see the readiness', async () => {
    const enforced = makeApp({ DOCUMENT_STORAGE_MOUNT_CHECK: 'enforce' }, { isMountPoint: notMounted });
    await assert.rejects(async () => {
      await enforced.ready();
    }, /Document storage is not ready/);
    await enforced.close();
    const fine = makeApp({ DOCUMENT_STORAGE_MOUNT_CHECK: 'enforce' }, { isMountPoint: mounted });
    await fine.ready();
    assert.equal(ok(await call(fine, 'admin', 'GET', '/system/storage')).status, 'ready');
    await fine.close();

    const lines = logLines.length;
    const reported = makeApp({ DOCUMENT_STORAGE_MOUNT_CHECK: 'report' }, { isMountPoint: notMounted });
    await reported.ready();
    try {
      // Report mode checks in the background (it never delays startup): wait for its log entry.
      for (let i = 0; i < 100 && !logLines.slice(lines).join('\n').includes('no mount was detected'); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(logLines.slice(lines).join('\n'), /no mount was detected/);
      const readiness = ok(await call(reported, 'admin', 'GET', '/system/storage'));
      assert.deepEqual([readiness.status, readiness.mount, readiness.directory, readiness.access], ['degraded', 'not_mounted', 'present', 'read_write']);
      assert.ok(!JSON.stringify(readiness).includes(storageDir), 'no path in the readiness');
      for (const who of ['instructor', 'student']) problem(await call(reported, who, 'GET', '/system/storage'), 403, 'FORBIDDEN');
      problem(await call(reported, null, 'GET', '/system/storage'), 401, 'UNAUTHENTICATED');
      assert.equal((await upload(reported, ids.course, ids.unit, 'report-mode.pdf', 'Uploads continue in report mode')).statusCode, 201);
    } finally {
      await reported.close();
    }
  });

  it('startup: in report mode a storage check that hangs (for example a stalled mount) neither stops nor delays the API', async () => {
    let release: (value: boolean) => void = () => undefined;
    const stalled = makeApp({ DOCUMENT_STORAGE_MOUNT_CHECK: 'report' }, { isMountPoint: () => new Promise<boolean>((resolve) => (release = resolve)) });
    const started = Date.now();
    await stalled.ready();
    try {
      assert.ok(Date.now() - started < 2_000, 'startup did not wait for the storage check');
      assert.equal((await stalled.inject({ method: 'GET', url: '/api/v1/health' })).statusCode, 200);
    } finally {
      release(true);
      await stalled.close();
    }
  });

  it('an unusable storage directory refuses uploads before reading them, without creating the directory', async () => {
    const gone = join(root, 'never-created');
    const missingStorage = makeApp({ DOCUMENT_STORAGE_DIR: gone, DOCUMENT_STORAGE_MOUNT_CHECK: 'report' }, { isMountPoint: mounted });
    await missingStorage.ready();
    try {
      assert.equal(ok(await call(missingStorage, 'admin', 'GET', '/system/storage')).directory, 'missing');
      problem(await upload(missingStorage, ids.course, ids.unit, 'nowhere.pdf', 'Nowhere to store'), 503, 'DOCUMENT_STORAGE_UNAVAILABLE');
      await assert.rejects(stat(gone), 'the directory was not created');
    } finally {
      await missingStorage.close();
    }
  });

  it('audit: reports missing, corrupt, orphaned and unrecognized entries exactly, without false positives, and changes nothing', async () => {
    // An old orphan (left by a failed transaction long ago), a recent one (an upload in flight) and foreign entries.
    const oldOrphan = randomUUID();
    await writeFile(join(storageDir, oldOrphan), 'orphaned bytes');
    const past = new Date(Date.now() - 3 * 3_600_000);
    await utimes(join(storageDir, oldOrphan), past, past);
    await writeFile(join(storageDir, randomUUID()), 'upload in flight');
    await writeFile(join(storageDir, 'notes.txt'), 'not a storage file');
    await mkdir(join(storageDir, 'subdirectory'));
    const dbBefore = await tableFingerprint();
    const filesBefore = await snapshot(storageDir);

    const report = await audit();
    assert.equal(report.status, 'complete', JSON.stringify(report.incompleteReasons));
    const documentCount = (await database.pool.query('SELECT count(*)::int AS n FROM course_documents')).rows[0].n as number;
    assert.equal(report.counts.documents, documentCount);
    assert.deepEqual(
      { missing: report.counts.missing, corrupt: report.counts.corrupt, orphaned: report.counts.orphaned, recent: report.counts.recentUnreferenced, unrecognized: report.counts.unrecognized, readErrors: report.counts.readErrors },
      { missing: 1, corrupt: 1, orphaned: 1, recent: 1, unrecognized: 2, readErrors: 0 },
    );
    assert.equal(report.counts.valid, documentCount - 2, 'every other document is valid: no false positives');
    const byKind = (kind: string) => report.issues.filter((issue) => issue.kind === kind);
    assert.deepEqual(byKind('missing_file').map((i) => (i as { storageKey: string }).storageKey), [keyOf.get(ids.missing)]);
    assert.deepEqual(byKind('corrupt_file').map((i) => [(i as { storageKey: string }).storageKey, (i as { reason: string }).reason]), [[keyOf.get(ids.corrupt), 'sha256']]);
    assert.deepEqual(byKind('orphaned_file').map((i) => (i as { storageKey: string }).storageKey), [oldOrphan]);
    assert.equal(exitCodeFor(report), AUDIT_EXIT.issues);
    // Ids and storage keys only: no file names, contents, paths or people.
    const text = JSON.stringify(report);
    for (const secret of ['Juan Perez', 'private notes', 'notes.txt', 'orphaned bytes', storageDir, 'academiapath.example']) assert.ok(!text.includes(secret), secret);

    assert.equal(await tableFingerprint(), dbBefore, 'the database is unchanged');
    assert.deepEqual(await snapshot(storageDir), filesBefore, 'storage is unchanged (nothing deleted, repaired or touched)');
  });

  it('audit: interrupted, timed-out or unreadable scans are reported as incomplete, never as clean', async () => {
    let report: AuditReport;
    const aborted = new AbortController();
    aborted.abort();
    report = await audit({ signal: aborted.signal });
    assert.deepEqual([report.status, report.incompleteReasons], ['incomplete', ['interrupted']]);
    assert.equal(exitCodeFor(report), AUDIT_EXIT.incomplete);

    let tick = 0;
    report = await audit({ timeLimitMs: 1, now: () => new Date(Date.UTC(2026, 10, 16) + tick++ * 10) });
    assert.deepEqual([report.status, report.incompleteReasons], ['incomplete', ['time_limit']]);

    report = await audit({ storageDir: join(root, 'no-such-store') });
    assert.deepEqual([report.status, report.incompleteReasons, report.counts.missing], ['incomplete', ['storage_directory_unavailable'], 0], 'an absent store is not reported as every file missing');

    if (!isRoot) {
      const unreadable = join(storageDir, keyOf.get(ids.valid)!);
      await chmod(unreadable, 0o000);
      try {
        report = await audit();
        assert.ok(report.incompleteReasons.includes('read_errors'));
        assert.equal(report.status, 'incomplete');
      } finally {
        await chmod(unreadable, 0o600);
      }
    }
  });

  it('audit: refuses production, Cloud Run, the bucket mount and non-local databases before reading anything', async () => {
    const local = { DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/x' };
    assert.equal(auditRefusal(local, '/tmp/store'), null);
    for (const [env, dir] of [
      [{ ...local, NODE_ENV: 'production' }, '/tmp/store'],
      [{ ...local, K_SERVICE: 'academiapath-api' }, '/tmp/store'],
      [{ ...local, CLOUD_RUN_JOB: 'academiapath-seed-demo' }, '/tmp/store'],
      [{ DATABASE_URL: 'postgresql://app:synthetic-pw@10.1.2.3/academiapath' }, '/tmp/store'],
      [{ DATABASE_URL: 'postgresql://app:synthetic-pw@localhost/academiapath?host=/cloudsql/elearning-514315:us-central1:academiapath-db' }, '/tmp/store'],
      [local, '/mnt/documents'],
      [local, 'relative/store'],
      [{}, '/tmp/store'],
    ] as Array<[NodeJS.ProcessEnv, string]>) {
      assert.ok(auditRefusal(env, dir), `refused: ${JSON.stringify({ ...env, DATABASE_URL: env.DATABASE_URL ? 'set' : undefined })} ${dir}`);
    }
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => void errors.push(message);
    try {
      assert.equal(await auditMain([], { NODE_ENV: 'production', DATABASE_URL: 'postgresql://app:synthetic-pw@10.1.2.3/academiapath', DOCUMENT_STORAGE_DIR: '/mnt/documents' }), AUDIT_EXIT.refused);
    } finally {
      console.error = original;
    }
    assert.ok(errors.join(' ').includes('Refusing'));
    assert.ok(!errors.join(' ').includes('synthetic-pw'), 'the database URL is never printed');
  });
});
