/**
 * AP-SEC-05B: signature freshness through the real routes, with the scanner chosen by configuration (MALWARE_SCANNER=
 * clamd at a synthetic clamd daemon on a loopback port) and the API server clock under test control. Checks the
 * strict and compatibility effects of current, aging, stale and unverifiable signatures on document uploads and
 * portable course archive imports, that an infected verdict always wins, that refusals keep nothing (records, stored
 * files, the storage journal, success audits), that the check stays inside the upload's time budget, that warnings
 * are not repeated per upload, and that production behaviour is unchanged. Synthetic data, disposable local
 * PostgreSQL; the only "threat" is the plain-text part of the EICAR antivirus test string.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { exported, type Doc } from '../helpers/archives.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { makePdf, multipartBody } from '../helpers/documents.js';
import { clamdVersionReply, EICAR_MARKER_TEXT, FAKE_SIGNATURE, startFakeClamd, type FakeClamd } from '../helpers/fake-clamd.js';
import { exactPdf } from '../helpers/uploads.js';

const PASSWORD = randomBytes(18).toString('base64url');
const COOKIE = 'ap_session';
const ORIGIN = 'http://localhost:3000';
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const REPOSITORY = resolve(import.meta.dirname, '../../../..');
const MARKER = `Synthetic test marker ${EICAR_MARKER_TEXT} in a document.`;
type App = Awaited<ReturnType<typeof buildApp>>;
type LogLine = { level: number; msg: string; malwareScanning?: { signatures?: Record<string, unknown> } };

describe('malware signature freshness in uploads and archive imports (AP-SEC-05B, PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let daemon: FakeClamd;
  let root: string;
  let storageDir: string;
  let session: { token: string; csrf: string };
  const ids = {} as Record<'program' | 'term' | 'course' | 'section', string>;
  const apps: App[] = [];
  /** The API server clock is the real time plus this offset (session expiry uses the database's own clock). */
  let offset = 0;
  const appNow = () => Date.now() + offset;
  let codes = 0;
  let files = 0;
  const nextCode = () => `SIG-${(codes += 1)}`;
  /** A file nobody uploaded before (an identical repeat would return the earlier document: AP-SEC-05A). */
  const fresh = (label: string) => exactPdf(60_000, `Synthetic ${label} ${(files += 1)}`);
  const infected = () => makePdf([['Synthetic handout', `${MARKER} ${(files += 1)}`]]);

  const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await database.pool.query<T>(text, params)).rows;
  const count = async (text: string, params: unknown[] = []) => Number((await q<{ n: string }>(text, params))[0]!.n);
  /** Everything an accepted upload or import creates, plus the success audits. */
  const state = async () => ({
    documents: await count('SELECT count(*) AS n FROM course_documents'),
    activities: await count('SELECT count(*) AS n FROM activities'),
    summaries: await count('SELECT count(*) AS n FROM document_summaries'),
    courses: await count('SELECT count(*) AS n FROM courses'),
    journal: await count('SELECT count(*) AS n FROM document_storage_intents'),
    successAudits: await count(`SELECT count(*) AS n FROM audit_log WHERE action IN ('document.uploaded', 'activity.created', 'course.imported')`),
    files: (await readdir(storageDir).catch(() => [] as string[])).sort(),
  });
  const lastRejection = async () =>
    (await q<{ metadata: { after: Record<string, any> } }>(`SELECT metadata FROM audit_log WHERE action = 'document.upload_rejected' ORDER BY created_at DESC, id DESC LIMIT 1`))[0]!.metadata.after;

  /** An API instance with clamd at the synthetic daemon and its own log lines. */
  const clamdApp = async (enforcement: 'compatibility' | 'strict', extra: Record<string, string> = {}) => {
    const lines: LogLine[] = [];
    const instance = buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        APP_ORIGINS: ORIGIN,
        LOGIN_RATE_LIMIT_MAX: '1000',
        DOCUMENT_STORAGE_DIR: storageDir,
        DOCUMENT_MAX_UPLOAD_MB: '2',
        ARCHIVE_IMPORT_ENABLED: 'true',
        DOCUMENT_UPLOAD_TIMEOUT_SECONDS: '60',
        MALWARE_SCANNER: 'clamd',
        CLAMD_ADDRESS: `127.0.0.1:${daemon.port}`,
        MALWARE_SCAN_ENFORCEMENT: enforcement,
        MALWARE_SCAN_TIMEOUT_SECONDS: '5',
        ...extra,
      }),
      database: database.db,
      clock: () => new Date(appNow()),
      logger: { level: 'info', stream: { write: (line: string) => void lines.push(JSON.parse(line) as LogLine) } },
    });
    await instance.ready();
    apps.push(instance);
    return { app: instance, lines };
  };
  /** The daemon's daily signatures were built `ageMs` before the API server's current time. */
  const signaturesAged = (ageMs: number) => {
    daemon.version = () => clamdVersionReply(appNow() - ageMs);
  };
  const signatureLogs = (lines: LogLine[], pattern: RegExp) => lines.filter((line) => line.malwareScanning?.signatures && pattern.test(line.msg));
  /** Lets the startup check (which runs in the background) finish, so it does not race the test's own requests. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  const post = (app: App, url: string, parts: Parameters<typeof multipartBody>[0]) => {
    const { payload, contentType } = multipartBody(parts);
    return app.inject({ method: 'POST', url, payload, cookies: { [COOKIE]: session.token }, headers: { 'content-type': contentType, 'x-csrf-token': session.csrf, origin: ORIGIN } });
  };
  const upload = (app: App, data: Buffer, filename = 'handout.pdf') => post(app, `/api/v1/courses/${ids.course}/sections/${ids.section}/documents`, [{ name: 'file', filename, data }]);
  const importArchive = (app: App, archive: Buffer, code: string) =>
    post(app, '/api/v1/course-imports/archive', [
      { name: 'programId', value: ids.program },
      { name: 'termId', value: ids.term },
      { name: 'code', value: code },
      { name: 'file', filename: 'course-archive.zip', contentType: 'application/zip', data: archive },
    ]);
  const scansOf = (code: string) =>
    q<{ malware_scan_status: string; malware_scanner: string }>(
      'SELECT d.malware_scan_status, d.malware_scanner FROM course_documents d JOIN activities a ON a.id = d.activity_id JOIN sections s ON s.id = a.section_id JOIN courses c ON c.id = s.course_id WHERE c.code = $1',
      [code],
    );
  const ok = (res: LightMyRequestResponse, status = 201) => {
    assert.equal(res.statusCode, status, res.body);
    return res.json();
  };
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
    assert.doesNotMatch(res.body, /storage_?key|\/(srv|var|tmp|home|root)\/|EICAR|clamd|127\.0\.0\.1|signature/i, 'no internals in the problem');
    return res.json();
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-signature-freshness-'));
    storageDir = join(root, 'store');
    daemon = await startFakeClamd();
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir }), database: database.db });
    await app.ready();
    apps.push(app);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@academiapath.example', password: PASSWORD }, headers: { origin: ORIGIN } });
    session = { token: login.cookies.find((cookie) => cookie.name === COOKIE)!.value, csrf: ok(login, 200).csrfToken };
    const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
      app.inject({ method, url: `/api/v1${url}`, ...(payload ? { payload } : {}), cookies: { [COOKIE]: session.token }, headers: { 'x-csrf-token': session.csrf, origin: ORIGIN } });
    ids.program = ok(await call('POST', '/programs', { code: 'SIG', name: 'Signature freshness' })).id;
    ids.term = ok(await call('POST', '/terms', { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' })).id;
    const template = ok(await call('POST', '/course-templates', { code: 'SIG-T', programId: ids.program, title: 'Freshness course', sections: [{ title: 'Unit 1' }] })).templateId;
    ids.course = ok(await call('POST', '/courses', { programId: ids.program, termId: ids.term, templateId: template, code: 'SIG-SRC', status: 'published' })).id;
    ids.section = ok(await call('GET', `/courses/${ids.course}/sections`), 200).items[0].id;
  });

  after(async () => {
    for (const app of apps) await app.close();
    await daemon?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('strict: current and aging signatures verify a clean upload; the warning is logged once, not per upload', async () => {
    daemon.reset();
    offset = 0;
    signaturesAged(HOUR);
    const current = await clamdApp('strict');
    await settle();
    assert.deepEqual(ok(await upload(current.app, fresh('current'))).document.malwareScan, { status: 'clean', scanner: 'clamd' });
    const [startup] = signatureLogs(current.lines, /signatures are current/);
    assert.ok(startup, 'the startup check logs the state');
    assert.equal(startup.malwareScanning!.signatures!.state, 'current');
    assert.equal(startup.malwareScanning!.signatures!.databaseVersion, 27001);

    daemon.reset();
    signaturesAged(50 * HOUR);
    const aging = await clamdApp('strict');
    await settle();
    for (let i = 0; i < 3; i += 1) assert.deepEqual(ok(await upload(aging.app, fresh('aging'))).document.malwareScan, { status: 'clean', scanner: 'clamd' });
    // A minute later the daemon is asked again, still aging: no new warning.
    offset += 61_000;
    assert.equal(ok(await upload(aging.app, fresh('aging later'))).document.malwareScan.status, 'clean');
    assert.equal(daemon.versionRequests, 2, 'one check at startup, one after the reuse window');
    assert.equal(signatureLogs(aging.lines, /signatures are aging/).length, 1, 'one warning');
    // An hour later the warning is repeated once.
    offset += HOUR;
    assert.equal(ok(await upload(aging.app, fresh('aging an hour later'))).document.malwareScan.status, 'clean');
    const warnings = signatureLogs(aging.lines, /signatures are aging/);
    assert.equal(warnings.length, 2, 'repeated after an hour');
    assert.ok(warnings.every((line) => line.level === 40), 'warning level');
    offset = 0;
  });

  it('strict: stale or unverifiable signatures refuse the upload (503 MALWARE_SCAN_UNAVAILABLE): nothing stored, no success audit', async () => {
    const cases: Array<[string, () => void, string]> = [
      ['stale (8 days)', () => signaturesAged(8 * DAY), 'signatures_stale'],
      ['exactly 7 days', () => signaturesAged(7 * DAY + 1_000), 'signatures_stale'],
      ['no signature date', () => void (daemon.version = 'ClamAV 1.5.4'), 'signatures_unverified'],
      ['VERSION disabled', () => void (daemon.version = 'COMMAND UNAVAILABLE'), 'signatures_unverified'],
      ['malformed', () => void (daemon.version = 'ClamAV 1.5.4/27001/someday'), 'signatures_unverified'],
      ['future date', () => signaturesAged(-2 * HOUR), 'signatures_unverified'],
      ['disconnected', () => void (daemon.version = 'close'), 'signatures_unverified'],
    ];
    for (const [label, arrange, reason] of cases) {
      daemon.reset();
      arrange();
      const { app, lines } = await clamdApp('strict');
      await settle();
      const before = await state();
      const body = problem(await upload(app, fresh(label)), 503, 'MALWARE_SCAN_UNAVAILABLE');
      assert.equal(body.detail, 'The file could not be checked for malware right now, so it was not accepted. Try again later.');
      assert.deepEqual(await state(), before, `${label}: no record, file, journal entry or success audit`);
      assert.deepEqual((await lastRejection()).malwareScan, { scanner: 'clamd', status: 'error', reason }, `${label}: the refusal is audited with its reason`);
      assert.equal(daemon.streams.length, 1, `${label}: the file itself was scanned`);
      assert.equal(signatureLogs(lines, /stale|cannot be verified/).length, 1, `${label}: one error log, from the startup check`);
    }
  });

  it('strict: a check that does not answer stays inside the scan’s share of the upload budget', async () => {
    daemon.reset();
    daemon.version = 'hang';
    const { app } = await clamdApp('strict', { MALWARE_SCAN_TIMEOUT_SECONDS: '1', DOCUMENT_UPLOAD_TIMEOUT_SECONDS: '25' });
    const before = await state();
    const started = Date.now();
    problem(await upload(app, fresh('hanging check')), 503, 'MALWARE_SCAN_UNAVAILABLE');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3_000, `ended by the 1 s scan deadline, far inside the 25 s budget (${elapsed} ms)`);
    assert.deepEqual(await state(), before);
    assert.deepEqual((await lastRejection()).malwareScan, { scanner: 'clamd', status: 'timeout', reason: 'deadline' });
  });

  it('an infected verdict always wins, with current, stale or unverifiable signatures, in both modes (422 MALWARE_DETECTED)', async () => {
    for (const enforcement of ['strict', 'compatibility'] as const) {
      for (const [label, arrange] of [
        ['current', () => signaturesAged(HOUR)],
        ['stale', () => signaturesAged(30 * DAY)],
        ['no date', () => void (daemon.version = 'ClamAV 1.5.4')],
      ] as const) {
        daemon.reset();
        arrange();
        const { app } = await clamdApp(enforcement);
        const before = await state();
        problem(await upload(app, infected(), 'eicar.pdf'), 422, 'MALWARE_DETECTED');
        assert.deepEqual(await state(), before, `${enforcement}/${label}: nothing kept`);
        assert.deepEqual((await lastRejection()).malwareScan, { scanner: 'clamd', signature: FAKE_SIGNATURE }, `${enforcement}/${label}`);
      }
    }
  });

  it('compatibility: stale or unverifiable signatures keep the upload as not_scanned with the reason, never clean', async () => {
    for (const [label, arrange, scanner] of [
      ['stale', () => signaturesAged(8 * DAY), 'clamd:signatures_stale'],
      ['no date', () => void (daemon.version = 'ClamAV 1.5.4'), 'clamd:signatures_unverified'],
      ['future date', () => signaturesAged(-HOUR), 'clamd:signatures_unverified'],
    ] as const) {
      daemon.reset();
      arrange();
      const { app } = await clamdApp('compatibility');
      const body = ok(await upload(app, fresh(label)));
      assert.deepEqual(body.document.malwareScan, { status: 'not_scanned', scanner }, label);
      const [row] = await q<{ malware_scan_status: string; malware_scanner: string }>('SELECT malware_scan_status, malware_scanner FROM course_documents WHERE id = $1', [body.document.id]);
      assert.deepEqual(row, { malware_scan_status: 'not_scanned', malware_scanner: scanner });
    }
    daemon.reset();
    signaturesAged(3 * DAY);
    const aging = ok(await upload((await clamdApp('compatibility')).app, fresh('aging compatible')));
    assert.deepEqual(aging.document.malwareScan, { status: 'clean', scanner: 'clamd' }, 'aging is still a verdict');
    assert.equal(await count(`SELECT count(*) AS n FROM course_documents WHERE malware_scan_status = 'clean' AND malware_scanner <> 'clamd'`), 0, 'no false clean');
  });

  it('compatibility: documents stored before are never relabeled', async () => {
    daemon.reset();
    const plainApp = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: storageDir, DOCUMENT_MAX_UPLOAD_MB: '2' }), database: database.db });
    await plainApp.ready();
    apps.push(plainApp);
    const plain = ok(await upload(plainApp, fresh('stored without a scanner')));
    assert.deepEqual(plain.document.malwareScan, { status: 'not_scanned', scanner: 'none' });
    signaturesAged(8 * DAY);
    const { app } = await clamdApp('compatibility');
    ok(await upload(app, fresh('stale afterwards')));
    const [row] = await q<{ malware_scan_status: string; malware_scanner: string }>('SELECT malware_scan_status, malware_scanner FROM course_documents WHERE id = $1', [plain.document.id]);
    assert.deepEqual(row, { malware_scan_status: 'not_scanned', malware_scanner: 'none' });
  });

  it('archive import, strict: stale or unverifiable signatures import nothing (503 ARCHIVE_IMPORT_SCAN_UNAVAILABLE)', async () => {
    const archive = await exported();
    for (const [label, arrange] of [
      ['stale', () => signaturesAged(8 * DAY)],
      ['no date', () => void (daemon.version = 'ClamAV 1.5.4')],
    ] as const) {
      daemon.reset();
      arrange();
      const { app } = await clamdApp('strict');
      const before = await state();
      const code = nextCode();
      problem(await importArchive(app, archive, code), 503, 'ARCHIVE_IMPORT_SCAN_UNAVAILABLE');
      assert.deepEqual(await state(), before, `${label}: no course, document, file, journal entry or audit`);
      assert.equal(await count('SELECT count(*) AS n FROM courses WHERE code = $1', [code]), 0);
    }
    // Current signatures: the same archive imports, every document clean.
    daemon.reset();
    signaturesAged(HOUR);
    const code = nextCode();
    const imported = ok(await importArchive((await clamdApp('strict')).app, archive, code));
    const rows = await scansOf(code);
    assert.equal(rows.length, imported.created.documents);
    for (const row of rows) assert.deepEqual(row, { malware_scan_status: 'clean', malware_scanner: 'clamd' });
  });

  it('archive import, compatibility: stale signatures import documents as not_scanned; an infected one still imports nothing', async () => {
    daemon.reset();
    signaturesAged(8 * DAY);
    const code = nextCode();
    const imported = ok(await importArchive((await clamdApp('compatibility')).app, await exported(), code));
    const rows = await scansOf(code);
    assert.equal(rows.length, imported.created.documents);
    for (const row of rows) assert.deepEqual(row, { malware_scan_status: 'not_scanned', malware_scanner: 'clamd:signatures_stale' });
    assert.equal(await count('SELECT count(*) AS n FROM document_storage_intents'), 0, 'the storage journal is settled');

    // Documents are scanned in order and the import stops at the first one refused. An infected document is refused as
    // infected in both modes; in strict mode a clean document before it, unverifiable with stale signatures, already
    // stops the import (503). Either way nothing is imported.
    const cleanDoc: Doc = { name: 'clean.pdf', title: 'Clean', format: 'pdf', bytes: fresh('archive clean') };
    const infectedDoc: Doc = { name: 'eicar.pdf', title: 'Marked', format: 'pdf', bytes: infected() };
    for (const [enforcement, docs, status, code] of [
      ['compatibility', [infectedDoc, cleanDoc], 422, 'ARCHIVE_IMPORT_DOCUMENT_REJECTED'],
      ['strict', [infectedDoc, cleanDoc], 422, 'ARCHIVE_IMPORT_DOCUMENT_REJECTED'],
      ['compatibility', [cleanDoc, infectedDoc], 422, 'ARCHIVE_IMPORT_DOCUMENT_REJECTED'],
      ['strict', [cleanDoc, infectedDoc], 503, 'ARCHIVE_IMPORT_SCAN_UNAVAILABLE'],
    ] as const) {
      daemon.reset();
      signaturesAged(8 * DAY);
      const before = await state();
      const res = await importArchive((await clamdApp(enforcement)).app, await exported([...docs]), nextCode());
      problem(res, status, code);
      if (status === 422) assert.match(res.json().detail, /MALWARE_DETECTED/);
      assert.deepEqual(await state(), before, `${enforcement}: nothing was imported`);
    }
  });

  it('logs carry the signature state, never the daemon’s address, file names or contents', async () => {
    const lines: string[] = [];
    daemon.reset();
    signaturesAged(9 * DAY);
    const instance = buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        APP_ORIGINS: ORIGIN,
        DOCUMENT_STORAGE_DIR: storageDir,
        DOCUMENT_MAX_UPLOAD_MB: '2',
        DOCUMENT_UPLOAD_TIMEOUT_SECONDS: '60',
        MALWARE_SCANNER: 'clamd',
        CLAMD_ADDRESS: `127.0.0.1:${daemon.port}`,
        MALWARE_SCAN_ENFORCEMENT: 'strict',
      }),
      database: database.db,
      logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } },
    });
    await instance.ready();
    apps.push(instance);
    await settle();
    problem(await upload(instance, infected(), 'eicar.pdf'), 422, 'MALWARE_DETECTED');
    problem(await upload(instance, fresh('logged'), 'secret-name.pdf'), 503, 'MALWARE_SCAN_UNAVAILABLE');
    const text = lines.join('\n');
    assert.match(text, /clamd signatures are stale/);
    assert.match(text, /"ageHours":216/);
    assert.doesNotMatch(text, new RegExp(`127\\.0\\.0\\.1:${daemon.port}|"port":${daemon.port}\\b|CLAMD_ADDRESS|socketPath|endpoint`), 'no connection details');
    assert.doesNotMatch(text, new RegExp(EICAR_MARKER_TEXT), 'no file content');
    assert.doesNotMatch(text, /eicar\.pdf|secret-name\.pdf/, 'no file names');
  });

  it('the refusal messages exist in English and Spanish for the web app', async () => {
    const catalog = await readFile(join(REPOSITORY, 'apps/web/src/lib/i18n/catalog/errors.ts'), 'utf8');
    for (const code of ['MALWARE_SCAN_UNAVAILABLE', 'ARCHIVE_IMPORT_SCAN_UNAVAILABLE', 'MALWARE_DETECTED']) {
      const entries = [...catalog.matchAll(new RegExp(`^\\s+${code}: '([^']+)'`, 'gm'))].map((match) => match[1]!);
      assert.equal(entries.length, 2, `${code}: one English and one Spanish message`);
      assert.match(entries[0]!, /malware/i, `${code}: English`);
      assert.match(entries[1]!, /\b(no se|se rechaz|archivo|documento)\b/i, `${code}: Spanish`);
    }
  });

  it('production is unchanged: no scanner unless configured, the deploy workflow configures none, archive import stays off', async () => {
    const production = { NODE_ENV: 'production', APP_ORIGINS: 'https://example.edu', DOCUMENT_STORAGE_DIR: '/mnt/documents' };
    const scanning = loadConfig(production).malwareScanning;
    assert.equal(scanning.scanner, 'none');
    assert.equal(scanning.enforcement, 'compatibility');
    assert.throws(() => loadConfig({ ...production, MALWARE_SIGNATURES_STALE_HOURS: '72' }), /only with MALWARE_SCANNER=clamd/);
    assert.throws(() => loadConfig({ ...production, ARCHIVE_IMPORT_ENABLED: 'true' }), /ARCHIVE_IMPORT_ENABLED cannot be true in production/);
    const deploy = await readFile(join(REPOSITORY, '.github/workflows/deploy.yml'), 'utf8');
    assert.doesNotMatch(deploy, /MALWARE_|CLAMD_|clamav/i, 'the deploy workflow neither configures nor deploys a scanner');
    const cloudRun = await readFile(join(REPOSITORY, 'infra/cloud-run.env.example'), 'utf8');
    assert.doesNotMatch(cloudRun, /^\s*(MALWARE_SCANNER|CLAMD_SOCKET|CLAMD_ADDRESS)\s*=/m, 'no active scanner setting in the Cloud Run example');
  });
});
