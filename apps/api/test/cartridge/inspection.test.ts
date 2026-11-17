/**
 * AP-038D: Common Cartridge inspection on synthetic packages (no Canvas export or third-party content). Unit tests of
 * format and version identification, the Canvas-style inventory and classification, archive and XML safety, broken
 * references and limits; the isolated worker; and the dry-run API (roles, CSRF/Origin, upload rules, rate limit, no
 * database or storage writes). The API part needs TEST_DATABASE_URL.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { inspectCartridge } from '../../src/cartridge/inspect.js';
import { inspectCartridgeInWorker } from '../../src/cartridge/inspection.js';
import { CARTRIDGE_ISSUE_CODES, CARTRIDGE_LIMITS, type CartridgeInspectionReport, type CartridgeIssueCode } from '../../src/cartridge/report.js';
import { loadConfig } from '../../src/config.js';
import { userCredentials, users } from '../../src/db/schema/index.js';
import { ARCHIVE_PROBLEMS } from '../../src/scorm/archive.js';
import { withPackageSlot } from '../../src/scorm/inspection.js';
import { CARTRIDGE_FIXTURES, type CartridgeFixture } from '../helpers/cartridge.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { multipartBody } from '../helpers/documents.js';

const inspect = (name: CartridgeFixture) => inspectCartridge(CARTRIDGE_FIXTURES[name](), { fileName: `/srv/uploads/${name}.imscc` });
const codes = (report: CartridgeInspectionReport) => report.issues.map((issue) => issue.code);
const resource = (report: CartridgeInspectionReport, identifier: string) => report.resources.find((entry) => entry.identifier === identifier)!;
function refused(report: CartridgeInspectionReport, code: CartridgeIssueCode) {
  assert.equal(report.status, 'invalid', JSON.stringify(report.issues));
  assert.ok(codes(report).includes(code), `${code} in ${codes(report).join(', ')}`);
  assert.equal(report.imported, false);
}

describe('Common Cartridge identification (unit)', () => {
  for (const version of ['1.0', '1.1', '1.2', '1.3'] as const) {
    it(`Common Cartridge ${version}: identified from the manifest, not the file name`, async () => {
      const report = await inspect(`cc${version.replace('.', '')}` as CartridgeFixture);
      assert.deepEqual([report.status, report.format, report.version, report.canvas.detected], ['valid', 'common_cartridge', version, false]);
      assert.equal(report.declared.schemaVersion, `${version}.0`);
      assert.equal(report.title, `Cartridge ${version}`);
      assert.deepEqual(
        report.resources.map((entry) => [entry.kind, entry.classification, entry.target]),
        [
          ['page', 'transform', 'lesson'],
          ['web_link', 'mappable', 'link'],
          ['file', 'mappable', 'document'],
        ],
      );
      assert.equal(report.package.fileName, `cc${version.replace('.', '')}.imscc`, 'only the base name, never a server path');
    });
  }

  it('a newer or unknown version gets an unsupported-version report instead of being parsed as a known one', async () => {
    for (const name of ['unsupportedVersion', 'unknownNamespace'] as const) {
      const report = await inspect(name);
      refused(report, 'CARTRIDGE_VERSION_UNSUPPORTED');
      assert.equal(report.version, null);
      assert.deepEqual([report.resources.length, report.modules.length, report.counts.resources], [0, 0, 0], `${name}: nothing was classified`);
      assert.match(report.declared.namespace ?? '', /imsccv1p4/);
    }
    assert.equal((await inspect('unsupportedVersion')).issues[0]!.value, '1.4.0');
  });

  it('an undeclared or contradictory version is identified with a warning', async () => {
    const undeclared = await inspect('undeclaredVersion');
    assert.deepEqual([undeclared.status, undeclared.version, codes(undeclared)], ['valid_with_warnings', '1.3', ['CARTRIDGE_VERSION_UNDECLARED']]);
    const mismatch = await inspect('versionMismatch');
    assert.deepEqual([mismatch.status, mismatch.version, codes(mismatch)], ['valid_with_warnings', '1.2', ['CARTRIDGE_VERSION_MISMATCH']]);
  });

  it('Thin Common Cartridge, SCORM and plain content packages are told apart', async () => {
    const thin = await inspect('thin');
    assert.deepEqual([thin.format, thin.version, thin.status, codes(thin)], ['thin_common_cartridge', '1.3', 'valid_with_warnings', ['CARTRIDGE_THIN']]);
    assert.deepEqual(thin.resources.map((entry) => [entry.kind, entry.classification]), [['web_link', 'mappable'], ['lti_link', 'unsupported']]);
    const scorm = await inspect('scorm');
    refused(scorm, 'CARTRIDGE_IS_SCORM');
    assert.equal(scorm.format, 'scorm');
    const plain = await inspect('contentPackage');
    refused(plain, 'CARTRIDGE_NOT_CARTRIDGE');
    assert.equal(plain.format, 'ims_content_package');
  });
});

describe('Canvas-style export inventory (unit)', () => {
  it('organization, resources, classification, Canvas extensions and the compatibility summary', async () => {
    const report = await inspect('canvas');
    assert.deepEqual([report.status, report.format, report.version, report.title, report.language], ['valid_with_warnings', 'common_cartridge', '1.1', 'Synthetic Canvas course', 'es']);
    assert.equal(report.canvas.detected, true);
    for (const signal of ['course_settings/canvas_export.txt', 'course_settings/module_meta.xml', 'non_cc_assessments/', 'xmlns: canvas.instructure.com']) assert.ok(report.canvas.signals.includes(signal), signal);

    // Outline: modules are the root item's children; a nested folder is flagged; a text heading has no resource.
    assert.deepEqual(report.modules.map((module) => [module.title, module.itemCount]), [['Unit 1 - Foundations', 6], ['Unit 2 - Practice', 7]]);
    assert.deepEqual(report.modules[0]!.items.find((item) => item.title === 'Notes'), { title: 'Notes', identifierref: 'page2', kind: 'page', classification: 'transform', depth: 2 });
    assert.deepEqual(report.modules[1]!.items.at(-1), { title: 'Section heading', identifierref: null, kind: null, classification: null, depth: 1 });

    const expected: Array<[string, string, string, string | null, boolean]> = [
      ['settings', 'canvas_settings', 'recognized', null, true],
      ['page1', 'page', 'transform', 'lesson', false],
      ['page2', 'page', 'transform', 'lesson', false],
      ['pdf', 'file', 'mappable', 'document', false],
      ['img', 'file', 'recognized', null, false],
      ['video', 'file', 'unsupported', null, false],
      ['quiz1', 'assessment', 'mappable', 'quiz', true],
      ['quiz1meta', 'learning_application', 'recognized', null, true],
      ['quiz2', 'assessment', 'transform', 'quiz', false],
      ['quiz3', 'assessment', 'unsupported', 'quiz', true],
      ['bank', 'question_bank', 'unsupported', null, false],
      ['assign', 'assignment', 'transform', 'assignment', true],
      ['topic', 'discussion', 'transform', 'forum', false],
      ['link', 'web_link', 'mappable', 'link', false],
      ['tool', 'lti_link', 'unsupported', null, false],
      ['mystery', 'unknown', 'unsupported', null, false],
    ];
    assert.deepEqual(report.resources.map((entry) => [entry.identifier, entry.kind, entry.classification, entry.target, entry.canvas]), expected);

    // Details read from descriptors (never executed or fetched).
    assert.deepEqual(resource(report, 'quiz1').questionTypes, [
      { type: 'multiple_choice', count: 1, supported: true },
      { type: 'true_false', count: 1, supported: true },
      { type: 'multiple_response', count: 1, supported: true },
    ]);
    assert.deepEqual(resource(report, 'quiz3').questionTypes.map((entry) => [entry.type, entry.supported]), [['essay', false], ['matching', false]]);
    assert.equal(report.counts.questions, 10);
    assert.deepEqual(resource(report, 'assign').submissionTypes, ['online_upload', 'online_text_entry']);
    assert.deepEqual([resource(report, 'link').url, resource(report, 'tool').url], ['https://example.edu/reading-list', 'https://tool.example.edu/launch']);
    assert.deepEqual([resource(report, 'topic').title, resource(report, 'pdf').title], ['Introductions', 'Course syllabus']);
    const page = resource(report, 'page1');
    assert.deepEqual([page.externalLinks, page.brokenLinks, page.canvasLinks], [1, 1, 1], 'image found, missing handout broken, external and Canvas links counted');
    assert.deepEqual([report.counts.externalLinks, report.counts.brokenReferences], [1, 1]);

    assert.deepEqual(codes(report).sort(), [
      'CARTRIDGE_CANVAS_EXTENSIONS',
      'CARTRIDGE_LINK_BROKEN',
      'CARTRIDGE_ORGANIZATION_NESTED',
      'CARTRIDGE_QUESTION_TYPE_UNSUPPORTED',
      'CARTRIDGE_QUESTION_TYPE_UNSUPPORTED',
      'CARTRIDGE_RESOURCE_TYPE_UNKNOWN',
    ]);
    assert.deepEqual(report.counts.byClassification, { recognized: 3, mappable: 3, transform: 5, unsupported: 5, invalid: 0 });
    assert.deepEqual(
      report.compatibility.map((row) => `${row.kind}:${row.count}:${row.target}:${row.support}`),
      [
        'module:2:section:transform',
        'page:2:lesson:transform',
        'file:1:document:direct',
        'file:1:null:new_functionality',
        'assessment:1:quiz:direct',
        'assessment:1:quiz:transform',
        'assessment:1:quiz:new_functionality',
        'question_bank:1:null:new_functionality',
        'assignment:1:assignment:transform',
        'discussion:1:forum:transform',
        'web_link:1:link:direct',
        'lti_link:1:null:new_functionality',
        'unknown:1:null:unsupported',
      ],
    );
    assert.equal(report.imported, false);
  });

  it('no address in the package is fetched and no server path is reported', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => {
      throw new Error('network access is not allowed');
    });
    try {
      const report = await inspect('canvas');
      assert.equal(fetchMock.mock.callCount(), 0);
      const raw = JSON.stringify(report);
      assert.ok(!raw.includes('/srv/uploads') && !raw.includes(tmpdir()) && !raw.includes(process.cwd()));
    } finally {
      fetchMock.mock.restore();
    }
  });
});

describe('Common Cartridge safety and broken content (unit)', () => {
  it('unsafe archives are refused before anything is read', async () => {
    const cases: Array<[CartridgeFixture, CartridgeIssueCode]> = [
      ['notZip', 'CARTRIDGE_ARCHIVE_INVALID'],
      ['truncated', 'CARTRIDGE_ARCHIVE_INVALID'],
      ['empty', 'CARTRIDGE_ARCHIVE_EMPTY'],
      ['traversal', 'CARTRIDGE_PATH_TRAVERSAL'],
      ['absolutePath', 'CARTRIDGE_PATH_ABSOLUTE'],
      ['duplicatePaths', 'CARTRIDGE_PATH_DUPLICATE'],
      ['symlink', 'CARTRIDGE_ENTRY_SYMLINK'],
      ['zipBomb', 'CARTRIDGE_ENTRY_EXPANSION_RATIO'],
      ['tooManyEntries', 'CARTRIDGE_ARCHIVE_TOO_MANY_ENTRIES'],
    ];
    for (const [name, code] of cases) {
      const report = await inspect(name);
      refused(report, code);
      assert.equal(report.format, 'unknown', `${name}: the manifest was not read`);
    }
  });

  it('manifest problems: missing, nested, malformed, and a DOCTYPE (external entities are never expanded or fetched)', async () => {
    refused(await inspect('missingManifest'), 'CARTRIDGE_MANIFEST_MISSING');
    const nested = await inspect('nestedManifest');
    refused(nested, 'CARTRIDGE_MANIFEST_NESTED');
    assert.equal(nested.issues[0]!.path, 'course/imsmanifest.xml');
    refused(await inspect('malformedManifest'), 'CARTRIDGE_MANIFEST_MALFORMED');
    const doctype = await inspect('doctypeManifest');
    refused(doctype, 'CARTRIDGE_MANIFEST_DOCTYPE');
    assert.ok(!JSON.stringify(doctype).includes('root:'), 'no file content was read through an entity');
  });

  it('broken and unsafe references are reported and the resources marked invalid', async () => {
    const report = await inspect('brokenReferences');
    assert.equal(report.status, 'invalid');
    assert.deepEqual(codes(report).sort(), [
      'CARTRIDGE_DEPENDENCY_MISSING',
      'CARTRIDGE_ITEM_RESOURCE_MISSING',
      'CARTRIDGE_RESOURCE_HREF_DANGEROUS',
      'CARTRIDGE_RESOURCE_HREF_EXTERNAL',
      'CARTRIDGE_RESOURCE_HREF_OUTSIDE',
      'CARTRIDGE_RESOURCE_IDENTIFIER_DUPLICATE',
    ]);
    assert.deepEqual(report.resources.map((entry) => entry.classification), ['transform', 'invalid', 'invalid', 'invalid', 'invalid']);
    const missing = await inspect('missingResource');
    refused(missing, 'CARTRIDGE_RESOURCE_FILE_MISSING');
    assert.deepEqual([missing.resources[0]!.classification, missing.resources[0]!.missingFileCount, missing.counts.brokenReferences], ['invalid', 1, 1]);
  });

  it('unsafe descriptors: entity expansion refused, insecure and script links, an unsupported QTI version', async () => {
    const report = await inspect('unsafeDescriptors');
    assert.equal(report.status, 'invalid');
    assert.deepEqual(codes(report), ['CARTRIDGE_DESCRIPTOR_DOCTYPE', 'CARTRIDGE_WEBLINK_INSECURE', 'CARTRIDGE_LINK_DANGEROUS', 'CARTRIDGE_QTI_VERSION_UNSUPPORTED']);
    assert.deepEqual(report.resources.map((entry) => [entry.identifier, entry.classification]), [['q1', 'invalid'], ['l1', 'transform'], ['l2', 'invalid'], ['q2', 'unsupported']]);
  });

  it('size limits: an oversized page is not read; large manifests keep complete counts with bounded lists', async () => {
    const big = await inspect('oversizedPage');
    assert.deepEqual([big.status, codes(big)], ['valid_with_warnings', ['CARTRIDGE_DESCRIPTOR_LIMIT']]);
    assert.equal(big.issues[0]!.limit, CARTRIDGE_LIMITS.maxDescriptorBytes);
    const many = await inspect('manyResources');
    assert.deepEqual([many.counts.resources, many.counts.outlineItems, many.resources.length, many.listsTruncated], [520, 520, CARTRIDGE_LIMITS.maxListed, true]);
    assert.equal(many.counts.byClassification.mappable, 520);
  });

  it('every issue code has a message, and every archive problem has a Common Cartridge code', () => {
    for (const problem of ARCHIVE_PROBLEMS) assert.ok(CARTRIDGE_ISSUE_CODES.includes(`CARTRIDGE_${problem}` as CartridgeIssueCode), problem);
    assert.equal(new Set(CARTRIDGE_ISSUE_CODES).size, CARTRIDGE_ISSUE_CODES.length);
  });
});

describe('Common Cartridge inspection worker', () => {
  it('gives the same report in the isolated worker, and stops at its time limit', async () => {
    const bytes = CARTRIDGE_FIXTURES.canvas();
    assert.deepEqual(await inspectCartridgeInWorker(bytes, { fileName: 'course.imscc' }), await inspectCartridge(bytes, { fileName: 'course.imscc' }));
    const limited = await inspectCartridgeInWorker(CARTRIDGE_FIXTURES.manyResources(), { fileName: 'big.imscc', timeoutMs: 1 });
    refused(limited, 'CARTRIDGE_INSPECTION_LIMIT');
  });

  it('shares the SCORM inspection worker pool: no more than two package workers run at once in one API process', async () => {
    const releases: Array<() => void> = [];
    const held = [0, 1].map(() => withPackageSlot(() => new Promise<void>((resolve) => releases.push(resolve))));
    let done = false;
    const waiting = inspectCartridgeInWorker(CARTRIDGE_FIXTURES.cc13(), { fileName: 'course.imscc' }).then((report) => {
      done = true;
      return report;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(done, false, 'the cartridge inspection waits while two SCORM inspections hold both slots');
    releases.shift()!();
    assert.equal((await waiting).status, 'valid');
    releases.shift()!();
    await Promise.all(held);
  });
});

describe('Common Cartridge inspection API (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  const PASSWORD = randomBytes(18).toString('base64url');
  const COOKIE = 'ap_session';
  const ORIGIN = 'http://localhost:3000';
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let root: string;
  let storageDir: string;
  const sessions = new Map<string, { token: string; csrf: string }>();
  const ids = {} as Record<'course' | 'otherCourse', string>;
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
  const upload = (who: string | null, bytes: Buffer, options: { courseId?: string; fileName?: string; field?: string; csrf?: boolean; origin?: string; target?: ReturnType<typeof buildApp> } = {}) => {
    const s = who ? sessions.get(who)! : null;
    const { payload, contentType } = multipartBody([{ name: options.field ?? 'file', filename: options.fileName ?? 'course.imscc', contentType: 'application/zip', data: bytes }]);
    return (options.target ?? app).inject({
      method: 'POST',
      url: `/api/v1/courses/${options.courseId ?? ids.course}/cartridge-inspections`,
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
    root = await mkdtemp(join(tmpdir(), 'ap-cartridge-api-'));
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
    const program = ok(await call('admin', 'POST', '/programs', { code: 'CC', name: 'Cartridges' }), 201).id;
    const term = ok(await call('admin', 'POST', '/terms', { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' }), 201).id;
    const template = ok(await call('admin', 'POST', '/course-templates', { code: 'CC-T', programId: program, title: 'Cartridge course', sections: [{ title: 'Unit 1' }] }), 201).templateId;
    for (const key of ['course', 'otherCourse'] as const) {
      ids[key] = ok(await call('admin', 'POST', '/courses', { programId: program, termId: term, templateId: template, code: `CC-${key}`, status: 'published' }), 201).id;
    }
    for (const [who, role] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['ta', 'non_editing_instructor'], ['student', 'student']] as const) {
      ok(await call('admin', 'POST', `/courses/${ids.course}/enrollments`, { email: `${who}@academiapath.example`, role }), 201);
    }
    ok(await call('admin', 'POST', `/courses/${ids.otherCourse}/enrollments`, { email: 'outsider@academiapath.example', role: 'instructor' }), 201);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('content editors and administrators get the report; nothing is written to the database or to storage', async () => {
    const before = await fingerprint();
    const files = await storageSnapshot();
    for (const who of ['instructor', 'reviewer', 'admin']) {
      const res = await upload(who, CARTRIDGE_FIXTURES.canvas());
      const report = ok(res) as CartridgeInspectionReport;
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.deepEqual([report.format, report.version, report.canvas.detected, report.counts.resources, report.imported], ['common_cartridge', '1.1', true, 16, false]);
    }
    for (const name of ['traversal', 'doctypeManifest', 'unsupportedVersion', 'brokenReferences'] as const) assert.equal(ok(await upload('instructor', CARTRIDGE_FIXTURES[name]())).status, 'invalid', name);
    assert.equal(ok(await upload('instructor', CARTRIDGE_FIXTURES.cc13(), { fileName: 'course.zip' })).version, '1.3', '.zip is accepted too');
    assert.equal(await fingerprint(), before, 'no row was inserted, changed or deleted (no course content, audit entry or document)');
    assert.deepEqual(await storageSnapshot(), files, 'nothing was stored');
  });

  it('students, non-editing instructors, other courses and anonymous callers get the normal permission answers', async () => {
    const bytes = CARTRIDGE_FIXTURES.cc11();
    problem(await upload('student', bytes), 403, 'FORBIDDEN');
    problem(await upload('ta', bytes), 403, 'FORBIDDEN');
    problem(await upload('outsider', bytes), 404, 'NOT_FOUND');
    problem(await upload(null, bytes), 401, 'UNAUTHENTICATED');
    problem(await upload('instructor', bytes, { courseId: '00000000-0000-4000-8000-000000000000' }), 404, 'NOT_FOUND');
    assert.equal(ok(await upload('outsider', bytes, { courseId: ids.otherCourse })).status, 'valid', 'an instructor of the other course may inspect there');
  });

  it('CSRF and Origin protections apply before the upload is read', async () => {
    const bytes = CARTRIDGE_FIXTURES.cc11();
    problem(await upload('instructor', bytes, { csrf: false }), 403, 'CSRF_TOKEN_INVALID');
    problem(await upload('instructor', bytes, { origin: 'https://attacker.example' }), 403, 'ORIGIN_NOT_ALLOWED');
  });

  it('upload rules: multipart only, one "file" part, .imscc or .zip only, 25 MB at most', async () => {
    problem(await call('instructor', 'POST', `/courses/${ids.course}/cartridge-inspections`, { file: 'x' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    problem(await upload('instructor', CARTRIDGE_FIXTURES.cc11(), { field: 'package' }), 400, 'VALIDATION_ERROR');
    problem(await upload('instructor', CARTRIDGE_FIXTURES.cc11(), { fileName: 'course.pdf' }), 415, 'UNSUPPORTED_FILE_TYPE');
    problem(await upload('instructor', Buffer.alloc(CARTRIDGE_LIMITS.maxPackageBytes + 1)), 413, 'PAYLOAD_TOO_LARGE');
  });

  it('inspections are rate limited per user (30 per 10 minutes)', async () => {
    const limited = buildApp({ config: config(), database: database.db });
    await limited.ready();
    try {
      const statuses: number[] = [];
      for (let n = 0; n < 31; n += 1) statuses.push((await upload('admin', CARTRIDGE_FIXTURES.notZip(), { target: limited })).statusCode);
      assert.deepEqual([statuses.slice(0, 30).every((status) => status === 200), statuses[30]], [true, 429]);
      assert.equal((await upload('instructor', CARTRIDGE_FIXTURES.notZip(), { target: limited })).statusCode, 200, 'the limit is per user');
    } finally {
      await limited.close();
    }
  });
});
