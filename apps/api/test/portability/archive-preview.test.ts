/**
 * AP-038C2C: the administrator-only course archive preview API, and the isolated worker it runs in. Archives are the
 * synthetic ones of test/helpers/archives.ts plus one exported through the API from an empty course; the database is a
 * disposable PostgreSQL 16 database (TEST_DATABASE_URL).
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { userCredentials, users } from '../../src/db/schema/index.js';
import { validateCourseArchiveInWorker } from '../../src/portability/archive-preview.js';
import { ARCHIVE_ISSUE_CODES, ARCHIVE_VALIDATION_LIMITS, validateCourseArchive, type ArchiveValidationReport } from '../../src/portability/archive-validation.js';
import { ARCHIVE_MANIFEST_PATH, ARCHIVE_PACKAGE_PATH } from '../../src/portability/course-archive.js';
import { ARCHIVE_PREVIEW_MAX_IN_FLIGHT, ARCHIVE_PREVIEW_RATE_LIMIT } from '../../src/routes/course-archive-import.js';
import { withPackageSlot } from '../../src/scorm/inspection.js';
import { coursePackage, dataOf, editJson, exported, OFFICE, replace, tampered } from '../helpers/archives.js';
import { CARTRIDGE_FIXTURES } from '../helpers/cartridge.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { multipartBody } from '../helpers/documents.js';
import { SCORM_FIXTURES, type ZipSpec } from '../helpers/scorm.js';

const errorCodes = (report: ArchiveValidationReport) => report.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Edits course.json and records its new size and SHA-256 in the manifest, so that only the package content differs. */
function rewritePackage(entries: ZipSpec[], change: (value: Record<string, any>) => void): ZipSpec[] {
  const changed = editJson(entries, ARCHIVE_PACKAGE_PATH, change);
  const bytes = dataOf(changed, ARCHIVE_PACKAGE_PATH);
  return editJson(changed, ARCHIVE_MANIFEST_PATH, (manifest) => {
    manifest.package.byteSize = bytes.length;
    manifest.package.sha256 = createHash('sha256').update(bytes).digest('hex');
  });
}

/** Every field name in a report, except the activity types used as keys of counts.activitiesByType. */
function fieldNames(value: unknown, prefix = '', names = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => fieldNames(item, `${prefix}[]`, names));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const name = `${prefix}${prefix ? '.' : ''}${key}`;
      names.add(name);
      if (key !== 'activitiesByType') fieldNames(child, name, names);
    }
  }
  return names;
}
const REPORT_FIELDS = [
  'status',
  'importMode',
  'imported',
  'archive',
  'archive.byteSize',
  'archive.entries',
  'archive.uncompressedBytes',
  'manifest',
  'manifest.format',
  'manifest.formatVersion',
  'preview',
  'preview.title',
  'preview.description',
  'preview.sourceCourseCode',
  'preview.exportedAt',
  'preview.counts',
  'preview.counts.units',
  'preview.counts.folders',
  'preview.counts.activities',
  'preview.counts.activitiesByType',
  'preview.counts.questions',
  'preview.counts.importableActivities',
  'preview.counts.skippedActivities',
  'preview.counts.assignments',
  'preview.documents',
  'preview.documents[].key',
  'preview.documents[].fileName',
  'preview.documents[].format',
  'preview.documents[].byteSize',
  'preview.documents[].sha256',
  'preview.documents[].activityKeys',
  'preview.documentsByFormat',
  'preview.documentsByFormat.pdf',
  'preview.documentsByFormat.docx',
  'preview.documentsByFormat.pptx',
  'preview.documentBytes',
  'preview.skipped',
  'preview.skipped[].key',
  'preview.skipped[].unitKey',
  'preview.skipped[].type',
  'preview.skipped[].title',
  'preview.skipped[].reason',
  'preview.requiresDueDate',
  'preview.packageWarnings',
  'preview.packageWarnings[].code',
  'preview.packageWarnings[].target',
  'issues',
  'issues[].severity',
  'issues[].code',
  'issues[].message',
  'issues[].path',
  'issueCount',
];
/** Only the documented fields; issue codes from the stable list; nothing that looks like a server path, storage key or stack trace. */
function assertPublicReport(report: ArchiveValidationReport) {
  const extra = [...fieldNames(report)].filter((name) => !REPORT_FIELDS.includes(name));
  assert.deepEqual(extra, [], 'no field outside the contract');
  for (const issue of report.issues) {
    assert.ok((ARCHIVE_ISSUE_CODES as readonly string[]).includes(issue.code), issue.code);
    // Messages are fixed text. Paths are the archive's own entry names, echoed as data and never resolved on the server.
    assert.doesNotMatch(issue.message, /\/(srv|var|tmp|home|app|root)\/|storage|\bat \S+:\d+:\d+|Error:/i, issue.message);
  }
  assert.doesNotMatch(JSON.stringify(report), /storageKey|packageJson|"bytes"|"contents"|stack/);
}

describe('course archive preview worker (AP-038C2C)', () => {
  it('gives the same report in the isolated worker as in process, for valid and invalid archives', async () => {
    for (const bytes of [await exported(), await tampered((entries) => entries.filter((entry) => entry.name !== 'assets/asset-2.docx')), Buffer.from('not a zip')]) {
      assert.deepEqual(await validateCourseArchiveInWorker(bytes), await validateCourseArchive(bytes));
    }
  });

  it('a worker that reaches its time limit or fails gives a stable error and no detail', async () => {
    const bytes = await exported();
    const limited = await validateCourseArchiveInWorker(bytes, { timeoutMs: 1 });
    assert.deepEqual([limited.status, limited.preview, errorCodes(limited), limited.archive.byteSize], ['invalid', null, ['ARCHIVE_VALIDATION_LIMIT'], bytes.length]);
    const failing = new URL(`data:text/javascript,${encodeURIComponent("throw new Error('/srv/secret/worker.js failed')")}`);
    const failed = await validateCourseArchiveInWorker(bytes, { workerUrl: failing });
    assert.deepEqual([failed.status, failed.preview, errorCodes(failed)], ['invalid', null, ['ARCHIVE_VALIDATION_FAILED']]);
    assertPublicReport(failed);
    assert.doesNotMatch(JSON.stringify(failed), /secret|worker\.js/, 'the worker error is not reported');
  });

  it('runs in the shared package worker pool: it waits while SCORM or Common Cartridge inspections hold both slots', async () => {
    const releases: Array<() => void> = [];
    const held = [0, 1].map(() => withPackageSlot(() => new Promise<void>((resolve) => releases.push(resolve))));
    let done = false;
    const waiting = validateCourseArchiveInWorker(await exported()).then((report) => {
      done = true;
      return report;
    });
    try {
      await sleep(300);
      assert.equal(done, false, 'no third package worker is started');
      releases.shift()!();
      assert.equal((await waiting).status, 'valid');
    } finally {
      releases.splice(0).forEach((release) => release());
      await Promise.all(held);
    }
  });

  it('the issue codes are exactly those of CourseArchiveIssueCode in the OpenAPI contract', async () => {
    const spec = await readFile(new URL('../../../../packages/contract/openapi.yaml', import.meta.url), 'utf8');
    const block = /\n    CourseArchiveIssueCode:\n([\s\S]*?)\n    [A-Za-z]+:\n/.exec(spec)?.[1] ?? '';
    const listed = [...block.matchAll(/^        - ([A-Z_]+)$/gm)].map((match) => match[1]);
    assert.deepEqual(listed, [...ARCHIVE_ISSUE_CODES]);
  });

  it('warning codes from course.json are mapped to stable codes; unknown or inherited names are reported generically', async () => {
    const bytes = await tampered((entries) =>
      rewritePackage(entries, (value) => {
        value.warnings = ['INVALID_REFERENCE', 'UNSUPPORTED_ACTIVITY_TYPE', 'ASSET_MISSING', 'constructor', '__proto__', 'toString', 'EVIL<script>'].map((code, i) => ({
          code,
          target: `t${i}`,
          detail: 'x',
        }));
      }),
    );
    const report = await validateCourseArchiveInWorker(bytes);
    assert.equal(report.status, 'valid_with_warnings', JSON.stringify(report.issues));
    assert.deepEqual(
      report.issues.map((issue) => issue.code),
      ['PACKAGE_INVALID_REFERENCE', 'PACKAGE_UNSUPPORTED_ACTIVITY_TYPE', 'PACKAGE_ASSET_MISSING', 'PACKAGE_WARNING', 'PACKAGE_WARNING', 'PACKAGE_WARNING', 'PACKAGE_WARNING'],
    );
    assertPublicReport(report);
  });
});

describe('course archive preview API (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  const PASSWORD = randomBytes(18).toString('base64url');
  const COOKIE = 'ap_session';
  const ORIGIN = 'http://localhost:3000';
  const URL_PATH = '/api/v1/course-imports/archive/preview';
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let root: string;
  let storageDir: string;
  let emptyArchive: Buffer;
  let courseId: string;
  const sessions = new Map<string, { token: string; csrf: string }>();
  const config = () => loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir });
  const ok = (res: LightMyRequestResponse, status = 200) => {
    assert.equal(res.statusCode, status, res.body);
    return res.json();
  };
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    const body = res.json();
    assert.equal(body.code, code, res.body);
    assert.doesNotMatch(res.body, /stack|\/(srv|var|tmp|home|app|root)\/|\bat \S+:\d+:\d+/, 'no stack trace or server path');
  };
  const call = (who: string, method: 'GET' | 'POST', url: string, payload?: object) => {
    const s = sessions.get(who)!;
    return app.inject({ method, url: `/api/v1${url}`, ...(payload ? { payload } : {}), cookies: { [COOKIE]: s.token }, headers: method === 'POST' ? { 'x-csrf-token': s.csrf, origin: ORIGIN } : {} });
  };
  type UploadOptions = { fileName?: string; field?: string; csrf?: boolean; origin?: string; fields?: Array<{ name: string; value: string }>; target?: ReturnType<typeof buildApp>; url?: string };
  const upload = (who: string | null, bytes: Buffer, options: UploadOptions = {}) => {
    const s = who ? sessions.get(who)! : null;
    const { payload, contentType } = multipartBody([
      ...(options.fields ?? []),
      { name: options.field ?? 'file', filename: options.fileName ?? 'course-archive.zip', contentType: 'application/zip', data: bytes },
    ]);
    return (options.target ?? app).inject({
      method: 'POST',
      url: options.url ?? URL_PATH,
      payload,
      cookies: s ? { [COOKIE]: s.token } : {},
      headers: { 'content-type': contentType, origin: options.origin ?? ORIGIN, ...(s && options.csrf !== false ? { 'x-csrf-token': s.csrf } : {}) },
    });
  };
  const preview = async (who: string, bytes: Buffer, options: UploadOptions = {}) => {
    const res = await upload(who, bytes, options);
    const report = ok(res) as ArchiveValidationReport;
    assert.equal(res.headers['cache-control'], 'no-store');
    assertPublicReport(report);
    return report;
  };
  /** Every row of every table, hashed: proves that nothing was written. */
  const fingerprint = async () =>
    (
      await database.pool.query<{ f: string }>(
        `SELECT string_agg(t.table_name || ':' || (xpath('/row/h/text()', query_to_xml(format('SELECT count(*) || md5(coalesce(string_agg(x::text, ''|'' ORDER BY x::text), '''')) AS h FROM %I x', t.table_name), false, true, '')))[1]::text, ',' ORDER BY t.table_name) AS f
           FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'`,
      )
    ).rows[0]!.f;
  const storageSnapshot = async () => (await readdir(storageDir, { recursive: true }).catch(() => [] as string[])).sort();
  const login = async (who: string, target = app) => {
    const res = await target.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `${who}@academiapath.example`, password: PASSWORD }, headers: { origin: ORIGIN } });
    sessions.set(who, { token: res.cookies.find((c) => c.name === COOKIE)!.value, csrf: ok(res).csrfToken });
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-archive-preview-'));
    storageDir = join(root, 'store');
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    // Separate administrators, so that each test stays within the per-user rate limit of its own.
    const admins = ['archivist1', 'archivist2', 'archivist3', 'archivist4'];
    for (const who of admins) {
      const [user] = await database.db
        .insert(users)
        .values({ email: `${who}@academiapath.example`, givenName: 'Test', familyName: who, systemRole: 'administrator' })
        .returning();
      await database.db.insert(userCredentials).values({ userId: user!.id, passwordHash: await hashPassword(PASSWORD) });
    }
    app = buildApp({ config: config(), database: database.db });
    await app.ready();
    for (const who of ['admin', 'instructor', 'reviewer', 'ta', 'student', ...admins]) await login(who);
    // An empty course (one unit, no activities or documents), exported through the real archive API.
    const program = ok(await call('admin', 'POST', '/programs', { code: 'ARP', name: 'Archive previews' }), 201).id;
    const term = ok(await call('admin', 'POST', '/terms', { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' }), 201).id;
    const template = ok(await call('admin', 'POST', '/course-templates', { code: 'ARP-T', programId: program, title: 'Empty archive course', sections: [{ title: 'Unit 1' }] }), 201).templateId;
    courseId = ok(await call('admin', 'POST', '/courses', { programId: program, termId: term, templateId: template, code: 'ARP-EMPTY', status: 'published' }), 201).id;
    const archive = await call('admin', 'GET', `/courses/${courseId}/export/archive`);
    assert.equal(archive.statusCode, 200, archive.body);
    emptyArchive = archive.rawPayload;
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('previews a valid archive: course metadata, counts and the PDF, DOCX and PPTX inventory; nothing is written', async () => {
    const before = await fingerprint();
    const files = await storageSnapshot();
    const report = await preview('admin', await exported());
    assert.deepEqual([report.status, report.importMode, report.imported, report.manifest], ['valid', 'new_draft_course', false, { format: 'academiapath.course-archive', formatVersion: 1 }]);
    const p = report.preview!;
    assert.deepEqual([p.title, p.description, p.sourceCourseCode, p.exportedAt], ['Archive validation fixture', 'Synthetic course.', 'ARC-V', '2026-11-19T12:00:00.000Z']);
    assert.deepEqual([p.counts.units, p.counts.activities, p.counts.importableActivities, p.counts.skippedActivities], [1, 4, 4, 0]);
    assert.deepEqual(p.documentsByFormat, { pdf: 1, docx: 1, pptx: 1 });
    assert.deepEqual(
      p.documents.map((doc) => [doc.key, doc.fileName, doc.format, doc.byteSize, doc.activityKeys]),
      OFFICE.map((doc, i) => [`asset-${i + 1}`, doc.name, doc.format, doc.bytes.length, [`activity-${i + 2}`]]),
    );
    assert.equal(
      p.documentBytes,
      OFFICE.reduce((sum, doc) => sum + doc.bytes.length, 0),
    );
    assert.deepEqual([report.issues, report.issueCount], [[], 0]);

    // The empty course, exported by the API, previews as a new draft with nothing in it.
    const empty = await preview('admin', emptyArchive);
    assert.equal(empty.status, 'valid', JSON.stringify(empty.issues));
    assert.deepEqual(
      [empty.preview!.counts.units, empty.preview!.counts.activities, empty.preview!.documents, empty.preview!.documentsByFormat, empty.preview!.documentBytes],
      [1, 0, [], { pdf: 0, docx: 0, pptx: 0 }, 0],
    );
    assert.equal(empty.preview!.sourceCourseCode, 'ARP-EMPTY');

    assert.equal(await fingerprint(), before, 'no row was inserted, changed or deleted (no course, document, audit entry or job)');
    assert.deepEqual(await storageSnapshot(), files, 'nothing was stored');
  });

  it('invalid archives get a report with stable error codes, no preview and no internal detail', async () => {
    const before = await fingerprint();
    const files = await storageSnapshot();
    const valid = await exported();
    const cases: Array<[string, Buffer, string]> = [
      ['not a ZIP', Buffer.from('this is not a zip archive'), 'ARCHIVE_INVALID'],
      ['truncated', valid.subarray(0, valid.length - 200), 'ARCHIVE_INVALID'],
      ['corrupted entry', await tampered((entries) => entries.map((entry) => (entry.name === 'assets/asset-1.pdf' ? { ...entry, crc: 1234 } : entry))), 'ENTRY_CORRUPT'],
      ['unsupported version', await tampered((entries) => editJson(entries, ARCHIVE_MANIFEST_PATH, (manifest) => (manifest.formatVersion = 2))), 'VERSION_UNSUPPORTED'],
      ['missing asset', await tampered((entries) => entries.filter((entry) => entry.name !== 'assets/asset-2.docx')), 'ASSET_MISSING'],
      [
        'incorrect checksum',
        await tampered((entries) => {
          const pdf = Buffer.from(dataOf(entries, 'assets/asset-1.pdf'));
          pdf[pdf.length - 1] = pdf[pdf.length - 1]! ^ 0xff;
          return replace(entries, 'assets/asset-1.pdf', pdf);
        }),
        'ASSET_INTEGRITY',
      ],
      ['path traversal', await tampered((entries) => [...entries, { name: '../../srv/escape.txt', data: 'x' }]), 'PATH_TRAVERSAL'],
      ['not an AcademiaPath archive', await tampered((entries) => entries.filter((entry) => entry.name !== ARCHIVE_MANIFEST_PATH)), 'MANIFEST_MISSING'],
    ];
    for (const [name, bytes, code] of cases) {
      const report = await preview('archivist1', bytes);
      assert.equal(report.status, 'invalid', name);
      assert.equal(report.preview, null, name);
      assert.ok(errorCodes(report).includes(code as never), `${name}: expected ${code}, got ${errorCodes(report).join(', ')}`);
      if (code === 'PATH_TRAVERSAL') assert.equal(report.issues.find((issue) => issue.code === code)!.path, '../../srv/escape.txt', 'reported as named in the archive');
    }
    assert.equal(await fingerprint(), before);
    assert.deepEqual(await storageSnapshot(), files);
  });

  it('only the uploaded archive is trusted: preview metadata sent by the client is ignored', async () => {
    const forged = JSON.stringify({ status: 'valid', preview: { title: 'Forged title', documents: [] }, issues: [] });
    const report = await preview('archivist2', await tampered((entries) => entries.filter((entry) => entry.name !== 'assets/asset-3.pptx')), {
      fields: [{ name: 'preview', value: forged }],
    });
    assert.deepEqual([report.status, report.preview], ['invalid', null]);
    assert.doesNotMatch(JSON.stringify(report), /Forged/);
  });

  it('administrators only: every other role is refused before the upload is read; anonymous callers must sign in', async () => {
    const oversized = Buffer.alloc(ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes + 1);
    for (const who of ['instructor', 'reviewer', 'ta', 'student']) {
      problem(await upload(who, await exported()), 403, 'FORBIDDEN');
      problem(await upload(who, oversized), 403, 'FORBIDDEN');
    }
    problem(await upload(null, await exported()), 401, 'UNAUTHENTICATED');
    problem(await app.inject({ method: 'POST', url: URL_PATH, cookies: { [COOKIE]: 'not-a-session' }, headers: { origin: ORIGIN } }), 401, 'UNAUTHENTICATED');
  });

  it('CSRF and Origin protections apply before the upload is read', async () => {
    problem(await upload('archivist2', await exported(), { csrf: false }), 403, 'CSRF_TOKEN_INVALID');
    problem(await upload('archivist2', await exported(), { origin: 'https://attacker.example' }), 403, 'ORIGIN_NOT_ALLOWED');
  });

  it('upload rules: multipart only, one "file" part, .zip only, 25 MB at most', async () => {
    problem(await call('archivist2', 'POST', '/course-imports/archive/preview', { file: 'x' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    problem(await upload('archivist2', await exported(), { field: 'archive' }), 400, 'VALIDATION_ERROR');
    problem(await upload('archivist2', await exported(), { fileName: 'course.json' }), 415, 'UNSUPPORTED_FILE_TYPE');
    problem(await upload('archivist2', Buffer.alloc(ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes + 1)), 413, 'PAYLOAD_TOO_LARGE');
    assert.equal(ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes, 25 * 1024 * 1024);
  });

  it('over real HTTP, every upload above 25 MB is refused with 413, including one cut off exactly at the limit', async () => {
    // app.inject delivers a body at once. A listening server receives it in pieces: when the file data received so far
    // ends exactly at the limit and is read before the rest arrives, @fastify/multipart used to return the file cut off
    // at 25 MB without an error (seen through the web proxy), and it was validated. Sent here by hand, deterministically.
    const server = buildApp({ config: config(), database: database.db });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const { port } = server.server.address() as { port: number };
    const limit = ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes;
    const send = (who: string, extra: number, pauseAtLimit: boolean) =>
      new Promise<{ status: number; body: { code?: string; archive?: { byteSize: number } } }>((resolve, reject) => {
        const s = sessions.get(who)!;
        const boundary = 'ap-archive-preview-limit';
        const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="course-archive.zip"\r\nContent-Type: application/zip\r\n\r\n`);
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: URL_PATH,
            headers: {
              'content-type': `multipart/form-data; boundary=${boundary}`,
              'content-length': head.length + limit + extra + tail.length,
              cookie: `${COOKIE}=${s.token}`,
              'x-csrf-token': s.csrf,
              origin: ORIGIN,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
          },
        );
        req.on('error', (error: NodeJS.ErrnoException) => (error.code === 'ECONNRESET' || error.code === 'EPIPE' ? undefined : reject(error)));
        req.write(Buffer.concat([head, Buffer.alloc(limit)]));
        const rest = () => req.end(Buffer.concat([Buffer.alloc(extra), tail]));
        if (pauseAtLimit) setTimeout(rest, 300);
        else rest();
      });
    try {
      const results: string[] = [];
      for (const [who, extra, pause] of [
        ['archivist1', 1, true],
        ['archivist2', 4096, true],
        ['archivist3', 1, false],
        ['archivist4', 1024 * 1024, false],
      ] as const) {
        const { status: code, body } = await send(who, extra, pause);
        results.push(`+${extra} bytes${pause ? ', pause at the limit' : ''}: ${code} ${body.code ?? `report of ${body.archive?.byteSize} bytes`}`);
      }
      assert.deepEqual(
        results.filter((result) => !result.endsWith('413 PAYLOAD_TOO_LARGE')),
        [],
        'every oversized upload is refused',
      );
    } finally {
      await server.close();
    }
  });

  it(`at most ${ARCHIVE_PREVIEW_MAX_IN_FLIGHT} previews per API instance: more are refused while they wait for the shared worker pool`, async () => {
    const releases: Array<() => void> = [];
    const held = [0, 1].map(() => withPackageSlot(() => new Promise<void>((resolve) => releases.push(resolve))));
    const bytes = await exported();
    let finished = 0;
    const pending = [0, 1].map(() => upload('archivist3', bytes).then((res) => ((finished += 1), res)));
    try {
      await sleep(500);
      assert.equal(finished, 0, 'both previews wait: no worker starts while SCORM or Common Cartridge inspections hold both slots');
      const busy = await Promise.race([upload('archivist3', bytes), sleep(5_000).then(() => null)]);
      assert.ok(busy, 'a third preview is refused at once, not queued behind the others');
      problem(busy, 503, 'ARCHIVE_PREVIEW_BUSY');
      assert.equal(busy.headers['retry-after'], '30');
    } finally {
      releases.splice(0).forEach((release) => release());
      await Promise.all(held);
    }
    for (const res of await Promise.all(pending)) assert.equal(ok(res).status, 'valid');
    assert.equal((await preview('archivist3', bytes)).status, 'valid', 'capacity is released afterwards');
  });

  it(`previews are rate limited per administrator (${ARCHIVE_PREVIEW_RATE_LIMIT.max} per 10 minutes)`, async () => {
    const limited = buildApp({ config: config(), database: database.db });
    await limited.ready();
    try {
      const statuses: number[] = [];
      for (let n = 0; n <= ARCHIVE_PREVIEW_RATE_LIMIT.max; n += 1) statuses.push((await upload('archivist4', Buffer.from('not a zip'), { target: limited })).statusCode);
      assert.deepEqual([statuses.slice(0, ARCHIVE_PREVIEW_RATE_LIMIT.max).every((status) => status === 200), statuses[ARCHIVE_PREVIEW_RATE_LIMIT.max]], [true, 429]);
      assert.equal((await upload('admin', Buffer.from('not a zip'), { target: limited })).statusCode, 200, 'the limit is per user');
    } finally {
      await limited.close();
    }
  });

  it('the JSON import preview, the archive export and the SCORM and Common Cartridge inspections are unchanged', async () => {
    const json = ok(await call('archivist2', 'POST', '/course-imports/preview', coursePackage(OFFICE)));
    assert.deepEqual([json.valid, json.hashVerified, json.documents.length], [true, true, 3]);
    const multipartToJson = await upload('archivist2', await exported(), { url: '/api/v1/course-imports/preview' });
    assert.equal(multipartToJson.statusCode, 415, 'the JSON import preview still accepts JSON only');
    assert.equal((await call('archivist2', 'GET', `/courses/${courseId}/export/archive`)).headers['content-type'], 'application/zip');
    const scorm = ok(await upload('archivist2', SCORM_FIXTURES.scorm12Single(), { url: `/api/v1/courses/${courseId}/scorm-inspections` }));
    assert.equal(scorm.status, 'valid');
    const cartridge = ok(await upload('archivist2', CARTRIDGE_FIXTURES.cc13(), { url: `/api/v1/courses/${courseId}/cartridge-inspections`, fileName: 'course.imscc' }));
    assert.equal(cartridge.status, 'valid');
  });
});
