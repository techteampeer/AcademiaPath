/**
 * Document upload, extraction, mock summaries, review and student access against a temporary
 * PostgreSQL database and a temporary private storage directory. Skipped unless TEST_DATABASE_URL is
 * set. Users and documents are synthetic; passwords are random per run. Tests run in order.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { STATUS_CODES } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it, mock } from 'node:test';
import { and, asc, count, eq, inArray, like, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import { auditLog, courseDocuments, documentSummaries, userCredentials, users } from '../../src/db/schema/index.js';
import { noMalwareScanner, type MalwareScanner } from '../../src/documents/scanner.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { docxEntries, makeDocx, makePdf, makePptx, makeZip, multipartBody, type FormPart } from '../helpers/documents.js';

const PASSWORD = randomBytes(18).toString('base64url');
const COOKIE = 'ap_session';
const WEB_ORIGIN = 'http://localhost:3000';
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const EICAR_MARKER = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!';

const EMAILS = {
  admin: DEV_USERS[0]!.email,
  instructor: DEV_USERS[1]!.email,
  student: DEV_USERS[2]!.email,
  reviewer: DEV_USERS[3]!.email,
  assistant: 'assistant@academiapath.example',
  otherInstructor: 'instructor2@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Session = { token: string; csrfToken: string; userId: string };

const PDF_PAGES = [
  [
    'El sistema de valor del servicio describe cómo los componentes de la organización trabajan juntos para crear valor.',
    'Los principios guía orientan a la organización en todas las circunstancias y decisiones importantes.',
  ],
  [
    'La cadena de valor del servicio es un modelo operativo con seis actividades de la cadena de valor.',
    'La mejora continua tiene lugar en todas las áreas de la organización y en todos sus niveles.',
  ],
];
const DOCX_PARAGRAPHS = [
  'Incident management restores normal service operation as quickly as possible after an interruption.',
  'The service desk captures demand for incident resolution and service requests from all users.',
  'Problem management reduces the likelihood and impact of incidents by identifying their actual causes.',
];
const PPTX_SLIDES = [
  ['Change enablement', 'Change enablement maximizes the number of successful service and product changes.'],
  ['Change authority', 'Each change is assessed for risk and authorized by an appropriate change authority.'],
  ['Change schedule', 'The change schedule is used to plan changes and to communicate them to stakeholders.'],
];

const collapse = (value: string) => value.replace(/\s+/g, ' ');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function expectProblem(res: LightMyRequestResponse, status: number, code: string) {
  assert.equal(res.statusCode, status, res.body);
  assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
  const problem = res.json();
  assert.equal(problem.title, STATUS_CODES[status]);
  assert.equal(problem.code, code);
  return problem as { detail: string };
}

function expectStatus(res: LightMyRequestResponse, status: number) {
  assert.equal(res.statusCode, status, res.body);
  return res.json();
}

/** Test scanner: flags the EICAR test string, otherwise behaves like the default (no scanner connected). */
const testScanner: MalwareScanner = {
  async scan(bytes, file) {
    // Plain-text part of the EICAR test string (the PDF writer escapes its punctuation).
    return Buffer.from(bytes).includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? { status: 'infected', scanner: 'test' } : noMalwareScanner.scan(bytes, file);
  },
};

describe('course documents and mock summaries (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let storageDir: string;
  const sessions = new Map<Person, Session>();
  const ids: Record<string, string> = {};
  const originals: Record<string, Buffer> = {};
  const outbound: string[] = [];

  const session = (person: Person) => {
    const value = sessions.get(person);
    assert.ok(value, `${person} is not signed in`);
    return value;
  };

  const call = (who: Person | null, method: 'GET' | 'POST' | 'PUT', url: string, options: { payload?: object; csrf?: string | null } = {}) => {
    const current = who ? session(who) : null;
    const csrf = options.csrf === undefined ? current?.csrfToken : options.csrf;
    return app.inject({
      method,
      url: `/api/v1${url}`,
      ...(options.payload ? { payload: options.payload } : {}),
      cookies: current ? { [COOKIE]: current.token } : {},
      headers: method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {},
    });
  };

  const upload = (
    who: Person,
    courseId: string,
    sectionId: string,
    file: { filename: string; data: Buffer; contentType?: string },
    options: { title?: string; csrf?: string | null; origin?: string } = {},
  ) => {
    const current = session(who);
    const parts: FormPart[] = [...(options.title ? [{ name: 'title', value: options.title }] : []), { name: 'file', ...file }];
    const { payload, contentType } = multipartBody(parts);
    const csrf = options.csrf === undefined ? current.csrfToken : options.csrf;
    return app.inject({
      method: 'POST',
      url: `/api/v1/courses/${courseId}/sections/${sectionId}/documents`,
      payload,
      cookies: { [COOKIE]: current.token },
      headers: { 'content-type': contentType, ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(options.origin ? { origin: options.origin } : {}) },
    });
  };

  const docUrl = (courseId: string, activityId: string) => `/courses/${courseId}/activities/${activityId}/document`;
  const activityUrl = (courseId: string, activityId: string) => `/courses/${courseId}/activities/${activityId}`;
  const submit = async (who: Person, courseId: string, activityId: string) =>
    expectStatus(await call(who, 'POST', `${activityUrl(courseId, activityId)}/submit`), 200);
  const review = (who: Person, courseId: string, activityId: string, payload: object) =>
    call(who, 'POST', `${activityUrl(courseId, activityId)}/review`, { payload });
  const listTitles = async (who: Person, courseId: string, sectionId: string) =>
    expectStatus(await call(who, 'GET', `/courses/${courseId}/sections/${sectionId}/activities`), 200).items.map((a: { title: string }) => a.title);
  const documentCount = async () => (await database.db.select({ n: count() }).from(courseDocuments))[0]!.n;
  const storedFiles = async () => readdir(storageDir).catch(() => [] as string[]);

  const login = async (person: Person) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: EMAILS[person], password: PASSWORD },
      headers: { origin: WEB_ORIGIN },
    });
    const body = expectStatus(res, 200);
    const token = res.cookies.find((cookie) => cookie.name === COOKIE)?.value;
    assert.ok(token);
    sessions.set(person, { token, csrfToken: body.csrfToken, userId: body.user.id });
  };

  before(async () => {
    // Record any outbound HTTP(S) request made by this process (there must be none).
    mock.method(globalThis, 'fetch', async (input: unknown) => {
      outbound.push(String(input));
      throw new Error('Outbound requests are not allowed in tests');
    });
    for (const module of [http, https]) {
      mock.method(module, 'request', (...args: unknown[]) => {
        outbound.push(String(args[0]));
        throw new Error('Outbound requests are not allowed in tests');
      });
    }
    storageDir = join(await mkdtemp(join(tmpdir(), 'ap-documents-test-')), 'store');
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const passwordHash = await hashPassword(PASSWORD);
    for (const person of ['assistant', 'otherInstructor'] as const) {
      const [user] = await database.db.insert(users).values({ email: EMAILS[person], givenName: 'Test', familyName: person }).returning();
      assert.ok(user);
      await database.db.insert(userCredentials).values({ userId: user.id, passwordHash });
    }
    app = buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        APP_ORIGINS: WEB_ORIGIN,
        LOGIN_RATE_LIMIT_MAX: '1000',
        DOCUMENT_STORAGE_DIR: storageDir,
        DOCUMENT_MAX_UPLOAD_MB: '1',
      }),
      database: database.db,
      documents: { scanner: testScanner },
    });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) await login(person);

    const program = expectStatus(await call('admin', 'POST', '/programs', { payload: { code: 'ING-SIS', name: 'Ingeniería de Sistemas' } }), 201);
    const term = expectStatus(
      await call('admin', 'POST', '/terms', { payload: { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' } }),
      201,
    );
    const template = expectStatus(
      await call('admin', 'POST', '/course-templates', {
        payload: {
          code: 'ITIL-F',
          programId: program.id,
          title: 'ITIL Fundamentals',
          sections: [{ title: 'Introduction' }, { title: 'Instructor notes', isVisible: false }],
        },
      }),
      201,
    );
    const course = (code: string, status: string) =>
      call('admin', 'POST', '/courses', { payload: { programId: program.id, termId: term.id, templateId: template.templateId, code, status } });
    ids.courseA = expectStatus(await course('ITIL-A', 'published'), 201).id;
    ids.courseB = expectStatus(await course('ITIL-B', 'published'), 201).id;
    ids.courseC = expectStatus(await course('ITIL-C', 'draft'), 201).id;
    const enroll = async (courseId: string, person: Person, role: string) =>
      expectStatus(await call('admin', 'POST', `/courses/${courseId}/enrollments`, { payload: { email: EMAILS[person], role } }), 201);
    await enroll(ids.courseA!, 'instructor', 'instructor');
    await enroll(ids.courseA!, 'reviewer', 'design_team');
    await enroll(ids.courseA!, 'assistant', 'non_editing_instructor');
    await enroll(ids.courseA!, 'student', 'student');
    await enroll(ids.courseB!, 'otherInstructor', 'instructor');
    await enroll(ids.courseC!, 'instructor', 'instructor');
    await enroll(ids.courseC!, 'student', 'student');
    const sectionIds = async (courseId: string) =>
      expectStatus(await call('admin', 'GET', `/courses/${courseId}/sections`), 200).items.map((s: { id: string }) => s.id);
    [ids.introA, ids.hiddenA] = await sectionIds(ids.courseA!);
    [ids.introB] = await sectionIds(ids.courseB!);
    [ids.introC] = await sectionIds(ids.courseC!);
  });

  after(async () => {
    mock.restoreAll();
    await app?.close();
    await database?.drop();
    if (storageDir) await rm(join(storageDir, '..'), { recursive: true, force: true });
  });

  it('1/8/12. instructor uploads a PDF to an assigned course: text per page matches the source; draft with summary revision 1', async () => {
    originals.pdf = makePdf(PDF_PAGES, { compress: true });
    const detail = expectStatus(
      await upload('instructor', ids.courseA!, ids.introA!, { filename: 'Sistema de valor.pdf', data: originals.pdf, contentType: 'text/plain' }, { title: 'Sistema de valor del servicio' }),
      201,
    );
    ids.pdf = detail.activityId;
    assert.equal(detail.courseId, ids.courseA);
    assert.equal(detail.document.fileName, 'Sistema de valor.pdf');
    assert.equal(detail.document.format, 'pdf', 'format from the file content, not the browser media type');
    assert.equal(detail.document.byteSize, originals.pdf.length);
    assert.deepEqual(detail.document.extraction, { status: 'extracted', detail: null, characterCount: detail.document.extraction.characterCount, segmentCount: 2, truncated: false });
    assert.deepEqual(
      detail.document.segments,
      PDF_PAGES.map((lines, index) => ({ index, kind: 'page', label: `Page ${index + 1}`, text: lines.join('\n') })),
    );
    assert.deepEqual(detail.document.malwareScan, { status: 'not_scanned', scanner: 'none' });
    assert.equal(detail.summary.revision, 1);
    assert.equal(detail.summary.status, 'ready');
    assert.deepEqual(detail.summary.provider, { id: 'mock-extractive-v1', mode: 'mock', label: 'Mock AI summary — local demonstration' });
    assert.equal(detail.liveSummary, null);

    const activity = expectStatus(await call('instructor', 'GET', activityUrl(ids.courseA!, ids.pdf!)), 200);
    assert.equal(activity.type, 'file');
    assert.equal(activity.title, 'Sistema de valor del servicio');
    assert.deepEqual(activity.content, { documentId: detail.document.id, fileName: 'Sistema de valor.pdf', format: 'pdf', summaryRevision: 1 });
    assert.equal(activity.review.status, 'draft');
  });

  it('2/3/12. DOCX paragraphs and PPTX slides are extracted exactly, in order', async () => {
    originals.docx = makeDocx(DOCX_PARAGRAPHS);
    const docx = expectStatus(await upload('instructor', ids.courseA!, ids.introA!, { filename: 'incidents.docx', data: originals.docx }), 201);
    ids.docx = docx.activityId;
    assert.equal(docx.document.format, 'docx');
    assert.deepEqual(docx.document.segments.map((s: { text: string }) => s.text), DOCX_PARAGRAPHS);
    assert.deepEqual(docx.document.segments.map((s: { label: string }) => s.label), ['Paragraph 1', 'Paragraph 2', 'Paragraph 3']);
    assert.equal(expectStatus(await call('instructor', 'GET', activityUrl(ids.courseA!, ids.docx!)), 200).title, 'incidents', 'default title');

    originals.pptx = makePptx(PPTX_SLIDES, { reverseParts: true });
    const pptx = expectStatus(await upload('reviewer', ids.courseA!, ids.introA!, { filename: 'change.pptx', data: originals.pptx }), 201);
    ids.pptx = pptx.activityId;
    assert.equal(pptx.document.format, 'pptx');
    assert.deepEqual(
      pptx.document.segments.map((s: { label: string; text: string }) => [s.label, s.text]),
      PPTX_SLIDES.map((lines, index) => [`Slide ${index + 1}`, lines.join('\n')]),
    );
    assert.equal(outbound.length, 0, 'the external relationship in the PPTX was not fetched');
  });

  it('13. mock summaries quote only extracted text, with page/slide/paragraph evidence', async () => {
    for (const activityId of [ids.pdf!, ids.docx!, ids.pptx!]) {
      const detail = expectStatus(await call('instructor', 'GET', docUrl(ids.courseA!, activityId)), 200);
      assert.equal(detail.summary.status, 'ready');
      assert.ok(detail.summary.points.length >= 2);
      for (const point of detail.summary.points) {
        const segment = detail.document.segments[point.evidence.segmentIndex];
        assert.equal(point.evidence.label, segment.label);
        assert.ok(collapse(segment.text).includes(point.evidence.quote), point.evidence.quote);
        assert.ok(point.evidence.quote.startsWith(point.text.replace(/…$/, '')));
      }
    }
  });

  it('documents without selectable text are stored honestly as no_text with an insufficient-text summary', async () => {
    const detail = expectStatus(await upload('instructor', ids.courseA!, ids.introA!, { filename: 'scan.pdf', data: makePdf([[], []]) }), 201);
    assert.equal(detail.document.extraction.status, 'no_text');
    assert.match(detail.document.extraction.detail, /OCR is not available/);
    assert.deepEqual(detail.document.segments, []);
    assert.equal(detail.summary.status, 'insufficient_text');
    assert.deepEqual(detail.summary.points, []);
  });

  it('4. unsupported file types and non-multipart requests are rejected', async () => {
    const before = await documentCount();
    for (const filename of ['notes.txt', 'page.html', 'legacy.doc', 'macros.docm', 'deck.pptm', 'archive.zip', 'run.exe']) {
      expectProblem(await upload('instructor', ids.courseA!, ids.introA!, { filename, data: originals.pdf! }), 415, 'UNSUPPORTED_FILE_TYPE');
    }
    // A macro-enabled document renamed to .docx is refused from its content.
    const docm = makeDocx(DOCX_PARAGRAPHS, { mainType: 'application/vnd.ms-word.document.macroEnabled.main+xml' });
    expectProblem(await upload('instructor', ids.courseA!, ids.introA!, { filename: 'renamed.docx', data: docm }), 415, 'UNSUPPORTED_FILE_TYPE');
    expectProblem(
      await call('instructor', 'POST', `/courses/${ids.courseA}/sections/${ids.introA}/documents`, { payload: { file: 'x' } }),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
    const { payload, contentType } = multipartBody([{ name: 'attachment', filename: 'a.pdf', data: originals.pdf! }]);
    expectProblem(
      await app.inject({
        method: 'POST',
        url: `/api/v1/courses/${ids.courseA}/sections/${ids.introA}/documents`,
        payload,
        cookies: { [COOKIE]: session('instructor').token },
        headers: { 'content-type': contentType, 'x-csrf-token': session('instructor').csrfToken },
      }),
      400,
      'VALIDATION_ERROR',
    );
    assert.equal(await documentCount(), before);
  });

  it('5. files over the configured size limit are rejected (413) and not stored', async () => {
    const before = await storedFiles();
    const big = makePdf([['Large file']], { header: `%PDF-1.4\n%${'x'.repeat(1024 * 1024 + 10)}` });
    const problem = expectProblem(await upload('instructor', ids.courseA!, ids.introA!, { filename: 'big.pdf', data: big }), 413, 'PAYLOAD_TOO_LARGE');
    assert.match(problem.detail, /1 MB upload limit/);
    assert.deepEqual(await storedFiles(), before);
  });

  it('6. invalid signatures, encrypted and malformed files are rejected with clear errors', async () => {
    const before = await documentCount();
    const cases: Array<[string, Buffer, number, string]> = [
      ['fake.pdf', Buffer.from('<html><script>alert(1)</script></html>'), 422, 'FILE_SIGNATURE_MISMATCH'],
      ['slides.pptx', originals.docx!, 422, 'FILE_SIGNATURE_MISMATCH'],
      ['tool.docx', Buffer.from('MZ\x90\x00\x03 executable'), 422, 'FILE_SIGNATURE_MISMATCH'],
      ['notes.docx', originals.pdf!, 422, 'FILE_SIGNATURE_MISMATCH'],
      ['locked.pdf', makePdf(PDF_PAGES, { encryptMarker: true }), 422, 'DOCUMENT_ENCRYPTED'],
      ['locked.docx', Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(1024)]), 422, 'DOCUMENT_ENCRYPTED'],
      ['broken.pdf', Buffer.from('%PDF-1.7\nnot really a pdf'), 422, 'DOCUMENT_MALFORMED'],
      ['broken.docx', Buffer.from('PK\u0003\u0004 truncated'), 422, 'DOCUMENT_MALFORMED'],
    ];
    for (const [filename, data, status, code] of cases) {
      const problem = expectProblem(await upload('instructor', ids.courseA!, ids.introA!, { filename, data }), status, code);
      assert.ok(problem.detail.length > 10, 'clear explanation');
    }
    assert.equal(await documentCount(), before, 'rejected files are never stored');
  });

  it('7. path traversal is prevented: client file names never reach the file system', async () => {
    const detail = expectStatus(
      await upload('instructor', ids.courseA!, ids.introA!, { filename: '../../../../tmp/evil/../passwd.pdf', data: makePdf([['Traversal attempt document text.']]) }),
      201,
    );
    assert.equal(detail.document.fileName, 'passwd.pdf');
    const traversalZip = makeZip([...docxEntries(DOCX_PARAGRAPHS), { name: '../../outside.xml', data: '<x/>' }]);
    expectProblem(await upload('instructor', ids.courseA!, ids.introA!, { filename: 'zip-slip.docx', data: traversalZip }), 422, 'DOCUMENT_MALFORMED');
    const files = await storedFiles();
    assert.ok(files.length >= 5);
    for (const name of files) assert.match(name, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, name);
    const keys = await database.db.select({ key: courseDocuments.storageKey }).from(courseDocuments);
    assert.deepEqual(new Set(files), new Set(keys.map((row) => row.key)));
    // Storage keys are never part of API responses.
    assert.ok(!JSON.stringify(detail).includes(keys[0]!.key));
  });

  it('9. instructors cannot upload to or read documents of courses they are not assigned to', async () => {
    expectProblem(await upload('instructor', ids.courseB!, ids.introB!, { filename: 'x.pdf', data: originals.pdf! }), 404, 'NOT_FOUND');
    expectProblem(await upload('otherInstructor', ids.courseA!, ids.introA!, { filename: 'x.pdf', data: originals.pdf! }), 404, 'NOT_FOUND');
    // A section of another course, addressed through an assigned course, is not found.
    expectProblem(await upload('instructor', ids.courseA!, ids.introB!, { filename: 'x.pdf', data: originals.pdf! }), 404, 'NOT_FOUND');
    expectProblem(await call('otherInstructor', 'GET', docUrl(ids.courseA!, ids.pdf!)), 404, 'NOT_FOUND');
    // An activity id of course A addressed through course B is not found.
    expectProblem(await call('otherInstructor', 'GET', docUrl(ids.courseB!, ids.pdf!)), 404, 'NOT_FOUND');
  });

  it('10. students and non-editing instructors cannot upload or refresh', async () => {
    expectProblem(await upload('student', ids.courseA!, ids.introA!, { filename: 'x.pdf', data: originals.pdf! }), 403, 'FORBIDDEN');
    expectProblem(await upload('assistant', ids.courseA!, ids.introA!, { filename: 'x.pdf', data: originals.pdf! }), 403, 'FORBIDDEN');
    expectProblem(await call('assistant', 'POST', `${docUrl(ids.courseA!, ids.pdf!)}/summaries`), 403, 'FORBIDDEN');
    // Non-editing instructors can read the working copy.
    assert.equal(expectStatus(await call('assistant', 'GET', docUrl(ids.courseA!, ids.pdf!)), 200).summary.revision, 1);
  });

  it('11. draft documents are invisible to students (list, metadata, text and file)', async () => {
    assert.deepEqual(await listTitles('student', ids.courseA!, ids.introA!), []);
    expectProblem(await call('student', 'GET', activityUrl(ids.courseA!, ids.pdf!)), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', docUrl(ids.courseA!, ids.pdf!)), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', `${docUrl(ids.courseA!, ids.pdf!)}/file`), 404, 'NOT_FOUND');
  });

  it('21. CSRF and Origin protections apply to uploads and summary refreshes', async () => {
    const before = await documentCount();
    expectProblem(await upload('instructor', ids.courseA!, ids.introA!, { filename: 'x.pdf', data: originals.pdf! }, { csrf: null }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(await upload('instructor', ids.courseA!, ids.introA!, { filename: 'x.pdf', data: originals.pdf! }, { csrf: 'forged-token' }), 403, 'CSRF_TOKEN_INVALID');
    expectProblem(
      await upload('instructor', ids.courseA!, ids.introA!, { filename: 'x.pdf', data: originals.pdf! }, { origin: 'https://evil.example' }),
      403,
      'ORIGIN_NOT_ALLOWED',
    );
    expectProblem(await call('instructor', 'POST', `${docUrl(ids.courseA!, ids.pdf!)}/summaries`, { csrf: null }), 403, 'CSRF_TOKEN_INVALID');
    const anonymous = multipartBody([{ name: 'file', filename: 'x.pdf', data: originals.pdf! }]);
    expectProblem(
      await app.inject({ method: 'POST', url: `/api/v1/courses/${ids.courseA}/sections/${ids.introA}/documents`, payload: anonymous.payload, headers: { 'content-type': anonymous.contentType } }),
      401,
      'UNAUTHENTICATED',
    );
    assert.equal(await documentCount(), before);
  });

  it('malware scanning hook: a flagged file is rejected and not stored', async () => {
    const before = await storedFiles();
    const infected = makePdf([['Infected test document.', EICAR_MARKER]]);
    expectProblem(await upload('instructor', ids.courseA!, ids.introA!, { filename: 'eicar.pdf', data: infected }), 422, 'MALWARE_DETECTED');
    assert.deepEqual(await storedFiles(), before);
  });

  it('documents are only changed through document endpoints (generic edits are refused)', async () => {
    expectProblem(
      await call('instructor', 'PUT', activityUrl(ids.courseA!, ids.pdf!), { payload: { title: 'Renamed', body: 'Replacement text' } }),
      422,
      'CONTENT_TYPE_MISMATCH',
    );
  });

  it('17. instructors cannot approve; nobody approves their own submission', async () => {
    const submitted = await submit('instructor', ids.courseA!, ids.pdf!);
    assert.equal(submitted.review.status, 'submitted');
    expectProblem(await call('instructor', 'POST', `${docUrl(ids.courseA!, ids.pdf!)}/summaries`), 409, 'ACTIVITY_UNDER_REVIEW');
    expectProblem(await review('instructor', ids.courseA!, ids.pdf!, { decision: 'approve' }), 403, 'FORBIDDEN');
    await submit('reviewer', ids.courseA!, ids.pptx!);
    expectProblem(await review('reviewer', ids.courseA!, ids.pptx!, { decision: 'approve' }), 403, 'SELF_REVIEW_NOT_ALLOWED');
  });

  it('16. the design team approves or returns documents with comments', async () => {
    const approved = expectStatus(await review('reviewer', ids.courseA!, ids.pdf!, { decision: 'approve' }), 200);
    assert.equal(approved.review.status, 'approved');
    assert.deepEqual(approved.liveVersion.content, approved.content);
    await submit('instructor', ids.courseA!, ids.docx!);
    const returned = expectStatus(
      await review('reviewer', ids.courseA!, ids.docx!, { decision: 'return', comment: 'Add the problem management section.' }),
      200,
    );
    assert.equal(returned.review.status, 'returned');
    assert.equal(returned.review.comment, 'Add the problem management section.');
    expectProblem(await review('reviewer', ids.courseA!, ids.docx!, { decision: 'approve' }), 409, 'INVALID_REVIEW_STATE');
  });

  it('18. enrolled students read approved documents and download the original; no review data', async () => {
    assert.deepEqual(await listTitles('student', ids.courseA!, ids.introA!), ['Sistema de valor del servicio']);
    const detail = expectStatus(await call('student', 'GET', docUrl(ids.courseA!, ids.pdf!)), 200);
    ids.studentSummary = JSON.stringify(detail.summary);
    assert.deepEqual(Object.keys(detail).sort(), ['activityId', 'courseId', 'document', 'liveSummary', 'summary']);
    assert.equal(detail.summary.revision, 1);
    assert.equal(detail.liveSummary, null);
    assert.equal(detail.document.segments.length, 2);
    const activity = expectStatus(await call('student', 'GET', activityUrl(ids.courseA!, ids.pdf!)), 200);
    assert.equal(activity.review, null);
    assert.equal(activity.liveVersion, null);

    const file = await call('student', 'GET', `${docUrl(ids.courseA!, ids.pdf!)}/file`);
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers['content-type'], 'application/pdf');
    assert.equal(file.headers['content-disposition'], `attachment; filename="Sistema de valor.pdf"; filename*=UTF-8''Sistema%20de%20valor.pdf`);
    assert.equal(file.headers['x-content-type-options'], 'nosniff');
    assert.match(String(file.headers['content-security-policy']), /sandbox/);
    assert.equal(file.headers['cache-control'], 'no-store');
    assert.equal(sha256(file.rawPayload), sha256(originals.pdf!));
    // Returned and other unapproved documents stay hidden.
    expectProblem(await call('student', 'GET', docUrl(ids.courseA!, ids.docx!)), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', docUrl(ids.courseA!, ids.pptx!)), 404, 'NOT_FOUND');
  });

  it('14/15. refresh creates a new revision; students keep the approved revision until it is approved again', async () => {
    const refreshed = expectStatus(await call('instructor', 'POST', `${docUrl(ids.courseA!, ids.pdf!)}/summaries`), 201);
    assert.equal(refreshed.summary.revision, 2);
    assert.equal(refreshed.summary.strategy, 'section_coverage');
    assert.equal(refreshed.liveSummary.revision, 1);
    const activity = expectStatus(await call('instructor', 'GET', activityUrl(ids.courseA!, ids.pdf!)), 200);
    assert.equal(activity.review.status, 'draft');
    assert.equal(activity.content.summaryRevision, 2);
    assert.equal(activity.liveVersion.content.summaryRevision, 1);

    const studentView = expectStatus(await call('student', 'GET', docUrl(ids.courseA!, ids.pdf!)), 200);
    assert.equal(JSON.stringify(studentView.summary), ids.studentSummary, 'approved summary unchanged');
    assert.equal(expectStatus(await call('student', 'GET', activityUrl(ids.courseA!, ids.pdf!)), 200).content.summaryRevision, 1);

    const third = expectStatus(await call('reviewer', 'POST', `${docUrl(ids.courseA!, ids.pdf!)}/summaries`), 201);
    assert.equal(third.summary.revision, 3);
    const rows = await database.db
      .select({ revision: documentSummaries.revision, points: documentSummaries.points })
      .from(documentSummaries)
      .innerJoin(courseDocuments, eq(courseDocuments.id, documentSummaries.documentId))
      .where(eq(courseDocuments.activityId, ids.pdf!))
      .orderBy(asc(documentSummaries.revision));
    assert.deepEqual(rows.map((row) => row.revision), [1, 2, 3]);
    assert.deepEqual(rows[0]!.points, JSON.parse(ids.studentSummary!).points, 'revision 1 never modified');

    await submit('instructor', ids.courseA!, ids.pdf!);
    assert.equal(expectStatus(await call('student', 'GET', docUrl(ids.courseA!, ids.pdf!)), 200).summary.revision, 1);
    expectStatus(await review('reviewer', ids.courseA!, ids.pdf!, { decision: 'approve' }), 200);
    const after = expectStatus(await call('student', 'GET', docUrl(ids.courseA!, ids.pdf!)), 200);
    assert.equal(after.summary.revision, 3);
  });

  it('19. documents in hidden sections are inaccessible to students even when approved', async () => {
    const hidden = expectStatus(await upload('instructor', ids.courseA!, ids.hiddenA!, { filename: 'notes.pdf', data: makePdf(PDF_PAGES) }), 201);
    await submit('instructor', ids.courseA!, hidden.activityId);
    expectStatus(await review('reviewer', ids.courseA!, hidden.activityId, { decision: 'approve' }), 200);
    expectProblem(await call('student', 'GET', `/courses/${ids.courseA}/sections/${ids.hiddenA}/activities`), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', docUrl(ids.courseA!, hidden.activityId)), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', `${docUrl(ids.courseA!, hidden.activityId)}/file`), 404, 'NOT_FOUND');
    assert.equal(expectStatus(await call('reviewer', 'GET', docUrl(ids.courseA!, hidden.activityId)), 200).summary.revision, 1);
  });

  it('20. documents of draft courses are inaccessible to students even when approved', async () => {
    const draft = expectStatus(await upload('instructor', ids.courseC!, ids.introC!, { filename: 'draft-course.pdf', data: makePdf(PDF_PAGES) }), 201);
    await submit('instructor', ids.courseC!, draft.activityId);
    expectStatus(await review('admin', ids.courseC!, draft.activityId, { decision: 'approve' }), 200);
    expectProblem(await call('student', 'GET', docUrl(ids.courseC!, draft.activityId)), 404, 'NOT_FOUND');
    expectProblem(await call('student', 'GET', `${docUrl(ids.courseC!, draft.activityId)}/file`), 404, 'NOT_FOUND');
  });

  it('22. uploads, rejections, summaries and review decisions are audited (without the extracted text)', async () => {
    const rows = await database.db
      .select({ action: auditLog.action, metadata: auditLog.metadata, actor: auditLog.actorUserId })
      .from(auditLog)
      .where(inArray(auditLog.action, ['document.uploaded', 'document.upload_rejected', 'document.summary_generated', 'activity.submitted', 'activity.approved', 'activity.returned']));
    const actions = rows.map((row) => row.action);
    for (const action of ['document.uploaded', 'document.upload_rejected', 'document.summary_generated', 'activity.submitted', 'activity.approved', 'activity.returned']) {
      assert.ok(actions.includes(action), action);
    }
    const uploaded = rows.find((row) => row.action === 'document.uploaded' && JSON.stringify(row.metadata).includes('Sistema de valor.pdf'));
    assert.ok(uploaded);
    assert.equal(uploaded.actor, session('instructor').userId);
    assert.equal((uploaded.metadata as { after: { sha256: string } }).after.sha256, sha256(originals.pdf!));
    const codes = rows.filter((row) => row.action === 'document.upload_rejected').map((row) => (row.metadata as { after: { code: string } }).after.code);
    for (const code of ['UNSUPPORTED_FILE_TYPE', 'PAYLOAD_TOO_LARGE', 'FILE_SIGNATURE_MISMATCH', 'DOCUMENT_ENCRYPTED', 'DOCUMENT_MALFORMED', 'MALWARE_DETECTED']) {
      assert.ok(codes.includes(code), code);
    }
    const revisions = rows
      .filter((row) => row.action === 'document.summary_generated')
      .map((row) => (row.metadata as { after: { revision: number } }).after.revision);
    assert.ok(revisions.includes(2) && revisions.includes(3));
    const all = JSON.stringify(rows.map((row) => row.metadata));
    assert.ok(!all.includes(PDF_PAGES[0]![0]!), 'extracted text is not copied into the audit log');
    const documentEvents = (await database.db.select({ n: count() }).from(auditLog).where(like(auditLog.action, 'document.%')))[0]!.n;
    assert.ok(documentEvents >= 10);
  });

  it('23. original files are never exposed through public URLs or stored inside the repository', async () => {
    const [stored] = await database.db.select({ key: courseDocuments.storageKey }).from(courseDocuments).limit(1);
    assert.ok(stored);
    for (const path of [`/${stored.key}`, `/uploads/${stored.key}`, `/documents/${stored.key}`, `/api/v1/documents/${stored.key}`, `/api/v1/files/${stored.key}`]) {
      const res = await app.inject({ method: 'GET', url: path, cookies: { [COOKIE]: session('admin').token } });
      assert.equal(res.statusCode, 404, path);
    }
    assert.ok(relative(REPOSITORY_ROOT, storageDir).startsWith('..'), 'storage is outside the repository');
    const anonymous = await app.inject({ method: 'GET', url: `/api/v1${docUrl(ids.courseA!, ids.pdf!)}/file` });
    assert.equal(anonymous.statusCode, 401);
  });

  it('stored documents and summary revisions are immutable in the database', async () => {
    // Drizzle wraps the PostgreSQL error raised by the trigger; its cause carries the message.
    const immutable = (error: unknown) => /rows are immutable/.test(String((error as { cause?: Error }).cause?.message));
    await assert.rejects(database.db.update(courseDocuments).set({ fileName: 'changed.pdf' }).where(eq(courseDocuments.activityId, ids.pdf!)), immutable);
    await assert.rejects(database.db.update(documentSummaries).set({ revision: 99 }).where(eq(documentSummaries.revision, 1)), immutable);
    const [row] = await database.db
      .select({ name: courseDocuments.fileName })
      .from(courseDocuments)
      .where(and(eq(courseDocuments.activityId, ids.pdf!), sql`true`));
    assert.equal(row?.name, 'Sistema de valor.pdf');
  });

  it('24. no outbound network requests were made', () => {
    assert.deepEqual(outbound, []);
  });
});
