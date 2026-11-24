/**
 * AP-SEC-05A: document upload time budget, cancellation and repeated submissions. Uploads travel over real HTTP through
 * the web app's own proxy code (Next.js `proxyRequest`, resolved from apps/web, as `next start` runs it in front of
 * the API), with controlled delays and failures in the scanner, extraction and storage. Disposable PostgreSQL,
 * synthetic files.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseUrl } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { programs, terms, users } from '../../src/db/schema/index.js';
import { ClamdScanner } from '../../src/documents/clamd.js';
import { ExtractionAborted, extractInWorker } from '../../src/documents/extraction.js';
import type { MalwareScanner, MalwareScanResult } from '../../src/documents/scanner.js';
import { LocalDocumentStorage, type DocumentStorage } from '../../src/documents/storage.js';
import { recoverAbandonedStorageWrites } from '../../src/documents/storage-recovery.js';
import { mockSummaryProvider, type DocumentSummaryProvider } from '../../src/documents/summary.js';
import { createSlots, SlotWaitAborted } from '../../src/workers/isolated.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { makePdf, multipartBody } from '../helpers/documents.js';
import { startFakeClamd } from '../helpers/fake-clamd.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const webRequire = createRequire(fileURLToPath(new URL('../../../web/package.json', import.meta.url)));
/** The web app's own rewrite proxy (Next.js), exactly as `next start` runs it for /api/*. */
const { proxyRequest } = webRequire('next/dist/server/lib/router-utils/proxy-request.js') as {
  proxyRequest: (req: IncomingMessage, res: unknown, parsedUrl: ReturnType<typeof parseUrl>, upgradeHead: undefined, reqBody: unknown, proxyTimeout: number) => Promise<unknown>;
};

/** Waits like a slow dependency; stops early (rejecting) when `signal` aborts, unless `ignoreSignal`. */
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))), { once: true });
  });

describe('document upload time budget, cancellation and repeated submissions (AP-SEC-05A, PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let storageDir: string;
  let local: LocalDocumentStorage;
  let session: { token: string; csrf: string };
  const ids = {} as Record<'admin' | 'program' | 'term' | 'course' | 'section', string>;
  const servers: Array<{ close: () => Promise<void> }> = [];
  /** What the simulated dependencies do in the next request(s). */
  const control = {
    scanDelayMs: 0,
    scanIgnoresBudget: false,
    scanResult: null as MalwareScanResult | null,
    scanThrows: false,
    extractDelayMs: 0,
    extractIgnoresSignal: false,
    putDelayMs: 0,
    putFails: false,
    removeFails: false,
    duringPut: null as null | (() => Promise<void>),
    onScan: null as null | (() => void),
    onSummarize: null as null | (() => void),
    summaryDelayMs: 0,
    calls: { scan: 0, extract: 0, put: 0 },
  };
  beforeEach(() => {
    Object.assign(control, { scanDelayMs: 0, scanIgnoresBudget: false, scanResult: null, scanThrows: false, extractDelayMs: 0, extractIgnoresSignal: false, putDelayMs: 0, putFails: false, removeFails: false, duringPut: null, onScan: null, onSummarize: null, summaryDelayMs: 0 });
    control.calls = { scan: 0, extract: 0, put: 0 };
  });

  const scanner: MalwareScanner = {
    name: 'test-scanner',
    async scan(_bytes, _file, options) {
      control.calls.scan += 1;
      control.onScan?.();
      if (control.scanThrows) throw new Error('scanner defect');
      if (control.scanDelayMs) await wait(control.scanDelayMs, control.scanIgnoresBudget ? undefined : options?.signal).catch(() => undefined);
      return control.scanResult ?? { status: 'clean', scanner: 'test-scanner' };
    },
  };
  /** The real isolated extraction, after a controlled delay that honours the caller's time limit and signal like it. */
  const extract: typeof extractInWorker = async (bytes, format, timeoutMs, signal) => {
    control.calls.extract += 1;
    if (control.extractDelayMs) {
      if (control.extractDelayMs >= timeoutMs) {
        // Like the worker's own timer firing at the time limit it was given (just before the caller's abort).
        await wait(timeoutMs, control.extractIgnoresSignal ? undefined : signal).catch(() => {
          throw new ExtractionAborted();
        });
        return { ok: false, code: 'DOCUMENT_LIMITS_EXCEEDED', message: `Processing the document took longer than ${Math.round(timeoutMs / 1000)} seconds.` };
      }
      await wait(control.extractDelayMs, signal).catch(() => {
        throw new ExtractionAborted();
      });
    }
    return extractInWorker(bytes, format, timeoutMs, signal);
  };
  /** The mock summary provider, after a controlled delay (the last step before storing). */
  const provider: DocumentSummaryProvider = {
    ...mockSummaryProvider,
    summarize: async (input) => {
      control.onSummarize?.();
      if (control.summaryDelayMs) await sleep(control.summaryDelayMs);
      return mockSummaryProvider.summarize(input);
    },
  };
  const storage = (): DocumentStorage => ({
    put: async (bytes, key) => {
      control.calls.put += 1;
      if (control.duringPut) await control.duringPut();
      if (control.putDelayMs) await sleep(control.putDelayMs);
      if (control.putFails) {
        await local.put(Buffer.from(bytes).subarray(0, 100), key); // part of the file was written
        throw Object.assign(new Error('simulated write failure'), { code: 'EIO' });
      }
      return local.put(bytes, key);
    },
    read: (key) => local.read(key),
    remove: (key) => (control.removeFails ? Promise.reject(Object.assign(new Error('simulated remove failure'), { code: 'EIO' })) : local.remove(key)),
    exists: (key) => local.exists(key),
  });

  const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await database.pool.query<T>(text, params)).rows;
  const count = async (text: string, params: unknown[] = []) => Number((await q<{ n: string }>(text, params))[0]!.n);
  const documentsNamed = (fileName: string) => count('SELECT count(*) AS n FROM course_documents WHERE file_name = $1', [fileName]);
  const audits = (action: string) => count('SELECT count(*) AS n FROM audit_log WHERE action = $1', [action]);
  const journal = () => count('SELECT count(*) AS n FROM document_storage_intents');
  const unreferenced = async () => {
    const known = new Set((await q<{ storage_key: string }>('SELECT storage_key FROM course_documents')).map((row) => row.storage_key));
    return (await readdir(storageDir).catch(() => [] as string[])).filter((name) => !known.has(name));
  };
  const until = async (condition: () => Promise<boolean>, label: string, ms = 10_000) => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      if (await condition()) return;
      await sleep(25);
    }
    assert.fail(`timed out waiting for: ${label}`);
  };
  const assertNothingLeft = async (label: string) => {
    assert.equal(await journal(), 0, `${label}: no journal entry left`);
    assert.deepEqual(await unreferenced(), [], `${label}: no stored file without a document`);
  };

  type Budget = { uploadMs: number; reserveMs: number; scanMs?: number; extractionMs?: number; enforcement?: 'compatibility' | 'strict' };
  /** An API on a real port, configured with a (short) budget, behind the web app's proxy with `proxyMs`. */
  const stack = async (budget: Budget, proxyMs: number) => {
    const base = loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir });
    const config: AppConfig = {
      ...base,
      documents: { ...base.documents, uploadTimeoutMs: budget.uploadMs, uploadReserveMs: budget.reserveMs, extractionTimeoutMs: budget.extractionMs ?? base.documents.extractionTimeoutMs },
      malwareScanning: { ...base.malwareScanning, enforcement: budget.enforcement ?? 'compatibility', timeoutMs: budget.scanMs ?? base.malwareScanning.timeoutMs },
    };
    const app = buildApp({ config, database: database.db, documents: { storage: storage(), scanner, extract, provider } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const apiPort = (app.server.address() as { port: number }).port;
    const proxy: Server = createServer((req, res) => {
      void proxyRequest(req, res, parseUrl(`http://127.0.0.1:${apiPort}${req.url}`), undefined, req, proxyMs).catch(() => undefined);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const close = async () => {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await app.close();
    };
    servers.push({ close });
    return { port: (proxy.address() as { port: number }).port, close };
  };
  /** One browser-like upload through the proxy. `abortAfterMs` disconnects the client then. */
  const upload = (port: number, file: Buffer, options: { fileName?: string; title?: string; sectionId?: string; abortAfterMs?: number; abortWhen?: Promise<void> } = {}) => {
    const parts = [...(options.title ? [{ name: 'title', value: options.title }] : []), { name: 'file', filename: options.fileName ?? 'notes.pdf', data: file }];
    const { payload, contentType } = multipartBody(parts);
    return new Promise<{ status: number; body: string; json: any; ms: number } | { aborted: true; ms: number }>((resolve) => {
      const started = Date.now();
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/api/v1/courses/${ids.course}/sections/${options.sectionId ?? ids.section}/documents`,
          headers: { 'content-type': contentType, 'content-length': payload.length, cookie: `ap_session=${session.token}`, 'x-csrf-token': session.csrf, origin: ORIGIN },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            let json: unknown = null;
            try {
              json = JSON.parse(body);
            } catch {
              json = null;
            }
            resolve({ status: res.statusCode ?? 0, body, json, ms: Date.now() - started });
          });
        },
      );
      req.on('error', () => resolve({ aborted: true, ms: Date.now() - started }));
      if (options.abortAfterMs !== undefined) setTimeout(() => req.destroy(), options.abortAfterMs);
      void options.abortWhen?.then(() => req.destroy());
      req.end(payload);
    });
  };
  const answered = (result: Awaited<ReturnType<typeof upload>>) => {
    assert.ok(!('aborted' in result), 'the client got an answer');
    return result as { status: number; body: string; json: any; ms: number };
  };
  /** A different synthetic PDF every time (an identical repeat is, by design, a replay). */
  const freshPdf = (label = 'notes') => makePdf([['Synthetic notes', `${label} ${randomBytes(6).toString('hex')}`]]);

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-upload-timeouts-'));
    storageDir = join(root, 'store');
    local = new LocalDocumentStorage(storageDir, { createRoot: true });
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    ids.admin = (await database.db.select({ id: users.id }).from(users).where(and(eq(users.systemRole, 'administrator'), eq(users.isActive, true))))[0]!.id;
    const app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir }), database: database.db });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@academiapath.example', password: PASSWORD }, headers: { origin: ORIGIN } });
    session = { token: login.cookies.find((c) => c.name === 'ap_session')!.value, csrf: login.json().csrfToken };
    const call = async (method: 'GET' | 'POST', url: string, payload?: object) =>
      (await app.inject({ method, url: `/api/v1${url}`, ...(payload ? { payload } : {}), cookies: { ap_session: session.token }, headers: { 'x-csrf-token': session.csrf, origin: ORIGIN } })).json();
    ids.program = (await database.db.insert(programs).values({ code: 'UTO', name: 'Upload timeouts' }).returning({ id: programs.id }))[0]!.id;
    ids.term = (await database.db.insert(terms).values({ code: '2026-2', name: '2026-II', academicYear: 2026, startsOn: '2026-08-17', endsOn: '2026-12-11' }).returning({ id: terms.id }))[0]!.id;
    const template = (await call('POST', '/course-templates', { code: 'UTO-T', programId: ids.program, title: 'Upload timeouts course', sections: [{ title: 'Unit 1' }] })).templateId;
    ids.course = (await call('POST', '/courses', { programId: ids.program, termId: ids.term, templateId: template, code: 'UTO-1', status: 'published' })).id;
    ids.section = (await call('GET', `/courses/${ids.course}/sections`)).items[0].id;
    await app.close();
  });

  after(async () => {
    for (const server of servers) await server.close().catch(() => undefined);
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('a normal upload through the proxy is stored once and its journal entry settled', async () => {
    const { port } = await stack({ uploadMs: 10_000, reserveMs: 1_000 }, 11_000);
    const result = answered(await upload(port, freshPdf(), { fileName: 'normal.pdf' }));
    assert.equal(result.status, 201, result.body);
    assert.deepEqual(result.json.document.malwareScan, { status: 'clean', scanner: 'test-scanner' });
    assert.equal(await documentsNamed('normal.pdf'), 1);
    await assertNothingLeft('normal');
  });

  it('delayed scanning: within the budget it is waited for; past its limit it is never a clean verdict', async () => {
    const { port } = await stack({ uploadMs: 10_000, reserveMs: 1_000, scanMs: 400 }, 11_000);
    control.scanDelayMs = 150;
    assert.equal(answered(await upload(port, freshPdf(), { fileName: 'slow-scan.pdf' })).status, 201);
    // The scanner does not answer within its own limit (and does not even stop): compatibility keeps the upload as
    // not_scanned, naming the timeout; strict refuses it. Never clean.
    control.scanDelayMs = 5_000;
    control.scanIgnoresBudget = true;
    const kept = answered(await upload(port, freshPdf(), { fileName: 'hung-scan.pdf' }));
    assert.equal(kept.status, 201, kept.body);
    assert.deepEqual(kept.json.document.malwareScan, { status: 'not_scanned', scanner: 'test-scanner:timeout' });
    assert.ok(kept.ms < 4_500, `answered without waiting for the 5 s scanner (${kept.ms} ms)`);
    const strict = await stack({ uploadMs: 10_000, reserveMs: 1_000, scanMs: 400, enforcement: 'strict' }, 11_000);
    const refused = answered(await upload(strict.port, freshPdf(), { fileName: 'hung-scan-strict.pdf' }));
    assert.deepEqual([refused.status, refused.json?.code], [503, 'MALWARE_SCAN_UNAVAILABLE']);
    assert.equal(await documentsNamed('hung-scan-strict.pdf'), 0);
    await assertNothingLeft('delayed scanning');
  });

  it('a scan or an extraction that would outlast the budget ends with 503 UPLOAD_TIMEOUT from the API, before the proxy times out; nothing is stored', async () => {
    const { port } = await stack({ uploadMs: 1_500, reserveMs: 300, scanMs: 20_000, extractionMs: 20_000 }, 2_500);
    for (const [label, setup] of [
      ['scan', () => ((control.scanDelayMs = 10_000), (control.scanIgnoresBudget = true))],
      ['extraction', () => (control.extractDelayMs = 10_000)],
      // The extraction's own time limit (the remaining budget) ends it a moment before the budget does: still the
      // budget's timeout, not a problem with the file.
      ['extraction-limit', () => ((control.extractDelayMs = 10_000), (control.extractIgnoresSignal = true))],
    ] as const) {
      control.scanDelayMs = 0;
      control.scanIgnoresBudget = false;
      control.extractDelayMs = 0;
      control.extractIgnoresSignal = false;
      setup();
      const before = await audits('document.upload_rejected');
      const result = answered(await upload(port, freshPdf(), { fileName: `budget-${label}.pdf` }));
      assert.deepEqual([result.status, result.json?.code], [503, 'UPLOAD_TIMEOUT'], `${label}: the API's own answer, not the proxy's 500`);
      assert.ok(result.ms < 2_500, `${label}: answered within the budget (${result.ms} ms)`);
      assert.equal(await documentsNamed(`budget-${label}.pdf`), 0, `${label}: nothing created`);
      assert.equal(await audits('document.upload_rejected'), before + 1, `${label}: the refusal is audited`);
    }
    assert.equal(control.calls.put, 0, 'storing never started');
    await assertNothingLeft('budget');
  });

  it('a client that disconnects before storing: nothing is stored, later stages do not run, and the abandonment is audited', async () => {
    const { port } = await stack({ uploadMs: 10_000, reserveMs: 1_000 }, 11_000);
    // The client disconnects while its file is being scanned.
    let scanning!: () => void;
    const scanStarted = new Promise<void>((resolve) => (scanning = resolve));
    control.onScan = () => scanning();
    control.scanDelayMs = 2_000;
    const abandoned = await audits('document.upload_abandoned');
    const result = await upload(port, freshPdf(), { fileName: 'gone-early.pdf', abortWhen: scanStarted });
    assert.ok('aborted' in result);
    await until(async () => (await audits('document.upload_abandoned')) === abandoned + 1, 'the abandonment audit');
    assert.deepEqual([control.calls.extract, control.calls.put], [0, 0], 'neither extraction nor storing ran');
    assert.equal(await documentsNamed('gone-early.pdf'), 0);
    // The same just before storing (while the summary is prepared): still nothing stored.
    control.onScan = null;
    control.scanDelayMs = 0;
    let summarizing!: () => void;
    const summaryStarted = new Promise<void>((resolve) => (summarizing = resolve));
    control.onSummarize = () => summarizing();
    control.summaryDelayMs = 500;
    const result2 = await upload(port, freshPdf(), { fileName: 'gone-before-storing.pdf', abortWhen: summaryStarted });
    assert.ok('aborted' in result2);
    await until(async () => (await audits('document.upload_abandoned')) === abandoned + 2, 'the second abandonment audit');
    const [stage] = await q<{ stage: string }>(`SELECT metadata->'after'->>'stage' AS stage FROM audit_log WHERE action = 'document.upload_abandoned' ORDER BY created_at DESC LIMIT 1`);
    assert.equal(stage!.stage, 'before_storage');
    assert.equal(control.calls.put, 0, 'storing never started');
    assert.equal(await documentsNamed('gone-before-storing.pdf'), 0);
    await assertNothingLeft('client gone before storing');
  });

  it('a client that disconnects while the document is stored: it is committed once, and a retry returns it (200) without processing it again', async () => {
    const { port } = await stack({ uploadMs: 10_000, reserveMs: 1_500 }, 11_000);
    // The client disconnects as soon as the file is being written.
    let storing!: () => void;
    const storingStarted = new Promise<void>((resolve) => (storing = resolve));
    control.duringPut = async () => storing();
    control.putDelayMs = 800;
    const file = freshPdf();
    const result = await upload(port, file, { fileName: 'gone-late.pdf', abortWhen: storingStarted });
    assert.ok('aborted' in result);
    await until(async () => (await documentsNamed('gone-late.pdf')) === 1, 'the committed document');
    await assertNothingLeft('client gone while storing');
    const [stored] = await q<{ id: string }>('SELECT id FROM course_documents WHERE file_name = $1', ['gone-late.pdf']);
    control.putDelayMs = 0;
    control.duringPut = null;
    const scansBefore = control.calls.scan;
    const replayed = await audits('document.upload_replayed');
    const retry = answered(await upload(port, file, { fileName: 'gone-late.pdf' }));
    assert.equal(retry.status, 200, retry.body);
    assert.equal(retry.json.document.id, stored!.id, 'the same document');
    assert.equal(control.calls.scan, scansBefore, 'not scanned, extracted or stored again');
    assert.equal(await documentsNamed('gone-late.pdf'), 1);
    assert.equal(await audits('document.upload_replayed'), replayed + 1);
    await assertNothingLeft('retry');
  });

  it('when the proxy times out first (budget misconfigured above it), the API notices the disconnect and stores nothing', async () => {
    const { port } = await stack({ uploadMs: 6_000, reserveMs: 300 }, 1_000);
    control.scanDelayMs = 3_000;
    const result = answered(await upload(port, freshPdf(), { fileName: 'proxy-cut.pdf' }));
    assert.deepEqual([result.status, result.body], [500, 'Internal Server Error'], "the proxy's own answer");
    await until(async () => (await audits('document.upload_abandoned')) > 0 && control.calls.scan > 0, 'the API to stop');
    await sleep(200);
    assert.deepEqual([control.calls.extract, control.calls.put], [0, 0]);
    assert.equal(await documentsNamed('proxy-cut.pdf'), 0);
    await assertNothingLeft('proxy timeout');
  });

  it('a repeated submission after a proxy timeout during storing creates no duplicate', async () => {
    // A consistent budget (8 s, below the proxy's 8.5 s), but storing stalls far beyond its reserve: the proxy gives up
    // although the upload completes.
    const { port } = await stack({ uploadMs: 8_000, reserveMs: 1_000 }, 8_500);
    control.putDelayMs = 10_000;
    const file = freshPdf();
    const first = answered(await upload(port, file, { fileName: 'retry.pdf' }));
    assert.equal(first.status, 500, 'the user saw a failure');
    await until(async () => (await documentsNamed('retry.pdf')) === 1, 'the first attempt to commit');
    control.putDelayMs = 0;
    const second = answered(await upload(port, file, { fileName: 'retry.pdf' }));
    assert.equal(second.status, 200, second.body);
    assert.equal(await documentsNamed('retry.pdf'), 1, 'exactly one document');
    // A different title or a different file is a new document.
    assert.equal(answered(await upload(port, file, { fileName: 'retry.pdf', title: 'Another title' })).status, 201);
    assert.equal(answered(await upload(port, freshPdf(), { fileName: 'retry.pdf' })).status, 201);
    assert.equal(await documentsNamed('retry.pdf'), 3);
    await assertNothingLeft('retry after timeout');
  });

  it('identical submissions at the same time create exactly one document', async () => {
    const { port } = await stack({ uploadMs: 20_000, reserveMs: 2_000 }, 21_000);
    control.putDelayMs = 300;
    const file = freshPdf();
    const results = (await Promise.all([1, 2, 3].map(() => upload(port, file, { fileName: 'twins.pdf' })))).map(answered);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 201]);
    assert.equal(new Set(results.map((r) => r.json.document.id)).size, 1, 'all answers name the same document');
    assert.equal(await documentsNamed('twins.pdf'), 1);
    await assertNothingLeft('concurrent identical uploads');
  });

  it('failed scanner: strict refuses, compatibility keeps not_scanned, a scanner defect stores nothing; never clean', async () => {
    const compatibility = await stack({ uploadMs: 10_000, reserveMs: 1_000 }, 11_000);
    control.scanResult = { status: 'unavailable', scanner: 'test-scanner', reason: 'connect_failed' };
    const kept = answered(await upload(compatibility.port, freshPdf(), { fileName: 'scanner-down.pdf' }));
    assert.deepEqual([kept.status, kept.json.document.malwareScan], [201, { status: 'not_scanned', scanner: 'test-scanner:unavailable' }]);
    const strict = await stack({ uploadMs: 10_000, reserveMs: 1_000, enforcement: 'strict' }, 11_000);
    const refused = answered(await upload(strict.port, freshPdf(), { fileName: 'scanner-down-strict.pdf' }));
    assert.deepEqual([refused.status, refused.json?.code], [503, 'MALWARE_SCAN_UNAVAILABLE']);
    control.scanResult = null;
    control.scanThrows = true;
    const defect = answered(await upload(compatibility.port, freshPdf(), { fileName: 'scanner-defect.pdf' }));
    assert.equal(defect.status, 500);
    assert.equal(await documentsNamed('scanner-defect.pdf') + (await documentsNamed('scanner-down-strict.pdf')), 0);
    await assertNothingLeft('failed scanner');
  });

  it('an interrupted storage write is refused (503); the partial file is removed and its journal entry released', async () => {
    const { port } = await stack({ uploadMs: 10_000, reserveMs: 1_000 }, 11_000);
    control.putFails = true;
    const result = answered(await upload(port, freshPdf(), { fileName: 'write-fails.pdf' }));
    assert.deepEqual([result.status, result.json?.code], [503, 'DOCUMENT_STORAGE_UNAVAILABLE']);
    assert.equal(await documentsNamed('write-fails.pdf'), 0);
    await assertNothingLeft('interrupted write');
  });

  it('a database rollback (the section was deleted while the file was stored) creates nothing; a failed clean-up is left to journal recovery', async () => {
    const { port } = await stack({ uploadMs: 10_000, reserveMs: 2_000 }, 11_000);
    const newSection = async () => (await q<{ id: string }>(`INSERT INTO sections (course_id, title, position, is_visible) VALUES ($1, 'Temporary', 99, true) RETURNING id`, [ids.course]))[0]!.id;
    let sectionId = await newSection();
    control.duringPut = async () => void (await q('DELETE FROM sections WHERE id = $1', [sectionId]));
    const result = answered(await upload(port, freshPdf(), { fileName: 'rolled-back.pdf', sectionId }));
    assert.equal(result.status, 404, result.body);
    assert.equal(await documentsNamed('rolled-back.pdf'), 0);
    await assertNothingLeft('rollback');
    // The same, but the clean-up cannot remove the file: it stays journaled, and recovery removes it once the lease ends.
    sectionId = await newSection();
    control.removeFails = true;
    assert.equal(answered(await upload(port, freshPdf(), { fileName: 'rolled-back-2.pdf', sectionId })).status, 404);
    assert.equal(await journal(), 1, 'journaled for recovery');
    assert.equal((await unreferenced()).length, 1);
    await q(`UPDATE document_storage_intents SET lease_expires_at = now() - interval '1 second'`);
    await recoverAbandonedStorageWrites({ db: database.db, storage: local, apply: true } as Parameters<typeof recoverAbandonedStorageWrites>[0]);
    await assertNothingLeft('journal recovery');
  });

  it('nothing in this suite was ever recorded clean without a clean verdict', async () => {
    assert.equal(await count(`SELECT count(*) AS n FROM course_documents WHERE malware_scan_status = 'clean' AND malware_scanner <> 'test-scanner'`), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM course_documents WHERE file_name IN ('hung-scan.pdf', 'scanner-down.pdf') AND malware_scan_status <> 'not_scanned'`), 0);
  });
});

describe('upload time budget configuration (AP-SEC-05A)', () => {
  const base = { NODE_ENV: 'test', DOCUMENT_STORAGE_DIR: join(tmpdir(), 'ap-budget-config') };

  it('defaults fit: extraction (20 s) and storing (4 s) within the 25 s upload budget', () => {
    const config = loadConfig(base);
    assert.deepEqual([config.documents.uploadTimeoutMs, config.documents.uploadReserveMs, config.documents.extractionTimeoutMs], [25_000, 4_000, 20_000]);
  });

  it('refuses a budget that cannot hold the scan, extraction and storing one after the other', () => {
    for (const env of [
      { DOCUMENT_EXTRACTION_TIMEOUT_SECONDS: '30' },
      { DOCUMENT_UPLOAD_TIMEOUT_SECONDS: '4' },
      { MALWARE_SCANNER: 'clamd', CLAMD_SOCKET: '/run/clamd.sock' }, // 30 + 20 + 4 > 25
      { MALWARE_SCANNER: 'clamd', CLAMD_SOCKET: '/run/clamd.sock', DOCUMENT_UPLOAD_TIMEOUT_SECONDS: '53' },
    ]) {
      assert.throws(() => loadConfig({ ...base, ...env }), /DOCUMENT_UPLOAD_TIMEOUT_SECONDS/, JSON.stringify(env));
    }
    assert.equal(loadConfig({ ...base, MALWARE_SCANNER: 'clamd', CLAMD_SOCKET: '/run/clamd.sock', DOCUMENT_UPLOAD_TIMEOUT_SECONDS: '54' }).documents.uploadTimeoutMs, 54_000);
  });

  it('the API answers uploads at least 5 s before the web proxy gives up, as configured and as deployed', () => {
    // Read as text: importing the web app's config would bring Next.js's global types into the API's typecheck.
    const nextConfig = readFileSync(fileURLToPath(new URL('../../../web/next.config.ts', import.meta.url)), 'utf8');
    assert.match(nextConfig, /proxyTimeout: proxyTimeoutMs\(\)/, 'the proxy timeout is set explicitly');
    const proxyMs = Number(/if \(!raw\) return (\d[\d_]*);/.exec(nextConfig)?.[1]?.replaceAll('_', ''));
    assert.equal(proxyMs, 30_000, 'its default is the value Next.js used implicitly');
    assert.ok(loadConfig(base).documents.uploadTimeoutMs + 5_000 <= proxyMs);
    // deploy.yml sets neither variable today; if it ever sets one, the pair must stay consistent.
    const deploy = readFileSync(fileURLToPath(new URL('../../../../.github/workflows/deploy.yml', import.meta.url)), 'utf8');
    const deployed = (name: string, fallback: number) => Number(new RegExp(`${name}=(\\d+)`).exec(deploy)?.[1] ?? fallback) * 1000;
    assert.ok(deployed('DOCUMENT_UPLOAD_TIMEOUT_SECONDS', 25) + 5_000 <= deployed('API_PROXY_TIMEOUT_SECONDS', 30), 'deploy.yml keeps the API budget below the proxy timeout');
  });
});

describe('waiting stages stop when the upload budget runs out (AP-SEC-05A, unit)', () => {
  it('a wait for an extraction slot is given up when the budget aborts, and its task never runs', { timeout: 10_000 }, async () => {
    const withSlot = createSlots(1);
    let release!: () => void;
    const busy = withSlot(() => new Promise<void>((resolve) => (release = resolve)));
    const controller = new AbortController();
    let ran = false;
    const waiting = withSlot(async () => {
      ran = true;
    }, controller.signal);
    controller.abort();
    await assert.rejects(waiting, SlotWaitAborted);
    release();
    await busy;
    assert.equal(await withSlot(async () => 'free'), 'free', 'the slot is free again');
    assert.equal(ran, false, 'the abandoned task never ran');
  });

  it("the clamd adapter stops at the caller's deadline, or as soon as the caller aborts, with no verdict", { timeout: 10_000 }, async () => {
    const daemon = await startFakeClamd();
    try {
      daemon.behaviour = 'hang';
      const scanner = new ClamdScanner({ endpoint: { host: '127.0.0.1', port: daemon.port }, timeoutMs: 30_000, maxBytes: 1_000_000, maxConcurrent: 1 });
      const bytes = Buffer.from('synthetic file');
      let started = Date.now();
      assert.deepEqual(await scanner.scan(bytes, undefined, { deadline: Date.now() + 300 }), { status: 'timeout', scanner: 'clamd', reason: 'deadline' });
      assert.ok(Date.now() - started < 3_000, 'stopped at the deadline, not after its own 30 s');
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      started = Date.now();
      assert.deepEqual(await scanner.scan(bytes, undefined, { signal: controller.signal }), { status: 'timeout', scanner: 'clamd', reason: 'deadline' });
      assert.ok(Date.now() - started < 3_000, 'stopped when the caller aborted');
    } finally {
      await daemon.close();
    }
  });
});
