/**
 * AP-033B SCORM package inspection. Unit tests of the path rules and of the inspector on synthetic packages (valid
 * SCORM 1.2 and 2004, and every archive, XML and manifest attack), the offline CLI, and the dry-run API against a
 * temporary PostgreSQL database (skipped unless TEST_DATABASE_URL is set): access by role, CSRF and Origin, upload
 * limits, rate limiting, and proof that inspection writes nothing to the database or to storage.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { INSPECT_EXIT, main as inspectCli } from '../../scripts/scorm-inspect.js';
import { seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { userCredentials, users } from '../../src/db/schema/index.js';
import { inspectPackage } from '../../src/scorm/inspect.js';
import { inspectInWorker } from '../../src/scorm/inspection.js';
import { SCORM_LIMITS } from '../../src/scorm/limits.js';
import { checkEntryName, resolveHref } from '../../src/scorm/paths.js';
import type { ScormInspectionReport, ScormIssueCode } from '../../src/scorm/report.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { makePdf, multipartBody } from '../helpers/documents.js';
import { buildZip, largeValidPackage, manifest12, manifest2004, SCORM_FIXTURES, type ScormFixture } from '../helpers/scorm.js';

const codes = (report: ScormInspectionReport) => report.issues.map((issue) => issue.code);
const errorCodes = (report: ScormInspectionReport) => report.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code);

describe('SCORM path rules (unit)', () => {
  it('accepts ordinary package paths and rejects traversal, absolute, hidden-control and ambiguous names', () => {
    for (const name of ['index.html', 'shared/', 'a/b/c.js', 'media/vidéo 1.mp4', 'imsmanifest.xml']) assert.equal(checkEntryName(name), null, name);
    for (const name of ['../evil.html', 'a/../../b', 'a/..']) assert.equal(checkEntryName(name), 'traversal', name);
    for (const name of ['/etc/passwd', 'C:/Windows/x', 'c:evil']) assert.equal(checkEntryName(name), 'absolute', name);
    for (const name of ['', 'a\\b.html', 'a//b', './a', 'a/./b', 'bad\u0000name', 'tab\tname', 'dir/a:stream', 'x\ufffd', `${'a/'.repeat(40)}f`, `${'n'.repeat(600)}`]) {
      assert.equal(checkEntryName(name), 'invalid', JSON.stringify(name));
    }
  });

  it('resolves manifest addresses inside the package only, never as server paths or URLs', () => {
    assert.deepEqual(resolveHref('index.html'), { kind: 'local', path: 'index.html', query: '', fragment: '', backslash: false });
    assert.deepEqual(resolveHref('page%20one.html?x=1#top', ['content/']), { kind: 'local', path: 'content/page one.html', query: '?x=1', fragment: '#top', backslash: false });
    assert.equal((resolveHref('index.html', ['course', 'lessons/']) as { path: string }).path, 'course/lessons/index.html', 'xml:base without a trailing slash is a folder');
    assert.equal((resolveHref('shared/../index.html') as { path: string }).path, 'index.html', 'inside the package, ".." is fine');
    assert.equal((resolveHref('pages\\start.html') as { backslash: boolean }).backslash, true);
    assert.deepEqual(resolveHref('../../etc/passwd'), { kind: 'outside' });
    assert.deepEqual(resolveHref('index.html', ['../']), { kind: 'outside' });
    assert.deepEqual(resolveHref('a/%2e%2e/%2e%2e/x'), { kind: 'outside' });
    for (const href of ['/etc/passwd', '', '   ', 'a%2Fb', 'bad%zz', 'a%00b']) assert.equal(resolveHref(href).kind, 'invalid', href);
    for (const href of ['https://example.com/x.html', 'http://x', '//cdn.example/x.js']) assert.equal(resolveHref(href).kind, 'external', href);
    for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:x', 'blob:x']) assert.equal(resolveHref(href).kind, 'dangerous', href);
    assert.equal(resolveHref('index.html', ['https://cdn.example/']).kind, 'external', 'an external xml:base makes the address external');
  });
});

describe('SCORM package inspection (unit, synthetic packages)', () => {
  const inspect = (fixture: ScormFixture) => inspectPackage(SCORM_FIXTURES[fixture](), { fileName: `${fixture}.zip` });

  it('valid SCORM 1.2 single-SCO package: version, title, launch file, counts and no false positives', async () => {
    const report = await inspect('scorm12Single');
    assert.equal(report.status, 'valid');
    assert.deepEqual(report.issues, []);
    assert.deepEqual(report.standard, { format: 'scorm', version: 'scorm_1_2', edition: null, schemaVersion: '1.2' });
    assert.equal(report.title, 'Introduction to Service Management');
    assert.equal(report.manifestIdentifier, 'com.example.course');
    assert.deepEqual(report.counts, { organizations: 1, items: 1, resources: 1, scos: 1, assets: 0, launchable: 1, declaredFiles: 2, missingFiles: 0, undeclaredFiles: 0 });
    assert.deepEqual(report.launchable, [{ organization: 'ORG-1', item: 'ITEM-1', title: 'Lesson 1: What is a service?', resource: 'RES-1', scormType: 'sco', launchPath: 'index.html', parameters: null, visible: true }]);
    assert.deepEqual(report.runtime, { playbackAvailable: false, plannedSupport: 'planned' });
    assert.equal(report.imported, false);
    assert.equal(report.package.fileName, 'scorm12Single.zip');
    assert.equal(report.package.fileCount, 3);
    assert.equal(report.package.sha256, createHash('sha256').update(SCORM_FIXTURES.scorm12Single()).digest('hex'));
    assert.ok(report.package.uncompressedBytes! > 0);
  });

  it('valid SCORM 1.2 multi-SCO package: nested items in order, item parameters, shared asset dependency', async () => {
    const report = await inspect('scorm12Multi');
    assert.equal(report.status, 'valid');
    assert.deepEqual(report.issues, []);
    assert.deepEqual(
      report.launchable.map((entry) => [entry.title, entry.launchPath, entry.parameters]),
      [
        ['Lesson 1: Project charter', 'lessons/lesson1.html', null],
        ['Lesson 2: Stakeholders', 'lessons/lesson2.html', '?section=2'],
        ['Final quiz', 'quiz/quiz.html', null],
      ],
    );
    assert.deepEqual([report.counts.items, report.counts.scos, report.counts.assets, report.counts.resources], [4, 3, 1, 4]);
    assert.deepEqual(report.resources.find((resource) => resource.identifier === 'SHARED'), { identifier: 'SHARED', scormType: 'asset', launchPath: null, fileCount: 2, missingFileCount: 0, dependencyCount: 0 });
    assert.equal(report.package.folderCount, 3);
  });

  it('structurally valid SCORM 2004 (4th Edition) package; sequencing is reported as not applied', async () => {
    const report = await inspect('scorm2004');
    assert.equal(report.status, 'valid');
    assert.deepEqual(report.standard, { format: 'scorm', version: 'scorm_2004', edition: '4th', schemaVersion: '2004 4th Edition' });
    assert.deepEqual([report.counts.scos, report.counts.launchable, report.features.sequencing], [2, 2, false]);
    const sequenced = await inspect('scorm2004Sequencing');
    assert.equal(sequenced.status, 'valid_with_warnings');
    assert.deepEqual(codes(sequenced), ['SCORM_SEQUENCING_IGNORED']);
    assert.deepEqual([sequenced.features.sequencing, sequenced.runtime.plannedSupport], [true, 'planned_without_sequencing']);
    for (const [declared, edition] of [['CAM 1.3', '2nd'], ['2004 3rd Edition', '3rd']] as const) {
      const bytes = buildZip([
        { name: 'imsmanifest.xml', data: manifest2004({ schemaVersion: declared, items: [{ id: 'I', title: 'T', ref: 'R' }], resources: [{ id: 'R', title: '', href: 'a.html' }] }) },
        { name: 'a.html', data: '<p>a</p>' },
      ]);
      const result = await inspectPackage(bytes);
      assert.deepEqual([result.status, result.standard.version, result.standard.edition], ['valid', 'scorm_2004', edition], declared);
    }
  });

  it('warnings never make a package invalid: inferred version, missing supporting file, backslash path', async () => {
    const report = await inspect('scorm12Warnings');
    assert.equal(report.status, 'valid_with_warnings');
    assert.deepEqual(codes(report).sort(), ['SCORM_FILE_MISSING', 'SCORM_HREF_BACKSLASH', 'SCORM_VERSION_INFERRED']);
    assert.equal(report.issues.find((issue) => issue.code === 'SCORM_FILE_MISSING')!.path, 'pages/missing.css');
    assert.deepEqual([report.standard.version, report.counts.missingFiles, report.launchable[0]!.launchPath], ['scorm_1_2', 1, 'pages/start.html']);
  });

  const invalid: Array<[ScormFixture, ScormIssueCode[]]> = [
    ['missingManifest', ['SCORM_MANIFEST_MISSING']],
    ['manifestInFolder', ['SCORM_MANIFEST_NOT_AT_ROOT']],
    ['malformedXml', ['SCORM_MANIFEST_MALFORMED']],
    ['doctype', ['SCORM_MANIFEST_DOCTYPE']],
    ['entityExpansion', ['SCORM_MANIFEST_DOCTYPE']],
    ['externalEntity', ['SCORM_MANIFEST_DOCTYPE']],
    ['deepXml', ['SCORM_MANIFEST_TOO_DEEP']],
    ['manyElements', ['SCORM_MANIFEST_TOO_MANY_ELEMENTS']],
    ['missingLaunchFile', ['SCORM_LAUNCH_FILE_MISSING', 'SCORM_NO_LAUNCHABLE_CONTENT']],
    ['invalidReference', ['SCORM_DEPENDENCY_INVALID', 'SCORM_ITEM_REFERENCE_INVALID', 'SCORM_NO_LAUNCHABLE_CONTENT']],
    ['externalLaunch', ['SCORM_HREF_EXTERNAL', 'SCORM_NO_LAUNCHABLE_CONTENT']],
    ['dangerousLaunch', ['SCORM_HREF_DANGEROUS', 'SCORM_HREF_DANGEROUS', 'SCORM_NO_LAUNCHABLE_CONTENT']],
    ['hrefOutsidePackage', ['SCORM_HREF_OUTSIDE_PACKAGE', 'SCORM_NO_LAUNCHABLE_CONTENT']],
    ['pathTraversal', ['SCORM_PATH_TRAVERSAL']],
    ['absolutePath', ['SCORM_PATH_ABSOLUTE']],
    ['symlink', ['SCORM_ENTRY_SYMLINK']],
    ['encrypted', ['SCORM_ENTRY_ENCRYPTED']],
    ['duplicateNames', ['SCORM_PATH_DUPLICATE']],
    ['caseCollision', ['SCORM_PATH_COLLISION']],
    ['unicodeCollision', ['SCORM_PATH_COLLISION']],
    ['zipBombRatio', ['SCORM_ENTRY_EXPANSION_RATIO']],
    ['zipBombTotal', ['SCORM_ARCHIVE_TOO_LARGE']],
    ['forgedSize', ['SCORM_ENTRY_CORRUPT']],
    ['badChecksum', ['SCORM_ENTRY_CORRUPT']],
    ['tooManyEntries', ['SCORM_ARCHIVE_TOO_MANY_ENTRIES']],
    ['unsupportedVersion', ['SCORM_VERSION_UNSUPPORTED']],
    ['unknownStandard', ['SCORM_VERSION_UNKNOWN']],
    ['commonCartridge', ['SCORM_COMMON_CARTRIDGE']],
    ['notZip', ['SCORM_ARCHIVE_INVALID']],
  ];
  for (const [fixture, expected] of invalid) {
    it(`invalid: ${fixture} → ${[...new Set(expected)].join(', ')}`, async () => {
      const report = await inspect(fixture);
      assert.equal(report.status, 'invalid');
      assert.deepEqual(errorCodes(report).sort(), [...expected].sort());
      assert.equal(report.runtime.plannedSupport, 'not_supported');
      assert.equal(report.imported, false);
    });
  }

  it('unsafe archives are never inspected further, and the offending entry is named without being read', async () => {
    const traversal = await inspect('pathTraversal');
    assert.deepEqual([traversal.standard.format, traversal.counts.resources, traversal.launchable.length], ['unknown', 0, 0]);
    assert.equal(traversal.issues[0]!.path, '../../evil.html');
    const bomb = await inspect('zipBombTotal');
    assert.equal(bomb.issues[0]!.limit, SCORM_LIMITS.maxTotalBytes);
    assert.ok(bomb.package.uncompressedBytes! > SCORM_LIMITS.maxTotalBytes, 'declared size reported; nothing was decompressed');
    const ratio = await inspect('zipBombRatio');
    assert.deepEqual([ratio.issues[0]!.path, ratio.issues[0]!.limit], ['shared/zeros.bin', SCORM_LIMITS.maxExpansionRatio]);
    const cc = await inspect('commonCartridge');
    assert.deepEqual([cc.standard.format, cc.standard.schemaVersion], ['common_cartridge', '1.1.0']);
  });

  it('manifest encodings: UTF-16 with BOM and Windows-1252 are read; invalid UTF-8 is refused', async () => {
    const xml = manifest12({ title: 'Introducción', items: [{ id: 'I', title: 'Lección', ref: 'R' }], resources: [{ id: 'R', title: '', href: 'index.html' }] });
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml.replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf16le')]);
    const latin = Buffer.from(xml.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'), 'latin1');
    for (const manifest of [utf16, latin]) {
      const report = await inspectPackage(buildZip([{ name: 'imsmanifest.xml', data: manifest }, { name: 'index.html', data: 'x' }]));
      assert.deepEqual([report.status, report.title], ['valid', 'Introducción']);
    }
    const broken = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="UTF-8"?><manifest identifier="x"><metadata><schema>'), Buffer.from([0xc3, 0x28]), Buffer.from('</schema></metadata></manifest>')]);
    assert.deepEqual(codes(await inspectPackage(buildZip([{ name: 'imsmanifest.xml', data: broken }]))), ['SCORM_MANIFEST_ENCODING']);
  });

  it('reports stay bounded and clean: issue cap, list cap, control characters and long strings', async () => {
    const files = Array.from({ length: 300 }, (_, n) => `missing/${n}.js`);
    const manifest = manifest12({
      title: `Title\twith\u202econtrol\u200b ${'x'.repeat(1000)}`,
      items: Array.from({ length: 520 }, (_, n) => ({ id: `I${n}`, title: `Item ${n}`, ref: 'R' })),
      resources: [{ id: 'R', title: '', href: 'index.html', files: ['index.html', ...files] }],
    });
    const report = await inspectPackage(buildZip([{ name: 'imsmanifest.xml', data: manifest }, { name: 'index.html', data: 'x' }]));
    assert.equal(report.status, 'valid_with_warnings');
    assert.equal(report.counts.missingFiles, 300);
    assert.equal(report.issues.length, SCORM_LIMITS.maxIssues);
    assert.equal(report.issuesTruncated, true);
    assert.equal(report.counts.launchable, 520);
    assert.equal(report.launchable.length, SCORM_LIMITS.maxListed);
    assert.equal(report.listsTruncated, true);
    assert.ok(report.title!.length <= 300 && !/[\u0000-\u001f\u200b\u202e]/.test(report.title!), report.title!);
    assert.ok(report.title!.startsWith('Title with control'));
    assert.ok(Buffer.byteLength(JSON.stringify(report)) < 300_000);
    const named = await inspectPackage(SCORM_FIXTURES.scorm12Single(), { fileName: 'C:\\Users\\someone\\Downloads\\course.zip' });
    assert.equal(named.package.fileName, 'course.zip', 'never a local path');
  });

  it('never executes package content and never fetches anything a package refers to', async () => {
    const calls: string[] = [];
    const fetchMock = mock.method(globalThis, 'fetch', async (input: unknown) => {
      calls.push(String(input));
      throw new Error('no network');
    });
    const api = { LMSInitialize: () => calls.push('LMSInitialize') };
    (globalThis as { API?: unknown }).API = api;
    try {
      for (const fixture of ['scorm12Single', 'externalLaunch', 'externalEntity', 'scorm2004'] as const) await inspect(fixture);
    } finally {
      delete (globalThis as { API?: unknown }).API;
      fetchMock.mock.restore();
    }
    assert.deepEqual(calls, []);
  });

  it('runs in a worker with time and memory limits, and gives the same report as in-process inspection', async () => {
    const bytes = SCORM_FIXTURES.scorm12Multi();
    assert.deepEqual(await inspectInWorker(bytes, { fileName: 'multi.zip' }), await inspectPackage(bytes, { fileName: 'multi.zip' }));
    const slow = await inspectInWorker(bytes, { fileName: 'multi.zip', timeoutMs: 1 });
    assert.deepEqual([slow.status, codes(slow)], ['invalid', ['SCORM_INSPECTION_LIMIT']]);
    assert.equal(slow.package.sha256, createHash('sha256').update(bytes).digest('hex'));
    const results = await Promise.all(Array.from({ length: 5 }, () => inspectInWorker(SCORM_FIXTURES.scorm2004())));
    assert.ok(results.every((report) => report.status === 'valid'), 'concurrent inspections queue for a worker slot');
  });
});

describe('pnpm scorm:inspect (offline CLI)', () => {
  let dir: string;
  const output: string[] = [];
  const errors: string[] = [];
  const run = (args: string[]) => inspectCli(args, { cwd: dir, out: (text) => output.push(text), err: (text) => errors.push(text) });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ap-scorm-cli-'));
    await writeFile(join(dir, 'valid.zip'), SCORM_FIXTURES.scorm12Multi());
    await writeFile(join(dir, 'traversal.zip'), SCORM_FIXTURES.pathTraversal());
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prints a summary and exits 0 for a valid package, 1 for an invalid one', async () => {
    assert.equal(await run(['valid.zip']), INSPECT_EXIT.valid);
    const text = output.pop()!;
    assert.match(text, /Standard:\s+SCORM 1\.2/);
    assert.match(text, /Result:\s+VALID — 0 errors, 0 warnings/);
    assert.match(text, /lessons\/lesson2\.html\?section=2 \(SCO\)/);
    assert.match(text, /nothing was imported, uploaded, extracted or executed/);
    assert.ok(!text.includes(dir), 'no local path in the output');
    assert.equal(await run(['traversal.zip']), INSPECT_EXIT.invalid);
    assert.match(output.pop()!, /\[error\] SCORM_PATH_TRAVERSAL/);
  });

  it('prints the machine-readable report with --json', async () => {
    assert.equal(await run(['--json', join(dir, 'valid.zip')]), INSPECT_EXIT.valid);
    const report = JSON.parse(output.pop()!) as ScormInspectionReport;
    assert.deepEqual(report, await inspectPackage(SCORM_FIXTURES.scorm12Multi(), { fileName: 'valid.zip' }));
  });

  it('reports usage errors and unreadable files with exit code 2, and oversize packages without reading them', async () => {
    assert.equal(await run([]), INSPECT_EXIT.usage);
    assert.equal(await run(['a.zip', 'b.zip']), INSPECT_EXIT.usage);
    assert.equal(await run(['missing.zip']), INSPECT_EXIT.usage);
    assert.equal(await run([dir]), INSPECT_EXIT.usage, 'a folder is not a package');
    assert.ok(errors.every((line) => !line.includes(dir)));
    const huge = join(dir, 'huge.zip');
    await writeFile(huge, '');
    await truncate(huge, SCORM_LIMITS.maxPackageBytes + 1);
    assert.equal(await run(['--json', 'huge.zip']), INSPECT_EXIT.invalid);
    const report = JSON.parse(output.pop()!) as ScormInspectionReport;
    assert.deepEqual([report.status, codes(report), report.package.compressedBytes], ['invalid', ['SCORM_PACKAGE_TOO_LARGE'], SCORM_LIMITS.maxPackageBytes + 1]);
    assert.equal((await stat(join(dir, 'valid.zip'))).size, SCORM_FIXTURES.scorm12Multi().length, 'the package is never modified');
  });
});

describe('SCORM inspection API (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  const PASSWORD = randomBytes(18).toString('base64url');
  const COOKIE = 'ap_session';
  const ORIGIN = 'http://localhost:3000';
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let root: string;
  let storageDir: string;
  const sessions = new Map<string, { token: string; csrf: string }>();
  const ids = {} as Record<'course' | 'otherCourse' | 'unit', string>;
  const config = () => loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir });

  const ok = (res: LightMyRequestResponse, status = 200) => {
    assert.equal(res.statusCode, status, res.body);
    return res.json();
  };
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };
  const call = (who: string, method: 'GET' | 'POST', url: string, payload?: object) => {
    const s = sessions.get(who)!;
    return app.inject({ method, url: `/api/v1${url}`, ...(payload ? { payload } : {}), cookies: { [COOKIE]: s.token }, headers: method === 'POST' ? { 'x-csrf-token': s.csrf, origin: ORIGIN } : {} });
  };
  const inspect = (
    who: string | null,
    bytes: Buffer,
    options: { courseId?: string; fileName?: string; field?: string; csrf?: boolean; origin?: string; target?: ReturnType<typeof buildApp> } = {},
  ) => {
    const s = who ? sessions.get(who)! : null;
    const { payload, contentType } = multipartBody([{ name: options.field ?? 'file', filename: options.fileName ?? 'package.zip', contentType: 'application/zip', data: bytes }]);
    return (options.target ?? app).inject({
      method: 'POST',
      url: `/api/v1/courses/${options.courseId ?? ids.course}/scorm-inspections`,
      payload,
      cookies: s ? { [COOKIE]: s.token } : {},
      headers: { 'content-type': contentType, origin: options.origin ?? ORIGIN, ...(s && options.csrf !== false ? { 'x-csrf-token': s.csrf } : {}) },
    });
  };
  /** Every row of every table, hashed: proves that nothing was written. */
  const fingerprint = async () =>
    (
      await database.pool.query<{ f: string }>(
        `SELECT string_agg(t.table_name || ':' || (xpath('/row/h/text()', query_to_xml(format('SELECT count(*) || md5(coalesce(string_agg(x::text, ''|'' ORDER BY x::text), '''')) AS h FROM %I x', t.table_name), false, true, '')))[1]::text, ',' ORDER BY t.table_name) AS f
           FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'`,
      )
    ).rows[0]!.f;
  const storageSnapshot = async () => (await readdir(storageDir).catch(() => [] as string[])).sort();

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-scorm-api-'));
    storageDir = join(root, 'store');
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const [outsider] = await database.db.insert(users).values({ email: 'outsider@academiapath.example', givenName: 'Test', familyName: 'Outsider' }).returning();
    await database.db.insert(userCredentials).values({ userId: outsider!.id, passwordHash: await hashPassword(PASSWORD) });
    app = buildApp({ config: config(), database: database.db });
    await app.ready();
    for (const who of ['admin', 'instructor', 'reviewer', 'ta', 'student', 'outsider']) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `${who}@academiapath.example`, password: PASSWORD }, headers: { origin: ORIGIN } });
      sessions.set(who, { token: res.cookies.find((c) => c.name === COOKIE)!.value, csrf: ok(res).csrfToken });
    }
    const program = ok(await call('admin', 'POST', '/programs', { code: 'SC', name: 'SCORM' }), 201).id;
    const term = ok(await call('admin', 'POST', '/terms', { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' }), 201).id;
    const template = ok(await call('admin', 'POST', '/course-templates', { code: 'SC-T', programId: program, title: 'SCORM course', sections: [{ title: 'Unit 1' }] }), 201).templateId;
    for (const key of ['course', 'otherCourse'] as const) {
      ids[key] = ok(await call('admin', 'POST', '/courses', { programId: program, termId: term, templateId: template, code: `SC-${key}`, status: 'published' }), 201).id;
    }
    for (const [who, role] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['ta', 'non_editing_instructor'], ['student', 'student']] as const) {
      ok(await call('admin', 'POST', `/courses/${ids.course}/enrollments`, { email: `${who}@academiapath.example`, role }), 201);
    }
    ok(await call('admin', 'POST', `/courses/${ids.otherCourse}/enrollments`, { email: 'outsider@academiapath.example', role: 'instructor' }), 201);
    ids.unit = ok(await call('admin', 'GET', `/courses/${ids.course}/sections`)).items[0].id;
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('content editors and administrators get the full report; nothing is written to the database or to storage', async () => {
    const before = await fingerprint();
    const files = await storageSnapshot();
    const bytes = SCORM_FIXTURES.scorm12Multi();
    for (const who of ['instructor', 'reviewer', 'admin']) {
      const res = await inspect(who, bytes, { fileName: 'pm-basics.zip' });
      assert.equal(res.statusCode, 200, `${who}: ${res.body}`);
      assert.equal(res.headers['cache-control'], 'no-store');
      // The response schema keeps every field of the report.
      assert.deepEqual(res.json(), await inspectPackage(bytes, { fileName: 'pm-basics.zip' }));
    }
    for (const fixture of ['scorm2004Sequencing', 'pathTraversal', 'zipBombRatio', 'externalEntity', 'commonCartridge', 'notZip'] as const) {
      const report = ok(await inspect('instructor', SCORM_FIXTURES[fixture](), { fileName: `${fixture}.zip` })) as ScormInspectionReport;
      assert.equal(report.status, fixture === 'scorm2004Sequencing' ? 'valid_with_warnings' : 'invalid', fixture);
    }
    assert.equal(await fingerprint(), before, 'no row was inserted, changed or deleted (no activity, audit entry or document)');
    assert.deepEqual(await storageSnapshot(), files, 'nothing was stored');
  });

  it('students, non-editing instructors and other courses get the normal permission answers', async () => {
    const bytes = SCORM_FIXTURES.scorm12Single();
    problem(await inspect('student', bytes), 403, 'FORBIDDEN');
    problem(await inspect('ta', bytes), 403, 'FORBIDDEN');
    problem(await inspect('outsider', bytes), 404, 'NOT_FOUND');
    problem(await inspect(null, bytes), 401, 'UNAUTHENTICATED');
    problem(await inspect('instructor', bytes, { courseId: '00000000-0000-4000-8000-000000000000' }), 404, 'NOT_FOUND');
    assert.equal((await inspect('outsider', bytes, { courseId: ids.otherCourse })).statusCode, 200, 'an instructor of their own course may inspect');
  });

  it('CSRF and Origin protections apply before the upload is read', async () => {
    const bytes = SCORM_FIXTURES.scorm12Single();
    problem(await inspect('instructor', bytes, { csrf: false }), 403, 'CSRF_TOKEN_INVALID');
    problem(await inspect('instructor', bytes, { origin: 'https://attacker.example' }), 403, 'ORIGIN_NOT_ALLOWED');
  });

  it('upload rules: multipart only, one "file" part, .zip only, 25 MB at most', async () => {
    problem(await call('instructor', 'POST', `/courses/${ids.course}/scorm-inspections`, { file: 'x' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    problem(await inspect('instructor', SCORM_FIXTURES.scorm12Single(), { field: 'package' }), 400, 'VALIDATION_ERROR');
    problem(await inspect('instructor', SCORM_FIXTURES.scorm12Single(), { fileName: 'course.pdf' }), 415, 'UNSUPPORTED_FILE_TYPE');
    problem(await inspect('instructor', Buffer.alloc(SCORM_LIMITS.maxPackageBytes + 1)), 413, 'PAYLOAD_TOO_LARGE');
    const large = largeValidPackage(20);
    const report = ok(await inspect('instructor', large, { fileName: 'video-course.zip' })) as ScormInspectionReport;
    assert.equal(report.status, 'valid', 'a 20 MB package is inspected in full');
    assert.equal(report.package.compressedBytes, large.length);
  });

  it('document uploads are unaffected by the SCORM route', async () => {
    const s = sessions.get('instructor')!;
    const { payload, contentType } = multipartBody([{ name: 'file', filename: 'notes.pdf', data: makePdf([['Document upload still works', 'Synthetic page.']]) }]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/${ids.course}/sections/${ids.unit}/documents`,
      payload,
      cookies: { [COOKIE]: s.token },
      headers: { 'content-type': contentType, 'x-csrf-token': s.csrf, origin: ORIGIN },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal((await storageSnapshot()).length, 1, 'only the document upload stored a file');
  });

  it('inspections are rate limited per user (30 per 10 minutes)', async () => {
    const limited = buildApp({ config: config(), database: database.db });
    await limited.ready();
    try {
      const statuses: number[] = [];
      for (let n = 0; n < 31; n += 1) statuses.push((await inspect('admin', SCORM_FIXTURES.notZip(), { target: limited })).statusCode);
      assert.deepEqual([statuses.slice(0, 30).every((status) => status === 200), statuses[30]], [true, 429]);
      assert.equal((await inspect('instructor', SCORM_FIXTURES.notZip(), { target: limited })).statusCode, 200, 'the limit is per user');
    } finally {
      await limited.close();
    }
  });
});
