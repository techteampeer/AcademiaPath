/**
 * AP-038C2E: the feature-gated archive import confirmation API (POST /api/v1/course-imports/archive) on a disposable
 * PostgreSQL database and a private temporary storage directory. Archives are synthetic (test/helpers/archives.ts) or
 * exported through the API from a course created here. Covered: the gate (off by default, refused in production),
 * who may import, a valid import with PDF, DOCX and PPTX, a real course round trip that leaves the source and its people
 * untouched, refusals before anything is written, real-HTTP truncated uploads, replay and concurrency, rate limits,
 * storage and database failures, and sanitized responses and audit records.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
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
import { LocalDocumentStorage, type DocumentStorage } from '../../src/documents/storage.js';
import { ARCHIVE_VALIDATION_LIMITS } from '../../src/portability/archive-validation.js';
import { ARCHIVE_MANIFEST_PATH } from '../../src/portability/course-archive.js';
import { ARCHIVE_IMPORT_RATE_LIMIT } from '../../src/routes/course-archive-confirm.js';
import { withPackageSlot } from '../../src/scorm/inspection.js';
import { dataOf, editJson, exported, OFFICE, replace, tampered } from '../helpers/archives.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { makePdf, multipartBody } from '../helpers/documents.js';
import { rawUpload } from '../helpers/uploads.js';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const URL_PATH = '/api/v1/course-imports/archive';

describe('course archive import confirmation API (AP-038C2E, PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  const PASSWORD = randomBytes(18).toString('base64url');
  const COOKIE = 'ap_session';
  const ORIGIN = 'http://localhost:3000';
  const ADMINS = Array.from({ length: 8 }, (_, i) => `importer${i + 1}`);
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let storageDir: string;
  type App = Awaited<ReturnType<typeof buildApp>>;
  let app: App;
  const sessions = new Map<string, { token: string; csrf: string }>();
  const ids = {} as Record<'program' | 'inactiveProgram' | 'term' | 'source' | 'sourceSection', string>;
  let sourceArchive: Buffer;
  let sourcePdf: Buffer;
  let nextAdmin = 0;
  /** A different administrator for each call, so that no test reaches the per-administrator rate limit by accident. */
  const admin = () => ADMINS[nextAdmin++ % ADMINS.length]!;

  const config = (env: Record<string, string> = {}) =>
    loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir, ARCHIVE_IMPORT_ENABLED: 'true', ...env });
  const newApp = async (options: { env?: Record<string, string>; storage?: DocumentStorage; db?: typeof database.db } = {}) => {
    const instance = buildApp({ config: config(options.env), database: options.db ?? database.db, ...(options.storage ? { documents: { storage: options.storage } } : {}) });
    await instance.ready();
    return instance;
  };
  const ok = (res: LightMyRequestResponse, status = 200) => {
    assert.equal(res.statusCode, status, res.body);
    return res.json();
  };
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
    assert.doesNotMatch(res.body, /stack|storageKey|storage_key|\/(srv|var|tmp|home|app|root)\/|\bat \S+:\d+:\d+|simulated/i, 'no internals in the problem');
  };
  const call = (who: string, method: 'GET' | 'POST', url: string, payload?: object) => {
    const s = sessions.get(who)!;
    return app.inject({ method, url: `/api/v1${url}`, ...(payload ? { payload } : {}), cookies: { [COOKIE]: s.token }, headers: method === 'POST' ? { 'x-csrf-token': s.csrf, origin: ORIGIN } : {} });
  };
  type ImportOptions = { target?: App; csrf?: boolean; origin?: string; fileName?: string; extraFields?: Record<string, string>; fieldsAfterFile?: boolean; noFile?: boolean };
  const fieldsFor = (code: string, extra: Record<string, string> = {}) => ({ programId: ids.program, termId: ids.term, code, ...extra });
  const importArchive = (who: string | null, archive: Buffer, fields: Record<string, string>, options: ImportOptions = {}) => {
    const s = who ? sessions.get(who)! : null;
    const formFields = Object.entries({ ...fields, ...options.extraFields }).map(([name, value]) => ({ name, value }));
    const file = { name: 'file', filename: options.fileName ?? 'course-archive.zip', contentType: 'application/zip', data: archive };
    const { payload, contentType } = multipartBody(options.noFile ? formFields : options.fieldsAfterFile ? [file, ...formFields] : [...formFields, file]);
    return (options.target ?? app).inject({
      method: 'POST',
      url: URL_PATH,
      payload,
      cookies: s ? { [COOKIE]: s.token } : {},
      headers: { 'content-type': contentType, origin: options.origin ?? ORIGIN, ...(s && options.csrf !== false ? { 'x-csrf-token': s.csrf } : {}) },
    });
  };
  /** Every row of every table, hashed: proves that nothing was written. */
  const fingerprint = async (except: string[] = []) =>
    (
      await database.pool.query<{ f: string }>(
        `SELECT string_agg(t.table_name || ':' || (xpath('/row/h/text()', query_to_xml(format('SELECT count(*) || md5(coalesce(string_agg(x::text, ''|'' ORDER BY x::text), '''')) AS h FROM %I x', t.table_name), false, true, '')))[1]::text, ',' ORDER BY t.table_name) AS f
           FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND t.table_name <> ALL($1::text[])`,
        [except],
      )
    ).rows[0]!.f;
  const storedFiles = async () => (await readdir(storageDir, { recursive: true }).catch(() => [] as string[])).sort();
  const query = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query<T>(sql, params)).rows;
  const coursesWithCode = async (code: string) => Number((await query<{ n: string }>('SELECT count(*) AS n FROM courses WHERE code = $1', [code]))[0]!.n);
  /** Rows and files must be exactly as before: nothing created, nothing left behind. */
  const unchanged = async (snapshot: { rows: string; files: string[] }, label: string) => {
    assert.equal(await fingerprint(), snapshot.rows, `${label}: no row was written`);
    assert.deepEqual(await storedFiles(), snapshot.files, `${label}: no file was stored or left behind`);
  };
  const snapshot = async () => ({ rows: await fingerprint(), files: await storedFiles() });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ap-archive-import-api-'));
    storageDir = join(root, 'store');
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    for (const who of ADMINS) {
      const [user] = await database.db
        .insert(users)
        .values({ email: `${who}@academiapath.example`, givenName: 'Test', familyName: who, systemRole: 'administrator' })
        .returning();
      await database.db.insert(userCredentials).values({ userId: user!.id, passwordHash: await hashPassword(PASSWORD) });
    }
    app = await newApp();
    for (const who of ['admin', 'instructor', 'reviewer', 'ta', 'student', ...ADMINS]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `${who}@academiapath.example`, password: PASSWORD }, headers: { origin: ORIGIN } });
      sessions.set(who, { token: res.cookies.find((c) => c.name === COOKIE)!.value, csrf: ok(res).csrfToken });
    }
    ids.program = ok(await call('admin', 'POST', '/programs', { code: 'ARI', name: 'Archive imports' }), 201).id;
    ids.inactiveProgram = ok(await call('admin', 'POST', '/programs', { code: 'ARI-OLD', name: 'Closed program' }), 201).id;
    ok(
      await app.inject({
        method: 'PUT',
        url: `/api/v1/programs/${ids.inactiveProgram}`,
        payload: { name: 'Closed program', isActive: false },
        cookies: { [COOKIE]: sessions.get('admin')!.token },
        headers: { 'x-csrf-token': sessions.get('admin')!.csrf, origin: ORIGIN },
      }),
    );
    ids.term = ok(await call('admin', 'POST', '/terms', { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' }), 201).id;
    const template = ok(await call('admin', 'POST', '/course-templates', { code: 'ARI-T', programId: ids.program, title: 'Archive source course', sections: [{ title: 'Unit 1' }] }), 201).templateId;
    ids.source = ok(await call('admin', 'POST', '/courses', { programId: ids.program, termId: ids.term, templateId: template, code: 'ARI-SRC', status: 'published' }), 201).id;
    ids.sourceSection = ok(await call('admin', 'GET', `/courses/${ids.source}/sections`)).items[0].id;
    // The source course's people: they must never travel with the archive.
    for (const [who, role] of [
      ['instructor', 'instructor'],
      ['student', 'student'],
    ] as const) {
      ok(await call('admin', 'POST', `/courses/${ids.source}/enrollments`, { email: `${who}@academiapath.example`, role }), 201);
    }
    sourcePdf = makePdf([['Archive import source handout', 'A synthetic page of the source course, long enough to be summarized by the mock provider.']]);
    const { payload, contentType } = multipartBody([{ name: 'file', filename: 'source-handout.pdf', contentType: 'application/pdf', data: sourcePdf }]);
    ok(
      await app.inject({
        method: 'POST',
        url: `/api/v1/courses/${ids.source}/sections/${ids.sourceSection}/documents`,
        payload,
        cookies: { [COOKIE]: sessions.get('admin')!.token },
        headers: { 'content-type': contentType, 'x-csrf-token': sessions.get('admin')!.csrf, origin: ORIGIN },
      }),
      201,
    );
    const archive = await call('admin', 'GET', `/courses/${ids.source}/export/archive`);
    assert.equal(archive.statusCode, 200, archive.body);
    sourceArchive = archive.rawPayload;
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('is off by default: refused before the upload is read; the setting is refused in production and must be true or false', async () => {
    const disabled = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir }), database: database.db });
    await disabled.ready();
    try {
      assert.equal(loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: storageDir }).archiveImport.enabled, false);
      const before = await snapshot();
      problem(await importArchive(admin(), await exported(), fieldsFor('ARI-OFF'), { target: disabled }), 403, 'ARCHIVE_IMPORT_DISABLED');
      problem(await importArchive(admin(), Buffer.alloc(ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes + 1), fieldsFor('ARI-OFF'), { target: disabled }), 403, 'ARCHIVE_IMPORT_DISABLED');
      await unchanged(before, 'disabled');
      assert.equal(await coursesWithCode('ARI-OFF'), 0);
    } finally {
      await disabled.close();
    }
    const production = { NODE_ENV: 'production', APP_ORIGINS: 'https://academiapath.example', DOCUMENT_STORAGE_DIR: '/mnt/documents' };
    assert.equal(loadConfig(production).archiveImport.enabled, false);
    assert.throws(() => loadConfig({ ...production, ARCHIVE_IMPORT_ENABLED: 'true' }), /ARCHIVE_IMPORT_ENABLED cannot be true in production/);
    assert.throws(() => loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: storageDir, ARCHIVE_IMPORT_ENABLED: 'yes' }), /must be true or false/);
  });

  it('availability: administrators learn whether import is enabled on this server; nobody else does', async () => {
    const disabled = await newApp({ env: { ARCHIVE_IMPORT_ENABLED: 'false' } });
    try {
      const get = (target: App, who: string | null) => target.inject({ method: 'GET', url: '/api/v1/course-imports/archive/availability', cookies: who ? { [COOKIE]: sessions.get(who)!.token } : {} });
      const enabled = await get(app, 'admin');
      assert.deepEqual([enabled.statusCode, enabled.json(), enabled.headers['cache-control']], [200, { enabled: true }, 'no-store']);
      assert.deepEqual(ok(await get(disabled, 'admin')), { enabled: false });
      for (const who of ['instructor', 'reviewer', 'ta', 'student']) problem(await get(app, who), 403, 'FORBIDDEN');
      problem(await get(app, null), 401, 'UNAUTHENTICATED');
    } finally {
      await disabled.close();
    }
  });

  it('administrators only; anonymous callers must sign in; CSRF and Origin are checked before the upload is read', async () => {
    const before = await snapshot();
    const archive = await exported();
    for (const who of ['instructor', 'reviewer', 'ta', 'student']) {
      problem(await importArchive(who, archive, fieldsFor('ARI-ROLE')), 403, 'FORBIDDEN');
      problem(await importArchive(who, Buffer.alloc(ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes + 1), fieldsFor('ARI-ROLE')), 403, 'FORBIDDEN');
    }
    problem(await importArchive(null, archive, fieldsFor('ARI-ROLE')), 401, 'UNAUTHENTICATED');
    problem(await importArchive(admin(), archive, fieldsFor('ARI-ROLE'), { csrf: false }), 403, 'CSRF_TOKEN_INVALID');
    problem(await importArchive(admin(), archive, fieldsFor('ARI-ROLE'), { origin: 'https://attacker.example' }), 403, 'ORIGIN_NOT_ALLOWED');
    await unchanged(before, 'refused callers');
  });

  it('imports PDF, DOCX and PPTX into a NEW draft course: files restored byte for byte, never marked clean, sanitized audit', async () => {
    const files = await storedFiles();
    const res = await importArchive(admin(), await exported(), fieldsFor('ARI-NEW', { title: 'Imported archive course' }));
    const result = ok(res, 201);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(
      [result.course.code, result.course.title, result.course.status, result.course.programId, result.course.termId],
      ['ARI-NEW', 'Imported archive course', 'draft', ids.program, ids.term],
    );
    assert.deepEqual([result.created.units, result.created.activities, result.created.documents], [1, 4, 3]);
    assert.doesNotMatch(res.body, /storageKey|storage_key|\/store\//, 'no storage internals in the response');

    const [course] = await query<{ status: string }>('SELECT status FROM courses WHERE id = $1', [result.course.id]);
    assert.equal(course!.status, 'draft');
    const documents = await query<{ sha256: string; byte_size: number; storage_key: string; malware_scan_status: string; review_status: string }>(
      `SELECT d.sha256, d.byte_size, d.storage_key, d.malware_scan_status, a.review_status
         FROM course_documents d JOIN activities a ON a.id = d.activity_id JOIN sections s ON s.id = a.section_id
        WHERE s.course_id = $1 ORDER BY d.byte_size`,
      [result.course.id],
    );
    assert.deepEqual(documents.map((d) => d.sha256).sort(), OFFICE.map((doc) => sha256(doc.bytes)).sort());
    for (const document of documents) {
      assert.equal(sha256(await readFile(join(storageDir, document.storage_key))), document.sha256, 'the stored file is the archived file');
      assert.equal(document.malware_scan_status, 'not_scanned', 'never marked clean without a scanner');
      assert.equal(document.review_status, 'draft');
    }
    assert.equal((await storedFiles()).length, files.length + 3, 'one stored copy per document, nothing else');
    assert.equal(Number((await query<{ n: string }>('SELECT count(*) AS n FROM enrollments WHERE course_id = $1', [result.course.id]))[0]!.n), 0, 'no people');

    const audits = await query<{ action: string; metadata: unknown }>(`SELECT action, metadata FROM audit_log WHERE entity_id = $1 AND action = 'course.imported'`, [result.course.id]);
    assert.equal(audits.length, 1);
    const audit = JSON.stringify(audits[0]!.metadata);
    assert.match(audit, /"source":"archive"/);
    for (const document of documents) assert.ok(!audit.includes(document.storage_key), 'no storage key in the audit record');
  });

  it('a course exported through the API imports as a new course; the source course and its people are untouched; the preview stays read-only', async () => {
    const sourceRows = async () =>
      JSON.stringify(
        await query(
          `SELECT c.*, (SELECT json_agg(e ORDER BY e.id) FROM enrollments e WHERE e.course_id = c.id) AS enrollments,
                  (SELECT json_agg(a ORDER BY a.id) FROM activities a JOIN sections s ON s.id = a.section_id WHERE s.course_id = c.id) AS activities,
                  (SELECT json_agg(d ORDER BY d.id) FROM course_documents d JOIN activities a ON a.id = d.activity_id JOIN sections s ON s.id = a.section_id WHERE s.course_id = c.id) AS documents
             FROM courses c WHERE c.id = $1`,
          [ids.source],
        ),
      );
    const source = await sourceRows();
    // The read-only preview of the same archive writes nothing.
    const before = await snapshot();
    const preview = ok(
      await app.inject({
        method: 'POST',
        url: '/api/v1/course-imports/archive/preview',
        ...(() => {
          const { payload, contentType } = multipartBody([{ name: 'file', filename: 'source.zip', contentType: 'application/zip', data: sourceArchive }]);
          return { payload, headers: { 'content-type': contentType, 'x-csrf-token': sessions.get('admin')!.csrf, origin: ORIGIN } };
        })(),
        cookies: { [COOKIE]: sessions.get('admin')!.token },
      }),
    );
    assert.equal(preview.status, 'valid', JSON.stringify(preview.issues));
    await unchanged(before, 'preview');

    const result = ok(await importArchive(admin(), sourceArchive, fieldsFor('ARI-COPY', { versionPreference: 'working' })), 201);
    assert.notEqual(result.course.id, ids.source);
    assert.equal(result.created.documents, 1);
    const [copy] = await query<{ sha256: string; storage_key: string }>(
      'SELECT d.sha256, d.storage_key FROM course_documents d JOIN activities a ON a.id = d.activity_id JOIN sections s ON s.id = a.section_id WHERE s.course_id = $1',
      [result.course.id],
    );
    const [original] = await query<{ storage_key: string }>(
      'SELECT d.storage_key FROM course_documents d JOIN activities a ON a.id = d.activity_id JOIN sections s ON s.id = a.section_id WHERE s.course_id = $1',
      [ids.source],
    );
    assert.equal(copy!.sha256, sha256(sourcePdf), 'the document travels byte for byte');
    assert.notEqual(copy!.storage_key, original!.storage_key, 'the new course has its own stored copy');
    assert.equal(await sourceRows(), source, 'the source course, its content, documents and enrollments are unchanged');
    for (const table of ['enrollments', 'grades', 'assignment_submissions', 'quiz_attempts', 'activity_completions', 'course_certificates']) {
      const rows = await query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE course_id = $1`, [result.course.id]);
      assert.equal(Number(rows[0]!.n), 0, `no ${table} in the new course`);
    }
  });

  it('refuses invalid archives, corrupt assets and incomplete requests before anything is written', async () => {
    const before = await snapshot();
    const cases: Array<[string, () => Promise<LightMyRequestResponse>, number, string]> = [
      ['not a ZIP', async () => importArchive(admin(), Buffer.from('not a zip archive'), fieldsFor('ARI-BAD')), 422, 'ARCHIVE_IMPORT_INVALID'],
      [
        'changed PDF (checksum)',
        async () =>
          importArchive(
            admin(),
            await tampered((entries) => {
              const pdf = Buffer.from(dataOf(entries, 'assets/asset-1.pdf'));
              pdf[pdf.length - 1] = pdf[pdf.length - 1]! ^ 0xff;
              return replace(entries, 'assets/asset-1.pdf', pdf);
            }),
            fieldsFor('ARI-BAD'),
          ),
        422,
        'ARCHIVE_IMPORT_INVALID',
      ],
      [
        'unsupported version',
        async () => importArchive(admin(), await tampered((entries) => editJson(entries, ARCHIVE_MANIFEST_PATH, (m) => (m.formatVersion = 2))), fieldsFor('ARI-BAD')),
        422,
        'ARCHIVE_IMPORT_INVALID',
      ],
      ['skipped activities not acknowledged', async () => importArchive(admin(), await exported(OFFICE, { unsupported: true }), fieldsFor('ARI-BAD')), 422, 'IMPORT_ACKNOWLEDGEMENT_REQUIRED'],
      ['unknown program', async () => importArchive(admin(), await exported(), { ...fieldsFor('ARI-BAD'), programId: '00000000-0000-4000-8000-000000000000' }), 422, 'PROGRAM_NOT_FOUND'],
      ['inactive program', async () => importArchive(admin(), await exported(), { ...fieldsFor('ARI-BAD'), programId: ids.inactiveProgram }), 422, 'PROGRAM_INACTIVE'],
      ['missing code', async () => importArchive(admin(), await exported(), { programId: ids.program, termId: ids.term }), 400, 'VALIDATION_ERROR'],
      ['no file', async () => importArchive(admin(), Buffer.alloc(0), fieldsFor('ARI-BAD'), { noFile: true }), 400, 'VALIDATION_ERROR'],
      ['not a .zip', async () => importArchive(admin(), await exported(), fieldsFor('ARI-BAD'), { fileName: 'course.json' }), 415, 'UNSUPPORTED_FILE_TYPE'],
      ['not multipart', async () => call(admin(), 'POST', '/course-imports/archive', fieldsFor('ARI-BAD')), 415, 'UNSUPPORTED_MEDIA_TYPE'],
      ['over 25 MiB', async () => importArchive(admin(), Buffer.alloc(ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes + 1), fieldsFor('ARI-BAD')), 413, 'PAYLOAD_TOO_LARGE'],
    ];
    for (const [label, send, status, code] of cases) {
      const res = await send();
      problem(res, status, code);
      if (code === 'ARCHIVE_IMPORT_INVALID') assert.match(res.json().detail, /\((ARCHIVE_INVALID|ASSET_INTEGRITY|VERSION_UNSUPPORTED)/, `${label}: the first issue code is named`);
    }
    await unchanged(before, 'refusals');
    assert.equal(await coursesWithCode('ARI-BAD'), 0);
    // The order of the form's parts does not matter: fields sent after the file are read too.
    ok(await importArchive(admin(), await exported(), fieldsFor('ARI-ORDER'), { fieldsAfterFile: true }), 201);
    // Acknowledged, the same archive imports (only the unsupported activity's title would have been kept).
    const acknowledged = ok(await importArchive(admin(), await exported(OFFICE, { unsupported: true }), fieldsFor('ARI-ACK', { acknowledgeSkipped: 'true' })), 201);
    assert.deepEqual([acknowledged.skipped.length, acknowledged.skipped[0].reason], [1, 'UNSUPPORTED_ACTIVITY_TYPE']);
  });

  it('a client-supplied preview or plan is ignored: only the uploaded archive is imported', async () => {
    const forged = JSON.stringify({ title: 'Forged', documents: [{ key: 'asset-9', storageKey: '../../etc/passwd' }] });
    const result = ok(await importArchive(admin(), await exported(), fieldsFor('ARI-FORGED'), { extraFields: { preview: forged, plan: forged } }), 201);
    assert.equal(result.course.title, 'Archive validation fixture');
    assert.equal(result.created.documents, 3);
  });

  it('over real HTTP, an archive over 25 MiB or cut off at the limit is refused and an abandoned upload leaves nothing behind', async () => {
    const server = await newApp();
    await server.listen({ port: 0, host: '127.0.0.1' });
    const { port } = server.server.address() as { port: number };
    try {
      const before = await snapshot();
      const who = admin();
      const s = sessions.get(who)!;
      const headers = { cookie: `${COOKIE}=${s.token}`, 'x-csrf-token': s.csrf, origin: ORIGIN };
      const limit = ARCHIVE_VALIDATION_LIMITS.maxArchiveBytes;
      const oversized = Buffer.alloc(limit + 4096);
      const send = (extra: Record<string, unknown>) =>
        rawUpload({ port, path: URL_PATH, headers, fileName: 'course.zip', contentType: 'application/zip', fields: fieldsFor('ARI-HTTP'), file: oversized, ...extra });
      for (const [label, result] of [
        ['sent at once', await send({})],
        ['paused at the limit', await send({ pause: { at: limit, ms: 300 } })],
      ] as const) {
        assert.ok(!('aborted' in result), label);
        assert.deepEqual([result.status, result.body.code], [413, 'PAYLOAD_TOO_LARGE'], `${label}: ${JSON.stringify(result.body).slice(0, 200)}`);
      }
      assert.deepEqual(await send({ abortAt: Math.floor(limit / 2) }), { aborted: true });
      await sleep(300);
      await unchanged(before, 'oversized and abandoned uploads');
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status, 200);
    } finally {
      await server.close();
    }
  });

  it('replay and concurrency: a repeated confirmation is refused; racing confirmations create one course; one import at a time per instance', async () => {
    // A repeated confirmation (same archive, same code) finds the code taken; nothing is stored for it.
    const archive = await exported();
    ok(await importArchive(admin(), archive, fieldsFor('ARI-ONCE')), 201);
    const before = await snapshot();
    problem(await importArchive(admin(), archive, fieldsFor('ARI-ONCE')), 409, 'COURSE_CODE_TAKEN');
    await unchanged(before, 'replay');
    assert.equal(await coursesWithCode('ARI-ONCE'), 1);

    // Two API instances confirm the same import at the same time: one course, and the loser's files are removed.
    const second = await newApp();
    try {
      const files = await storedFiles();
      const results = await Promise.all([importArchive(admin(), archive, fieldsFor('ARI-RACE')), importArchive(admin(), archive, fieldsFor('ARI-RACE'), { target: second })]);
      assert.deepEqual(results.map((res) => res.statusCode).sort(), [201, 409], results.map((res) => res.body).join(' | '));
      assert.equal(await coursesWithCode('ARI-RACE'), 1);
      assert.equal((await storedFiles()).length, files.length + 3, 'only the winning import keeps its files');
    } finally {
      await second.close();
    }

    // While one import validates in the shared package worker pool, a second one on the same instance is refused.
    const releases: Array<() => void> = [];
    const held = [0, 1].map(() => withPackageSlot(() => new Promise<void>((resolve) => releases.push(resolve))));
    let finished = false;
    // An empty course: validated in this thread instead, it would be imported well within the wait below.
    const first = importArchive(admin(), await exported([], { page: false }), fieldsFor('ARI-QUEUE')).then((res) => ((finished = true), res));
    try {
      await sleep(1_000);
      assert.equal(finished, false, 'validation waits for a worker of the shared pool (it never runs in the request thread)');
      const busy = await Promise.race([importArchive(admin(), archive, fieldsFor('ARI-QUEUE-2')), sleep(5_000).then(() => null)]);
      assert.ok(busy, 'a second import is refused at once, not queued');
      problem(busy, 503, 'ARCHIVE_IMPORT_BUSY');
      assert.equal(busy.headers['retry-after'], '60');
    } finally {
      releases.splice(0).forEach((release) => release());
      await Promise.all(held);
    }
    ok(await first, 201);
    assert.equal(await coursesWithCode('ARI-QUEUE-2'), 0);
  });

  it(`imports are rate limited per administrator (${ARCHIVE_IMPORT_RATE_LIMIT.max} per 10 minutes)`, async () => {
    const limited = await newApp();
    try {
      const send = (who: string) =>
        limited.inject({ method: 'POST', url: URL_PATH, payload: {}, cookies: { [COOKIE]: sessions.get(who)!.token }, headers: { 'x-csrf-token': sessions.get(who)!.csrf, origin: ORIGIN } });
      const statuses: number[] = [];
      for (let n = 0; n <= ARCHIVE_IMPORT_RATE_LIMIT.max; n += 1) statuses.push((await send('importer8')).statusCode);
      assert.deepEqual([statuses.slice(0, ARCHIVE_IMPORT_RATE_LIMIT.max).every((status) => status === 415), statuses[ARCHIVE_IMPORT_RATE_LIMIT.max]], [true, 429]);
      assert.equal((await send('importer7')).statusCode, 415, 'the limit is per administrator');
    } finally {
      await limited.close();
    }
  });

  it('storage failures and a failed transaction leave no course and no stored file; nothing internal is returned', async () => {
    const local = new LocalDocumentStorage(storageDir);
    const archive = await exported();
    const faulty = (faults: { failPutAt?: number; corruptReadAt?: number; failRemove?: boolean }): DocumentStorage => {
      let puts = 0;
      let reads = 0;
      return {
        put: async (bytes, key) => {
          puts += 1;
          if (puts === faults.failPutAt) throw new Error('simulated storage write failure at /srv/storage');
          return local.put(bytes, key);
        },
        read: async (key) => {
          reads += 1;
          const bytes = await local.read(key);
          if (reads === faults.corruptReadAt) bytes[0] = bytes[0]! ^ 0xff;
          return bytes;
        },
        remove: async (key) => {
          if (faults.failRemove) throw new Error('simulated removal failure');
          return local.remove(key);
        },
        exists: (key) => local.exists(key),
      };
    };
    for (const [label, faults, code, status] of [
      ['the third file cannot be written (two already were)', { failPutAt: 3 }, 'ARCHIVE_IMPORT_STORAGE_FAILED', 503],
      ['a stored file does not read back intact', { corruptReadAt: 2 }, 'ARCHIVE_IMPORT_STORAGE_FAILED', 503],
    ] as const) {
      const instance = await newApp({ storage: faulty(faults) });
      try {
        const before = await snapshot();
        problem(await importArchive(admin(), archive, fieldsFor('ARI-FAIL'), { target: instance }), status, code);
        await unchanged(before, label);
      } finally {
        await instance.close();
      }
    }
    // The transaction fails after every file was stored: rolled back, files removed, no detail returned.
    const failingDb = Object.create(database.db, { transaction: { value: async () => Promise.reject(new Error('simulated database failure')) } }) as typeof database.db;
    const rollback = await newApp({ db: failingDb });
    try {
      const before = await snapshot();
      problem(await importArchive(admin(), archive, fieldsFor('ARI-FAIL'), { target: rollback }), 500, 'ARCHIVE_IMPORT_FAILED');
      await unchanged(before, 'failed transaction');
    } finally {
      await rollback.close();
    }
    // When the files cannot be removed either, they stay unreferenced (never served) and journaled, so storage recovery
    // can remove them later (AP-040R); still no course becomes visible.
    const stuck = await newApp({ storage: faulty({ failPutAt: 3, failRemove: true }) });
    try {
      const rows = await fingerprint(['document_storage_intents']);
      const files = await storedFiles();
      problem(await importArchive(admin(), archive, fieldsFor('ARI-FAIL'), { target: stuck }), 503, 'ARCHIVE_IMPORT_STORAGE_FAILED');
      assert.equal(await fingerprint(['document_storage_intents']), rows, 'no other row was written');
      const orphans = (await storedFiles()).filter((file) => !files.includes(file));
      assert.equal(orphans.length, 2, 'the two files written before the failure remain, unreferenced');
      const referenced = await query<{ n: string }>('SELECT count(*) AS n FROM course_documents WHERE storage_key = ANY($1)', [orphans]);
      assert.equal(Number(referenced[0]!.n), 0, 'no record refers to them');
      const journal = await query<{ storage_key: string }>(`SELECT storage_key FROM document_storage_intents WHERE operation = 'archive_import'`);
      const journaledKeys = journal.map((row) => row.storage_key);
      assert.equal(journaledKeys.length, 3, 'all three reserved keys stay journaled: two stored files and the write that failed');
      for (const orphan of orphans) assert.ok(journaledKeys.includes(orphan), 'every file left behind is journaled for recovery');
      for (const orphan of orphans) await local.remove(orphan);
      await query('DELETE FROM document_storage_intents');
    } finally {
      await stuck.close();
    }
    assert.equal(await coursesWithCode('ARI-FAIL'), 0, 'no partially created course');
  });
});
