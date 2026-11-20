/**
 * AP-038C2B archive import engine against a temporary PostgreSQL database (skipped unless TEST_DATABASE_URL is set) and
 * a temporary local document storage wrapped so tests can make writes, deletes or the database fail. A source course
 * with every supported activity type, a folder, a prerequisite, PDF/DOCX/PPTX documents and student work is exported
 * through the real archive API, then restored with importCourseArchive(). Every failure case checks that no course,
 * no document record and no stored file is left behind. All accounts and content are synthetic.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Database } from '../../src/db/client.js';
import {
  activities,
  activityCompletions,
  assignmentSubmissions,
  auditLog,
  courseDocuments,
  courses,
  documentSummaries,
  enrollments,
  grades,
  quizAttempts,
  quizQuestions,
  resourceFolders,
  sectionPrerequisites,
  sections,
} from '../../src/db/schema/index.js';
import { extractInWorker } from '../../src/documents/extraction.js';
import { noMalwareScanner, type MalwareScanner } from '../../src/documents/scanner.js';
import { LocalDocumentStorage } from '../../src/documents/storage.js';
import { mockSummaryProvider } from '../../src/documents/summary.js';
import { ArchiveImportError, importCourseArchive, type ArchiveImportDeps, type ArchiveImportProblem } from '../../src/portability/archive-import.js';
import { packageContentHash, type CoursePackage } from '../../src/portability/course-package.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { makeDocx, makePdf, makePptx, multipartBody } from '../helpers/documents.js';
import { buildZip, type ZipSpec } from '../helpers/scorm.js';
import { zipEntries } from '../helpers/zip.js';

const PASSWORD = randomBytes(18).toString('base64url');
const COOKIE = 'ap_session';
const ORIGIN = 'http://localhost:3000';
const DUE = '2027-01-15T23:59:00.000Z';
const EMAILS = { admin: 'admin@academiapath.example', instructor: 'instructor@academiapath.example', reviewer: 'reviewer@academiapath.example', student: 'student@academiapath.example' } as const;
type Person = keyof typeof EMAILS;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const DOCS = {
  pdf: { name: 'handout.pdf', type: 'application/pdf', data: makePdf([['Import handout', 'Value streams combine activities to create value for customers.']]) },
  docx: { name: 'notes.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: makeDocx(['Synthetic notes about service management and value.']) },
  pptx: { name: 'slides.pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', data: makePptx([['Synthetic slide about continual improvement']]) },
};

describe('course archive import engine (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let storageDir: string;
  const sessions = new Map<Person, { token: string; csrf: string; userId: string }>();
  const ids = {} as Record<'program' | 'term' | 'source' | 'empty' | 'unit1' | 'unit2' | 'folder' | 'welcome' | 'link' | 'quiz' | 'assignment' | 'pdf' | 'docx' | 'pptx', string>;
  let sourceArchive: Buffer;
  let emptyArchive: Buffer;
  /** Fault injection for the import's storage. */
  const faults = { puts: 0, failPutAt: 0, failRemove: false };
  let deps: ArchiveImportDeps;

  const call = (who: Person | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
    const current = who ? sessions.get(who)! : null;
    return app.inject({ method, url: `/api/v1${url}`, ...(payload ? { payload } : {}), cookies: current ? { [COOKIE]: current.token } : {}, headers: method !== 'GET' && current ? { 'x-csrf-token': current.csrf, origin: ORIGIN } : {} });
  };
  const ok = (res: LightMyRequestResponse, status = 200) => {
    assert.equal(res.statusCode, status, res.body);
    return res.json();
  };
  const create = async (sectionId: string, body: object) => ok(await call('instructor', 'POST', `/courses/${ids.source}/sections/${sectionId}/activities`, body), 201).id as string;
  const approve = async (activityId: string) => {
    ok(await call('instructor', 'POST', `/courses/${ids.source}/activities/${activityId}/submit`));
    ok(await call('reviewer', 'POST', `/courses/${ids.source}/activities/${activityId}/review`, { decision: 'approve' }));
  };
  const upload = async (sectionId: string, doc: (typeof DOCS)[keyof typeof DOCS], title: string) => {
    const current = sessions.get('instructor')!;
    const { payload, contentType } = multipartBody([{ name: 'title', value: title }, { name: 'file', filename: doc.name, data: doc.data, contentType: doc.type }]);
    const res = await app.inject({ method: 'POST', url: `/api/v1/courses/${ids.source}/sections/${sectionId}/documents`, payload, cookies: { [COOKIE]: current.token }, headers: { 'content-type': contentType, 'x-csrf-token': current.csrf, origin: ORIGIN } });
    return ok(res, 201).activityId as string;
  };
  const archiveOf = async (courseId: string) => {
    const res = await call('admin', 'GET', `/courses/${courseId}/export/archive`);
    assert.equal(res.statusCode, 200, res.body);
    return res.rawPayload;
  };
  const storedFiles = async () => new Set(await readdir(storageDir));
  const courseByCode = async (code: string) => (await database.db.select().from(courses).where(eq(courses.code, code)))[0] ?? null;
  const importAs = (code: string, archive = sourceArchive, overrides: Partial<Parameters<typeof importCourseArchive>[1]> = {}, using: ArchiveImportDeps = deps) =>
    importCourseArchive(using, { archive, actor: { userId: sessions.get('admin')!.userId, ip: '127.0.0.1' }, programId: ids.program, termId: ids.term, code, assignmentDueAt: DUE, ...overrides });
  /** An import that must fail with `problem` and leave no course, document record or stored file behind. */
  const refused = async (code: string, problem: ArchiveImportProblem, run: () => Promise<unknown>) => {
    const filesBefore = await storedFiles();
    const coursesWithCode = async () => (await database.db.select({ id: courses.id }).from(courses).where(eq(courses.code, code))).length;
    const coursesBefore = await coursesWithCode();
    const documentsBefore = (await database.db.select({ id: courseDocuments.id }).from(courseDocuments)).length;
    let caught: ArchiveImportError | null = null;
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof ArchiveImportError, String(error));
      caught = error;
      return true;
    });
    assert.equal(caught!.problem, problem, caught!.message);
    assert.equal(await coursesWithCode(), coursesBefore, 'no course was created');
    assert.equal((await database.db.select({ id: courseDocuments.id }).from(courseDocuments)).length, documentsBefore, 'no document record');
    assert.deepEqual(await storedFiles(), filesBefore, 'no stored file left behind');
    return caught!;
  };
  /** The source archive's entries, changed by `edit`, written again with the raw test ZIP builder. */
  const tampered = async (edit: (entries: ZipSpec[]) => ZipSpec[]) => buildZip(edit((await zipEntries(sourceArchive)).map((e): ZipSpec => ({ name: e.name, data: e.data, method: 'deflate' }))));

  before(async () => {
    storageDir = join(await mkdtemp(join(tmpdir(), 'ap-archive-import-')), 'store');
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const local = new LocalDocumentStorage(storageDir);
    const storage = {
      put: async (bytes: Uint8Array, key?: string) => {
        faults.puts += 1;
        if (faults.failPutAt && faults.puts === faults.failPutAt) throw Object.assign(new Error(`ENOSPC: no space left on device, write ${storageDir}`), { code: 'ENOSPC' });
        return local.put(bytes, key);
      },
      read: (key: string) => local.read(key),
      remove: async (key: string) => {
        if (faults.failRemove) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        return local.remove(key);
      },
      exists: (key: string) => local.exists(key),
    };
    app = buildApp({ config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir, DOCUMENT_MAX_UPLOAD_MB: '5' }), database: database.db, documents: { storage } });
    await app.ready();
    deps = { db: database.db, storage, scanner: noMalwareScanner, provider: mockSummaryProvider, extract: (bytes, format) => extractInWorker(bytes, format, 20_000) };
    for (const person of Object.keys(EMAILS) as Person[]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAILS[person], password: PASSWORD }, headers: { origin: ORIGIN } });
      const body = ok(res);
      sessions.set(person, { token: res.cookies.find((c) => c.name === COOKIE)!.value, csrf: body.csrfToken, userId: body.user.id });
    }
    ids.program = ok(await call('admin', 'POST', '/programs', { code: 'ING-SIS', name: 'Ingeniería de Sistemas' }), 201).id;
    ids.term = ok(await call('admin', 'POST', '/terms', { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' }), 201).id;
    const template = ok(await call('admin', 'POST', '/course-templates', { code: 'SRC-T', programId: ids.program, title: 'Source template', sections: [{ title: 'Unit A · Foundations' }, { title: 'Unit B · Practice' }] }), 201).templateId;
    ids.source = ok(await call('admin', 'POST', '/courses', { programId: ids.program, termId: ids.term, templateId: template, code: 'SRC-1', status: 'published' }), 201).id;
    for (const [person, role] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['student', 'student']] as const) ok(await call('admin', 'POST', `/courses/${ids.source}/enrollments`, { email: EMAILS[person], role }), 201);
    [ids.unit1, ids.unit2] = ok(await call('admin', 'GET', `/courses/${ids.source}/sections`)).items.map((s: { id: string }) => s.id);
    ids.folder = ok(await call('instructor', 'POST', `/courses/${ids.source}/sections/${ids.unit1}/resource-folders`, { title: 'Readings' }), 201).id;
    ids.welcome = await create(ids.unit1, { type: 'page', title: 'Welcome', body: 'Welcome to the course.' });
    await approve(ids.welcome);
    ids.link = await create(ids.unit1, { type: 'link', title: 'Overview video', url: 'https://www.example.org/overview', description: 'Short overview.', kind: 'video', folderId: ids.folder });
    await approve(ids.link);
    ids.pdf = await upload(ids.unit1, DOCS.pdf, 'Import handout');
    await approve(ids.pdf);
    ok(await call('instructor', 'PUT', `/courses/${ids.source}/activities/${ids.pdf}/organization`, { folderId: ids.folder }));
    ids.quiz = await create(ids.unit2, { type: 'quiz', title: 'Checkpoint', instructions: 'Answer all questions.', attemptLimit: 2 });
    ok(await call('instructor', 'POST', `/courses/${ids.source}/activities/${ids.quiz}/questions`, { type: 'single_choice', prompt: 'Which practice restores service?', points: 2, options: [{ text: 'Incident management', isCorrect: true }, { text: 'Change enablement', isCorrect: false }] }), 201);
    ok(await call('instructor', 'POST', `/courses/${ids.source}/activities/${ids.quiz}/questions`, { type: 'true_false', prompt: 'Value is co-created.', points: 1, correctAnswer: true }), 201);
    await approve(ids.quiz);
    ids.assignment = await create(ids.unit2, { type: 'assignment', title: 'Service map', instructions: 'Map one service.', dueAt: '2026-12-04T23:59:00.000Z', lateUntil: null, rubric: [{ title: 'Accuracy', maxPoints: 10 }] });
    await approve(ids.assignment);
    ids.docx = await upload(ids.unit2, DOCS.docx, 'Import notes');
    ids.pptx = await upload(ids.unit2, DOCS.pptx, 'Import slides');
    await approve(ids.pptx);
    // Student work in the source course: never part of an archive or an import.
    ok(await call('student', 'PUT', `/courses/${ids.source}/activities/${ids.welcome}/completion`));
    const attempt = ok(await call('student', 'POST', `/courses/${ids.source}/activities/${ids.quiz}/attempts`), 201);
    ok(await call('student', 'POST', `/courses/${ids.source}/attempts/${attempt.id}/submit`, {}));
    ok(await call('student', 'POST', `/courses/${ids.source}/activities/${ids.assignment}/submissions`, { body: 'Student work that must not be imported.' }), 201);
    // The prerequisite last, so the student's work above is not locked by it.
    ok(await call('admin', 'PUT', `/courses/${ids.source}/sections/${ids.unit2}/prerequisites`, { requiredSectionIds: [ids.unit1] }));
    sourceArchive = await archiveOf(ids.source);
    const emptyTemplate = ok(await call('admin', 'POST', '/course-templates', { code: 'EMPTY-T', programId: ids.program, title: 'Empty template', sections: [{ title: 'Only unit' }] }), 201).templateId;
    ids.empty = ok(await call('admin', 'POST', '/courses', { programId: ids.program, termId: ids.term, templateId: emptyTemplate, code: 'EMPTY-1', status: 'draft' }), 201).id;
    emptyArchive = await archiveOf(ids.empty);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (storageDir) await rm(join(storageDir, '..'), { recursive: true, force: true });
  });

  beforeEach(() => Object.assign(faults, { puts: 0, failPutAt: 0, failRemove: false }));

  /** The source course's rows, to prove an import never changes it. */
  const sourceSnapshot = async () => {
    const units = await database.db.select().from(sections).where(eq(sections.courseId, ids.source));
    const rows = await database.db.select().from(activities).where(inArray(activities.sectionId, units.map((u) => u.id)));
    const docs = await database.db.select().from(courseDocuments).where(inArray(courseDocuments.activityId, rows.map((r) => r.id)));
    return JSON.stringify({ units, rows, docs });
  };

  it('imports an empty course as a new draft', async () => {
    const result = await importAs('EMPTY-COPY', emptyArchive);
    assert.deepEqual(result.created, { units: 1, folders: 0, prerequisites: 0, activities: 0, questions: 0, documents: 0 });
    const course = (await courseByCode('EMPTY-COPY'))!;
    assert.deepEqual([course.status, course.templateId], ['draft', null]);
    assert.notEqual(course.id, ids.empty);
  });

  it('restores the course with its PDF, DOCX and PPTX as a new draft: structure, documents, integrity; no student data; source unchanged', async () => {
    const sourceBefore = await sourceSnapshot();
    const result = await importAs('SRC-COPY');
    assert.deepEqual(result.created, { units: 2, folders: 1, prerequisites: 1, activities: 7, questions: 2, documents: 3 });
    assert.deepEqual(result.skipped, []);
    const course = (await courseByCode('SRC-COPY'))!;
    assert.equal(course.status, 'draft');
    assert.notEqual(course.id, ids.source);

    // Structure: same units, order, folders, prerequisites and activities, with fresh identifiers.
    const units = await database.db.select().from(sections).where(eq(sections.courseId, course.id)).orderBy(sections.position);
    assert.deepEqual(units.map((u) => u.title), ['Unit A · Foundations', 'Unit B · Practice']);
    const [prerequisite] = await database.db.select().from(sectionPrerequisites).where(eq(sectionPrerequisites.courseId, course.id));
    assert.deepEqual([prerequisite!.sectionId, prerequisite!.requiredSectionId], [units[1]!.id, units[0]!.id]);
    const [folder] = await database.db.select().from(resourceFolders).where(eq(resourceFolders.courseId, course.id));
    assert.notEqual(folder!.id, ids.folder);
    const rows = await database.db.select().from(activities).where(inArray(activities.sectionId, units.map((u) => u.id))).orderBy(activities.sectionId, activities.position);
    const shape = (unitId: string) => rows.filter((r) => r.sectionId === unitId).sort((a, b) => a.position - b.position).map((r) => [r.type, r.title, r.folderId === folder!.id]);
    assert.deepEqual(shape(units[0]!.id), [['page', 'Welcome', false], ['link', 'Overview video', true], ['file', 'Import handout', true]]);
    assert.deepEqual(shape(units[1]!.id), [['quiz', 'Checkpoint', false], ['assignment', 'Service map', false], ['file', 'Import notes', false], ['file', 'Import slides', false]]);
    assert.ok(rows.every((r) => r.reviewStatus === 'draft' && r.approvedConfig === null), 'everything is a draft for review, never approved');
    assert.ok(rows.every((r) => ![ids.welcome, ids.link, ids.pdf, ids.quiz, ids.assignment, ids.docx, ids.pptx].includes(r.id)), 'fresh activity ids');
    assert.equal((await database.db.select().from(quizQuestions).where(eq(quizQuestions.activityId, rows.find((r) => r.type === 'quiz')!.id))).length, 2);
    assert.equal((rows.find((r) => r.type === 'assignment')!.config as { dueAt: string }).dueAt, DUE);

    // Documents: new records and files, byte-identical to the source, linked to their new activities.
    const sourceDocs = await database.db.select().from(courseDocuments).where(inArray(courseDocuments.activityId, [ids.pdf, ids.docx, ids.pptx]));
    for (const [title, doc] of [['Import handout', DOCS.pdf], ['Import notes', DOCS.docx], ['Import slides', DOCS.pptx]] as const) {
      const activity = rows.find((r) => r.title === title)!;
      const [row] = await database.db.select().from(courseDocuments).where(eq(courseDocuments.activityId, activity.id));
      assert.ok(row, title);
      const original = sourceDocs.find((d) => d.sha256 === row.sha256)!;
      assert.ok(original, `${title}: same SHA-256 as the source`);
      assert.notEqual(row.id, original.id);
      assert.notEqual(row.storageKey, original.storageKey);
      const stored = await readFile(join(storageDir, row.storageKey));
      assert.ok(stored.equals(doc.data), `${title}: the stored file is the original`);
      assert.deepEqual([row.byteSize, row.sha256, row.fileName, row.format], [doc.data.length, sha(doc.data), doc.name, original.format]);
      assert.equal((activity.config as { documentId: string }).documentId, row.id, 'the activity points at its own new document');
      assert.equal(row.malwareScanStatus, 'not_scanned', 'never marked clean without a scanner');
      assert.equal(row.extractionStatus, original.extractionStatus);
      assert.equal((await database.db.select().from(documentSummaries).where(eq(documentSummaries.documentId, row.id))).length, 1);
    }

    // No people or student work: only content was created.
    const newActivityIds = rows.map((r) => r.id);
    assert.equal((await database.db.select().from(enrollments).where(eq(enrollments.courseId, course.id))).length, 0);
    assert.equal((await database.db.select().from(quizAttempts).where(inArray(quizAttempts.activityId, newActivityIds))).length, 0);
    assert.equal((await database.db.select().from(assignmentSubmissions).where(inArray(assignmentSubmissions.activityId, newActivityIds))).length, 0);
    assert.equal((await database.db.select().from(grades).where(inArray(grades.activityId, newActivityIds))).length, 0);
    assert.equal((await database.db.select().from(activityCompletions).where(inArray(activityCompletions.activityId, newActivityIds))).length, 0);
    assert.equal(await sourceSnapshot(), sourceBefore, 'the source course is unchanged');

    // Audited with metadata only: no storage keys.
    const [audit] = await database.db.select().from(auditLog).where(and(eq(auditLog.action, 'course.imported'), eq(auditLog.entityId, course.id)));
    const text = JSON.stringify(audit!.metadata);
    assert.ok(text.includes('"source":"archive"'));
    const keys = (await database.db.select({ key: courseDocuments.storageKey }).from(courseDocuments)).map((r) => r.key);
    for (const key of keys) assert.ok(!text.includes(key), 'no storage key in the audit record');
  });

  it('importing the same archive again creates an independent draft with its own documents and files', async () => {
    const first = (await courseByCode('SRC-COPY'))!;
    const firstDocs = await database.db.select().from(courseDocuments).innerJoin(activities, eq(activities.id, courseDocuments.activityId)).innerJoin(sections, eq(sections.id, activities.sectionId)).where(eq(sections.courseId, first.id));
    const result = await importAs('SRC-COPY-2');
    assert.notEqual(result.course.id, first.id);
    const secondDocs = await database.db.select().from(courseDocuments).innerJoin(activities, eq(activities.id, courseDocuments.activityId)).innerJoin(sections, eq(sections.id, activities.sectionId)).where(eq(sections.courseId, result.course.id));
    assert.equal(secondDocs.length, 3);
    const firstKeys = new Set(firstDocs.map((r) => r.course_documents.storageKey));
    assert.ok(secondDocs.every((r) => !firstKeys.has(r.course_documents.storageKey)), 'separate stored files');
    const files = await storedFiles();
    assert.ok([...firstKeys, ...secondDocs.map((r) => r.course_documents.storageKey)].every((key) => files.has(key)));
  });

  it('refuses an invalid archive before writing anything: corrupted or missing file, unsupported or foreign archive, broken relationships', async () => {
    const corrupted = await tampered((entries) =>
      entries.map((e) => {
        if (e.name !== 'assets/asset-1.pdf') return e;
        const data = Buffer.from(e.data as Buffer);
        data[data.length - 2] = data[data.length - 2]! ^ 0x01;
        return { ...e, data };
      }),
    );
    const report = (await refused('BAD-1', 'ARCHIVE_INVALID', () => importAs('BAD-1', corrupted))).detail.report!;
    assert.ok(report.issues.some((issue) => issue.code === 'ASSET_INTEGRITY'));
    await refused('BAD-2', 'ARCHIVE_INVALID', async () => importAs('BAD-2', await tampered((entries) => entries.filter((e) => e.name !== 'assets/asset-2.docx'))));
    await refused('BAD-3', 'ARCHIVE_INVALID', async () =>
      importAs('BAD-3', await tampered((entries) => entries.map((e) => (e.name === 'academiapath-archive.json' ? { ...e, data: JSON.stringify({ ...JSON.parse((e.data as Buffer).toString('utf8')), formatVersion: 2 }) } : e)))),
    );
    await refused('BAD-4', 'ARCHIVE_INVALID', () => importAs('BAD-4', Buffer.from('not an archive')));
    // A prerequisite to a unit that does not exist, rewritten consistently (package hash and manifest updated).
    const broken = await tampered((entries) => {
      const pkg = JSON.parse((entries.find((e) => e.name === 'course.json')!.data as Buffer).toString('utf8')) as CoursePackage;
      pkg.course.units[1]!.requiresUnitKeys = ['unit-99'];
      pkg.contentHash = packageContentHash(pkg.course, pkg.assets);
      const json = Buffer.from(JSON.stringify(pkg));
      return entries.map((e) => {
        if (e.name === 'course.json') return { ...e, data: json };
        if (e.name !== 'academiapath-archive.json') return e;
        const manifest = JSON.parse((e.data as Buffer).toString('utf8'));
        manifest.package = { ...manifest.package, contentHash: pkg.contentHash, byteSize: json.length, sha256: sha(json) };
        return { ...e, data: JSON.stringify(manifest) };
      });
    });
    await refused('BAD-5', 'ARCHIVE_INVALID', () => importAs('BAD-5', broken));
    assert.equal(faults.puts, 0, 'nothing was ever written to storage');
  });

  it('refuses non-administrators, a taken course code and a rejected document before storing anything', async () => {
    const instructor = sessions.get('instructor')!.userId;
    await refused('NOPE-1', 'FORBIDDEN', () => importAs('NOPE-1', sourceArchive, { actor: { userId: instructor, ip: null } }));
    await refused('SRC-1', 'COURSE_CODE_TAKEN', () => importAs('SRC-1'));
    const infected: MalwareScanner = { scan: async () => ({ status: 'infected', scanner: 'test' }) };
    const error = await refused('NOPE-2', 'DOCUMENT_REJECTED', () => importAs('NOPE-2', sourceArchive, {}, { ...deps, scanner: infected }));
    assert.equal(error.detail.documentCode, 'MALWARE_DETECTED');
    assert.equal(faults.puts, 0);
  });

  it('a storage failure removes the files already written: no course, no records, no files', async () => {
    faults.failPutAt = 2;
    const error = await refused('STORE-1', 'STORAGE_FAILED', () => importAs('STORE-1'));
    assert.equal(error.orphanedFiles, 0);
    assert.ok(!error.message.includes(storageDir), 'no storage path in the error');
  });

  it('a database failure after the files were stored rolls back and removes the files', async () => {
    const failingDb = Object.create(database.db, {
      transaction: { value: (run: (tx: unknown) => Promise<unknown>, config?: unknown) => database.db.transaction(async (tx) => { await run(tx); throw new Error('simulated database failure'); }, config as never) },
    }) as Database;
    const error = await refused('DB-1', 'IMPORT_FAILED', () => importAs('DB-1', sourceArchive, {}, { ...deps, db: failingDb }));
    assert.equal(faults.puts, 3, 'all three files had been stored before the failure');
    assert.equal(error.orphanedFiles, 0);
    assert.ok(!error.message.includes('simulated'), 'internal details stay server-side');
  });

  it('when the cleanup itself fails, the error says how many files remain; they are unreferenced (found by the storage audit)', async () => {
    const before = await storedFiles();
    const failingDb = Object.create(database.db, {
      transaction: { value: (run: (tx: unknown) => Promise<unknown>, config?: unknown) => database.db.transaction(async (tx) => { await run(tx); throw new Error('simulated database failure'); }, config as never) },
    }) as Database;
    faults.failRemove = true;
    await assert.rejects(importAs('DB-2', sourceArchive, {}, { ...deps, db: failingDb }), (error: unknown) => {
      assert.ok(error instanceof ArchiveImportError);
      assert.deepEqual([error.problem, error.orphanedFiles], ['IMPORT_FAILED', 3]);
      return true;
    });
    const leftover = [...(await storedFiles())].filter((name) => !before.has(name));
    assert.equal(leftover.length, 3, 'three unreferenced files remain');
    const referenced = await database.db.select({ id: courseDocuments.id }).from(courseDocuments).where(inArray(courseDocuments.storageKey, leftover));
    assert.deepEqual(referenced, [], 'nothing refers to them, so they are never served');
    assert.equal(await courseByCode('DB-2'), null);
    for (const name of leftover) await rm(join(storageDir, name));
  });

  it('an unexpected exception before storage is reported as a failed import with nothing created', async () => {
    const crashing: MalwareScanner = { scan: async () => Promise.reject(new Error('scanner crashed')) };
    const error = await refused('CRASH-1', 'IMPORT_FAILED', () => importAs('CRASH-1', sourceArchive, {}, { ...deps, scanner: crashing }));
    assert.equal(faults.puts, 0);
    assert.ok(!error.message.includes('scanner crashed'));
  });

  it('the JSON import is unchanged: the same course.json alone still skips its documents', async () => {
    const pkg = JSON.parse((await zipEntries(sourceArchive))[1]!.data.toString('utf8'));
    const preview = ok(await call('admin', 'POST', '/course-imports/preview', pkg));
    assert.equal(preview.skipped.filter((s: { reason: string }) => s.reason === 'DOCUMENT_NOT_BUNDLED').length, 3);
    assert.equal(preview.counts.importableActivities, 4);
  });
});
