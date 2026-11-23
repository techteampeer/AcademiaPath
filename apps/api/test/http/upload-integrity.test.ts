/**
 * AP-SEC-02: multipart uploads over real HTTP. Every route that accepts a file (documents, SCORM inspection, Common
 * Cartridge inspection, course archive preview) gets, on a listening server with a disposable database and synthetic
 * files: a valid upload below its limit, one exactly at its limit, oversized uploads sent at once, oversized uploads
 * that pause exactly at the limit before sending the rest, and an upload the client abandons mid-body.
 *
 * The pause case is the one app.inject cannot reproduce: @fastify/multipart used to hand back the first `limit` bytes
 * without an error, so a document was stored and a package inspected as if it were complete. Limits are binary units:
 * 10 MiB = 10,485,760 bytes (documents, default DOCUMENT_MAX_UPLOAD_MB=10) and 25 MiB = 26,214,400 bytes (packages).
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { CARTRIDGE_LIMITS } from '../../src/cartridge/report.js';
import { loadConfig } from '../../src/config.js';
import { noMalwareScanner, type MalwareScanner } from '../../src/documents/scanner.js';
import { mockSummaryProvider, type DocumentSummaryProvider } from '../../src/documents/summary.js';
import { ARCHIVE_VALIDATION_LIMITS } from '../../src/portability/archive-validation.js';
import { SCORM_LIMITS } from '../../src/scorm/limits.js';
import { exported } from '../helpers/archives.js';
import { CARTRIDGE_FIXTURES } from '../helpers/cartridge.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { makePdf } from '../helpers/documents.js';
import { SCORM_FIXTURES } from '../helpers/scorm.js';
import { exactPdf, exactZip, rawUpload, type RawResult, type RawUpload } from '../helpers/uploads.js';

const MiB = 1024 * 1024;
const PAUSE_MS = 300;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('upload integrity over real HTTP (AP-SEC-02)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  const PASSWORD = randomBytes(18).toString('base64url');
  const ORIGIN = 'http://localhost:3000';
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let root: string;
  let storageDir: string;
  let port: number;
  let headers: Record<string, string>;
  let courseId: string;
  let sectionId: string;
  let documentLimit: number;
  // Every file that reaches the malware scanner or the summary provider is counted.
  const calls = { scanned: 0, summarized: 0 };
  const scanner: MalwareScanner = { scan: (bytes, file) => ((calls.scanned += 1), noMalwareScanner.scan(bytes, file)) };
  const provider: DocumentSummaryProvider = { ...mockSummaryProvider, summarize: (input) => ((calls.summarized += 1), mockSummaryProvider.summarize(input)) };

  const upload = (options: Omit<RawUpload, 'port' | 'headers'>) => rawUpload({ ...options, port, headers });
  const refused = (result: RawResult, label: string) => {
    assert.ok(!('aborted' in result), label);
    assert.deepEqual([result.status, result.body.code], [413, 'PAYLOAD_TOO_LARGE'], `${label}: ${JSON.stringify(result.body).slice(0, 200)}`);
  };
  const storedFiles = async () => (await readdir(storageDir, { recursive: true }).catch(() => [] as string[])).sort();
  /** What a document upload can leave behind: rows, audit entries, stored files and pipeline calls. */
  const documentState = async () => {
    const count = async (sql: string) => Number((await database.pool.query<{ n: string }>(sql)).rows[0]!.n);
    return {
      documents: await count('SELECT count(*) AS n FROM course_documents'),
      activities: await count('SELECT count(*) AS n FROM activities'),
      summaries: await count('SELECT count(*) AS n FROM document_summaries'),
      uploadedAudits: await count(`SELECT count(*) AS n FROM audit_log WHERE action = 'document.uploaded'`),
      createdAudits: await count(`SELECT count(*) AS n FROM audit_log WHERE action = 'activity.created'`),
      tooLargeAudits: await count(`SELECT count(*) AS n FROM audit_log WHERE action = 'document.upload_rejected' AND metadata->'after'->>'code' = 'PAYLOAD_TOO_LARGE'`),
      files: (await storedFiles()).length,
      scanned: calls.scanned,
      summarized: calls.summarized,
    };
  };
  /** Every row of every table, hashed: proves that an inspection wrote nothing. */
  const fingerprint = async () =>
    (
      await database.pool.query<{ f: string }>(
        `SELECT string_agg(t.table_name || ':' || (xpath('/row/h/text()', query_to_xml(format('SELECT count(*) || md5(coalesce(string_agg(x::text, ''|'' ORDER BY x::text), '''')) AS h FROM %I x', t.table_name), false, true, '')))[1]::text, ',' ORDER BY t.table_name) AS f
           FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'`,
      )
    ).rows[0]!.f;

  /** The oversized cases for a file of exactly `limit` bytes: sent at once, and paused exactly at the limit. */
  const oversized = (exact: Buffer, limit: number) => {
    const plus = (n: number) => Buffer.concat([exact, Buffer.alloc(n, 0x0a)]);
    return [
      { label: 'limit + 1 byte, sent at once', file: plus(1) },
      { label: 'limit + 4096 bytes, sent at once', file: plus(4096) },
      { label: 'limit + 1 byte, paused at the limit', file: plus(1), pause: { at: limit, ms: PAUSE_MS } },
      { label: 'limit + 4096 bytes, paused at the limit', file: plus(4096), pause: { at: limit, ms: PAUSE_MS } },
    ];
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-upload-integrity-'));
    storageDir = join(root, 'store');
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    // The default document limit (DOCUMENT_MAX_UPLOAD_MB unset): the one deployed unless configured otherwise.
    const config = loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir });
    documentLimit = config.documents.maxUploadBytes;
    app = buildApp({ config, database: database.db, documents: { scanner, provider } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/api/v1`;
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: 'admin@academiapath.example', password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    headers = {
      cookie: login.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; '),
      'x-csrf-token': ((await login.json()) as { csrfToken: string }).csrfToken,
      origin: ORIGIN,
    };
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 201, await res.clone().text());
      return (await res.json()) as Record<string, string>;
    };
    const program = await post('/programs', { code: 'SEC', name: 'Upload integrity' });
    const term = await post('/terms', { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' });
    const template = await post('/course-templates', { code: 'SEC-T', programId: program.id, title: 'Upload integrity', sections: [{ title: 'Unit 1' }] });
    courseId = (await post('/courses', { programId: program.id, termId: term.id, templateId: template.templateId, code: 'SEC-1', status: 'draft' })).id!;
    sectionId = ((await (await fetch(`${base}/courses/${courseId}/sections`, { headers })).json()) as { items: Array<{ id: string }> }).items[0]!.id;
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('the configured limits are unchanged and binary: 10 MiB for documents, 25 MiB for packages and archives', () => {
    assert.equal(documentLimit, 10 * MiB);
    assert.equal(documentLimit, 10_485_760);
    for (const limit of [SCORM_LIMITS.maxPackageBytes, CARTRIDGE_LIMITS.maxPackageBytes, ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes]) assert.equal(limit, 26_214_400);
  });

  it('documents: valid uploads up to exactly the limit are stored intact; oversized, paused and abandoned uploads leave nothing behind', async () => {
    const path = `/api/v1/courses/${courseId}/sections/${sectionId}/documents`;
    const send = (file: Buffer, extra: Partial<RawUpload> = {}) => upload({ path, fileName: 'handout.pdf', contentType: 'application/pdf', file, ...extra });
    const storedRow = async (activityId: string) =>
      (await database.pool.query<{ byte_size: number; sha256: string; storage_key: string }>('SELECT byte_size, sha256, storage_key FROM course_documents WHERE activity_id = $1', [activityId]))
        .rows[0]!;

    // Valid uploads, including one of exactly 10,485,760 bytes, still work and are stored byte for byte.
    for (const file of [makePdf([['Upload integrity: a small handout', 'Synthetic page.']]), exactPdf(documentLimit)]) {
      const before = await documentState();
      const result = await send(file);
      assert.ok(!('aborted' in result));
      assert.equal(result.status, 201, JSON.stringify(result.body).slice(0, 300));
      const row = await storedRow(result.body.activityId as string);
      assert.deepEqual([row.byte_size, row.sha256], [file.length, sha256(file)]);
      assert.equal(sha256(await readFile(join(storageDir, row.storage_key))), sha256(file), 'the stored file is the uploaded file');
      const after = await documentState();
      assert.deepEqual([after.documents - before.documents, after.uploadedAudits - before.uploadedAudits, after.files - before.files, after.scanned - before.scanned], [1, 1, 1, 1]);
    }

    // Oversized uploads, whether sent at once or paused exactly at the limit, are refused before anything is kept.
    const exact = exactPdf(documentLimit);
    for (const { label, ...extra } of oversized(exact, documentLimit)) {
      const before = await documentState();
      const files = await storedFiles();
      refused(await send(extra.file, extra), `document ${label}`);
      const after = await documentState();
      assert.deepEqual(
        { ...after, tooLargeAudits: after.tooLargeAudits - 1 },
        before,
        `document ${label}: only the refusal is audited (no document, activity, summary, upload audit, stored file, scan or summary)`,
      );
      assert.deepEqual(await storedFiles(), files, `document ${label}: no partial file is stored`);
    }

    // An upload abandoned mid-body is never stored, and the server keeps serving.
    const before = await documentState();
    assert.deepEqual(await send(exact, { abortAt: Math.floor(documentLimit / 2) }), { aborted: true });
    await sleep(PAUSE_MS);
    assert.deepEqual(await documentState(), before, 'an abandoned upload leaves nothing behind');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status, 200);
  });

  for (const route of [
    { name: 'SCORM inspection', segment: 'scorm-inspections', fileName: 'lesson.zip', fixture: () => SCORM_FIXTURES.scorm12Single(), limit: SCORM_LIMITS.maxPackageBytes },
    { name: 'Common Cartridge inspection', segment: 'cartridge-inspections', fileName: 'course.imscc', fixture: () => CARTRIDGE_FIXTURES.cc13(), limit: CARTRIDGE_LIMITS.maxPackageBytes },
  ]) {
    it(`${route.name}: packages up to exactly 25 MiB are inspected whole; a package cut off at the limit is refused, never inspected`, async () => {
      const path = `/api/v1/courses/${courseId}/${route.segment}`;
      const send = (file: Buffer, extra: Partial<RawUpload> = {}) => upload({ path, fileName: route.fileName, contentType: 'application/zip', file, ...extra });
      const rows = await fingerprint();
      const files = await storedFiles();
      const exact = await exactZip(route.fixture(), route.limit);
      for (const file of [route.fixture(), exact]) {
        const result = await send(file);
        assert.ok(!('aborted' in result));
        assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300));
        assert.equal(result.body.status, 'valid', `${route.name}: ${JSON.stringify(result.body.issues).slice(0, 300)}`);
        assert.equal((result.body.package as { compressedBytes: number }).compressedBytes, file.length, 'the whole package was inspected');
      }
      for (const { label, ...extra } of oversized(exact, route.limit)) refused(await send(extra.file, extra), `${route.name} ${label}`);
      assert.deepEqual(await send(exact, { abortAt: Math.floor(route.limit / 2) }), { aborted: true });
      await sleep(PAUSE_MS);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status, 200);
      assert.equal(await fingerprint(), rows, 'an inspection writes nothing');
      assert.deepEqual(await storedFiles(), files, 'an inspection stores nothing');
    });
  }

  it('course archive preview: an archive cut off at the limit is refused, never validated (the route fixed in AP-038C2D)', async () => {
    const send = (file: Buffer, extra: Partial<RawUpload> = {}) => upload({ path: '/api/v1/course-imports/archive/preview', fileName: 'course.zip', contentType: 'application/zip', file, ...extra });
    const rows = await fingerprint();
    const valid = await send(await exported());
    assert.ok(!('aborted' in valid));
    assert.deepEqual([valid.status, valid.body.status], [200, 'valid']);
    // Exactly at the limit the bytes are validated in full (padding makes this archive invalid, but it is read whole).
    const exact = Buffer.alloc(ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes);
    const atLimit = await send(exact);
    assert.ok(!('aborted' in atLimit));
    assert.deepEqual([atLimit.status, (atLimit.body.archive as { byteSize: number }).byteSize], [200, exact.length]);
    for (const { label, ...extra } of oversized(exact, exact.length).slice(1)) refused(await send(extra.file, extra), `archive preview ${label}`);
    assert.equal(await fingerprint(), rows, 'a preview writes nothing');
  });
});
