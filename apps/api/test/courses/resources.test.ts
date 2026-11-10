/**
 * Learning resources (AP-021) on the synthetic demo dataset, against a temporary PostgreSQL database
 * (skipped unless TEST_DATABASE_URL is set): link kinds, https-only resource URLs, resource folders,
 * ordering and visibility, the review workflow, student visibility, prerequisites, progress compatibility,
 * role boundaries, cross-course protection, database constraints, CSRF/Origin and audit records.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { ACCOUNTS, type Persona } from '../../scripts/demo/content.js';
import { seedDemo, type DemoReport } from '../../scripts/seed-demo.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const ITIL = 'ITIL4-F-2026-2-A';
const PMF = 'PMF-2026-2-A';
const DRAFT = 'ITIL4-F-2026-2-B';

type App = ReturnType<typeof buildApp>;
type Session = { token: string; csrf: string; userId: string };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Folder = { id: string; sectionId: string; title: string; position: number };
type Activity = { id: string; type: string; title: string; folderId: string | null; isVisible: boolean; position: number; content: Record<string, unknown> };

describe('learning resources (PostgreSQL, demo dataset)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let report: DemoReport;
  let app: App;
  const as = {} as Record<Persona, Session>;
  const ids = {} as { module1: string; module2: string; folder: string; video: string; interactive: string; website: string };

  const courseId = (code: string) => report.courses.find((c) => c.code === code)!.id;
  const request = (method: Method, url: string, options: { session?: Session; body?: unknown; csrf?: string | null; origin?: string | null } = {}) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: options.session ? { ap_session: options.session.token } : {},
      headers: {
        ...(options.origin === null ? {} : { origin: options.origin ?? ORIGIN }),
        ...(options.session && method !== 'GET' && options.csrf !== null ? { 'x-csrf-token': options.csrf ?? options.session.csrf } : {}),
      },
      ...(options.body !== undefined ? { payload: options.body as object } : {}),
    });
  const call = (who: Persona, method: Method, url: string, body?: unknown) => request(method, url, { session: as[who], body });
  const ok = async <T = unknown>(who: Persona, method: Method, url: string, body?: unknown, status = 200): Promise<T> => {
    const res = await call(who, method, url, body);
    assert.equal(res.statusCode, status, `${method} ${url} as ${who}: ${res.body}`);
    return (res.body ? res.json() : null) as T;
  };
  const expectProblem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };
  const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[];
  const count = async (sql: string, params: unknown[] = []) => Number((await query<{ n: number }>(sql, params))[0]!.n);
  const sectionId = async (code: string, title: string) => (await query<{ id: string }>('SELECT id FROM sections WHERE course_id = $1 AND title = $2', [courseId(code), title]))[0]!.id;
  const list = (who: Persona, section: string, code = ITIL) => ok<{ items: Activity[] }>(who, 'GET', `/courses/${courseId(code)}/sections/${section}/activities?limit=100`).then((r) => r.items);
  const folders = (who: Persona, section: string, code = ITIL) => ok<{ items: Folder[] }>(who, 'GET', `/courses/${courseId(code)}/sections/${section}/resource-folders`).then((r) => r.items);
  const progress = (who: Persona, code = ITIL) => ok<{ completedCount: number; totalCount: number }>(who, 'GET', `/courses/${courseId(code)}/progress`);
  const createLink = (who: Persona, section: string, body: Record<string, unknown>) => call(who, 'POST', `/courses/${courseId(ITIL)}/sections/${section}/activities`, { type: 'link', ...body });
  /** Instructor submits, design team approves: the existing review workflow publishes the resource. */
  const publish = async (activityId: string) => {
    await ok('instructor', 'POST', `/courses/${courseId(ITIL)}/activities/${activityId}/submit`);
    await ok('reviewer', 'POST', `/courses/${courseId(ITIL)}/activities/${activityId}/review`, { decision: 'approve' });
  };
  const organize = (who: Persona, activityId: string, body: Record<string, unknown>, code = ITIL) => call(who, 'PUT', `/courses/${courseId(code)}/activities/${activityId}/organization`, body);
  const audits = (action: string, entityId: string) => count('SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND entity_id = $2', [action, entityId]);

  before(async () => {
    database = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'ap-resources-'));
    const env = { NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: join(root, 'store') };
    report = await seedDemo(database.db, { password: PASSWORD, env, uploadFilesDir: null });
    app = buildApp({ config: { ...loadConfig(env), loginRateLimit: { max: 1000, windowMs: 60_000 } }, database: database.db });
    await app.ready();
    for (const persona of Object.keys(ACCOUNTS) as Persona[]) {
      const res = await request('POST', '/auth/login', { body: { email: ACCOUNTS[persona], password: PASSWORD } });
      assert.equal(res.statusCode, 200, res.body);
      as[persona] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
    }
    ids.module1 = await sectionId(ITIL, 'Module 1 - Service management concepts');
    ids.module2 = await sectionId(ITIL, 'Module 2 - The service value system');
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('creates resource folders and video, interactive and website links in a folder (drafts for review)', async () => {
    const folder = await ok<Folder>('instructor', 'POST', `/courses/${courseId(ITIL)}/sections/${ids.module1}/resource-folders`, { title: '  Further learning  ' }, 201);
    assert.deepEqual([folder.title, folder.position, folder.sectionId], ['Further learning', 0, ids.module1]);
    ids.folder = folder.id;
    const created: Record<string, Activity> = {};
    for (const [kind, url] of [
      ['video', 'https://www.youtube.com/watch?v=synthetic-itil'],
      ['interactive', 'https://phet.colorado.edu/en/simulations/synthetic'],
      ['website', 'https://www.axelos.com/certifications/itil-service-management'],
    ] as const) {
      const res = await createLink('instructor', ids.module1, { title: `ITIL ${kind}`, url, kind, description: 'Synthetic resource.', folderId: folder.id });
      assert.equal(res.statusCode, 201, res.body);
      created[kind] = res.json();
    }
    assert.deepEqual(created.video!.content, { url: 'https://www.youtube.com/watch?v=synthetic-itil', description: 'Synthetic resource.', kind: 'video' });
    assert.deepEqual([created.video!.folderId, (created.video as unknown as { review: { status: string } }).review.status], [folder.id, 'draft']);
    ids.video = created.video!.id;
    ids.interactive = created.interactive!.id;
    ids.website = created.website!.id;
    // A link without a kind is a website; lessons can go into folders too.
    const plain = await createLink('instructor', ids.module1, { title: 'Plain link', url: 'https://example.edu/plain' });
    assert.equal(plain.json().content.kind, 'website');
    const lesson = await call('instructor', 'POST', `/courses/${courseId(ITIL)}/sections/${ids.module1}/activities`, { type: 'page', title: 'Folder lesson', body: 'Text.', folderId: folder.id });
    assert.equal(lesson.json().folderId, folder.id);
    // Quizzes and assignments cannot be created in a folder; a folder of another section is refused.
    const quiz = await call('instructor', 'POST', `/courses/${courseId(ITIL)}/sections/${ids.module1}/activities`, { type: 'quiz', title: 'Q', attemptLimit: 1, folderId: folder.id });
    assert.equal(quiz.statusCode, 400, quiz.body);
    expectProblem(await createLink('instructor', ids.module2, { title: 'Wrong folder', url: 'https://example.edu/x', folderId: folder.id }), 422, 'RESOURCE_FOLDER_NOT_FOUND');
    assert.equal(await audits('resource_folder.created', folder.id), 1);
    // The persisted record is a normal link activity (no new storage or approval system).
    assert.deepEqual((await query('SELECT type, review_status, folder_id FROM activities WHERE id = $1', [ids.video]))[0], { type: 'link', review_status: 'draft', folder_id: folder.id });
  });

  it('rejects unsafe or non-https resource URLs on create and edit', async () => {
    const unsafe = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://example.edu/file',
      'http://example.edu/plain-http',
      'https://user:secret@example.edu/',
      'https://127.0.0.1/admin',
      'https://[::1]/',
      'https://localhost/x',
      'https://intranet/x',
      'https://evil.localhost/x',
      '//example.edu/protocol-relative',
      '/relative/path',
      'https://exa mple.edu/',
      'https://example.edu/\u0000',
      `https://example.edu/${'a'.repeat(2050)}`,
    ];
    for (const url of unsafe) {
      const res = await createLink('instructor', ids.module1, { title: 'Unsafe', url, kind: 'video' });
      assert.ok([400, 422].includes(res.statusCode), `${url.slice(0, 40)} → ${res.statusCode}`);
      if (res.statusCode === 422) assert.equal(res.json().code, 'INVALID_URL');
    }
    expectProblem(await call('instructor', 'PUT', `/courses/${courseId(ITIL)}/activities/${ids.video}`, { title: 'X', url: 'javascript:alert(1)', kind: 'video' }), 422, 'INVALID_URL');
    expectProblem(await call('instructor', 'PUT', `/courses/${courseId(ITIL)}/activities/${ids.video}`, { title: 'X', url: 'http://example.edu/', kind: 'video' }), 422, 'INVALID_URL');
    const badKind = await createLink('instructor', ids.module1, { title: 'Embed', url: 'https://example.edu/', kind: 'embed' });
    assert.equal(badKind.statusCode, 400);
    assert.equal(await count("SELECT count(*)::int AS n FROM activities WHERE title IN ('Unsafe', 'Embed')"), 0, 'nothing unsafe was stored');
  });

  it('students only see approved, visible resources and folders that contain them', async () => {
    const before = await progress('student');
    assert.deepEqual(await folders('student', ids.module1), [], 'a folder with only drafts is not shown (title not revealed)');
    assert.ok(!(await list('student', ids.module1)).some((a) => a.folderId === ids.folder));
    expectProblem(await call('student', 'GET', `/courses/${courseId(ITIL)}/activities/${ids.video}`), 404, 'NOT_FOUND');
    await publish(ids.video);
    await publish(ids.interactive);
    const visible = await list('student', ids.module1);
    const video = visible.find((a) => a.id === ids.video)!;
    assert.deepEqual([video.folderId, video.content.kind, video.content.url], [ids.folder, 'video', 'https://www.youtube.com/watch?v=synthetic-itil']);
    assert.ok(!visible.some((a) => a.id === ids.website), 'the unreviewed website link stays hidden');
    assert.deepEqual((await folders('student', ids.module1)).map((f) => f.title), ['Further learning']);
    // Editing the approved video creates a draft revision; students keep the approved version.
    await ok('instructor', 'PUT', `/courses/${courseId(ITIL)}/activities/${ids.video}`, { title: 'ITIL video (revised)', url: 'https://vimeo.com/123456', kind: 'video' });
    const live = await ok<Activity>('student', 'GET', `/courses/${courseId(ITIL)}/activities/${ids.video}`);
    assert.deepEqual([live.title, live.content.url], ['ITIL video', 'https://www.youtube.com/watch?v=synthetic-itil']);
    // Progress: each newly approved, visible resource counts exactly once, wherever it is filed.
    assert.equal((await progress('student')).totalCount, before.totalCount + 2);
  });

  it('organizes resources: rename, reorder folders and activities, move between folders, show and hide', async () => {
    const second = await ok<Folder>('instructor', 'POST', `/courses/${courseId(ITIL)}/sections/${ids.module1}/resource-folders`, { title: 'Videos' }, 201);
    await ok('instructor', 'PUT', `/courses/${courseId(ITIL)}/resource-folders/${ids.folder}`, { title: 'Further reading' });
    assert.equal(await audits('resource_folder.renamed', ids.folder), 1);
    const reordered = await ok<{ items: Folder[] }>('instructor', 'PUT', `/courses/${courseId(ITIL)}/sections/${ids.module1}/resource-folders/order`, { folderIds: [second.id, ids.folder] });
    assert.deepEqual(reordered.items.map((f) => [f.title, f.position]), [['Videos', 0], ['Further reading', 1]]);
    expectProblem(await call('instructor', 'PUT', `/courses/${courseId(ITIL)}/sections/${ids.module1}/resource-folders/order`, { folderIds: [second.id] }), 409, 'RESOURCE_ORDER_STALE');
    assert.equal((await call('instructor', 'PUT', `/courses/${courseId(ITIL)}/sections/${ids.module1}/resource-folders/order`, { folderIds: [second.id, second.id] })).statusCode, 400);

    // Move the video into the "Videos" folder; the student's progress total does not change.
    const totalBefore = (await progress('student')).totalCount;
    const moved = await organize('instructor', ids.video, { folderId: second.id });
    assert.deepEqual(moved.json(), { id: ids.video, folderId: second.id, isVisible: true });
    assert.equal((await list('student', ids.module1)).find((a) => a.id === ids.video)?.folderId, second.id);
    assert.equal((await progress('student')).totalCount, totalBefore, 'moving never double counts');

    // Reorder all activities of the section (staff see every activity).
    const all = await list('instructor', ids.module1);
    const reversed = all.map((a) => a.id).reverse();
    await ok('instructor', 'PUT', `/courses/${courseId(ITIL)}/sections/${ids.module1}/activities/order`, { activityIds: reversed });
    assert.deepEqual((await list('instructor', ids.module1)).map((a) => a.id), reversed);
    expectProblem(await call('instructor', 'PUT', `/courses/${courseId(ITIL)}/sections/${ids.module1}/activities/order`, { activityIds: reversed.slice(1) }), 409, 'RESOURCE_ORDER_STALE');
    const foreign = (await list('instructor', ids.module2))[0]!.id;
    expectProblem(await call('instructor', 'PUT', `/courses/${courseId(ITIL)}/sections/${ids.module1}/activities/order`, { activityIds: [...reversed.slice(1), foreign] }), 409, 'RESOURCE_ORDER_STALE');
    assert.equal(await audits('activity.reordered', ids.module1), 1);

    // Hiding removes the resource from students, their progress and the folder list; showing restores it.
    const hidden = await organize('instructor', ids.video, { isVisible: false });
    assert.equal(hidden.json().isVisible, false);
    assert.ok(!(await list('student', ids.module1)).some((a) => a.id === ids.video));
    expectProblem(await call('student', 'GET', `/courses/${courseId(ITIL)}/activities/${ids.video}`), 404, 'NOT_FOUND');
    assert.ok(!(await folders('student', ids.module1)).some((f) => f.id === second.id), 'a folder with only hidden content is not shown');
    assert.equal((await progress('student')).totalCount, totalBefore - 1);
    expectProblem(await call('student', 'PUT', `/courses/${courseId(ITIL)}/activities/${ids.video}/completion`), 404, 'NOT_FOUND');
    await organize('instructor', ids.video, { isVisible: true });
    assert.equal((await progress('student')).totalCount, totalBefore);
    assert.equal(await audits('activity.organized', ids.video), 3);

    // Folders are deleted only when empty; content is never deleted with them.
    expectProblem(await call('instructor', 'DELETE', `/courses/${courseId(ITIL)}/resource-folders/${second.id}`), 409, 'RESOURCE_FOLDER_NOT_EMPTY');
    await organize('instructor', ids.video, { folderId: null });
    assert.equal((await call('instructor', 'DELETE', `/courses/${courseId(ITIL)}/resource-folders/${second.id}`)).statusCode, 204);
    assert.equal(await count('SELECT count(*)::int AS n FROM activities WHERE id = $1', [ids.video]), 1);
    assert.equal(await audits('resource_folder.deleted', second.id), 1);
  });

  it('only reading activities can be organized; quizzes and assignments keep their grading rules', async () => {
    const quiz = (await query<{ id: string }>("SELECT a.id FROM activities a JOIN sections s ON s.id = a.section_id WHERE s.course_id = $1 AND a.type = 'quiz' LIMIT 1", [courseId(ITIL)]))[0]!.id;
    const assignment = (await query<{ id: string }>("SELECT a.id FROM activities a JOIN sections s ON s.id = a.section_id WHERE s.course_id = $1 AND a.type = 'assignment' LIMIT 1", [courseId(ITIL)]))[0]!.id;
    for (const id of [quiz, assignment]) {
      expectProblem(await organize('instructor', id, { isVisible: false }), 422, 'RESOURCE_NOT_ORGANIZABLE');
      expectProblem(await organize('instructor', id, { folderId: ids.folder }), 422, 'RESOURCE_NOT_ORGANIZABLE');
    }
    assert.equal(await count('SELECT count(*)::int AS n FROM activities WHERE id = ANY($1::uuid[]) AND (folder_id IS NOT NULL OR NOT is_visible)', [[quiz, assignment]]), 0);
    // A lesson can be filed into a folder of its own section only.
    const lesson = (await list('instructor', ids.module2)).find((a) => a.type === 'page')!.id;
    expectProblem(await organize('instructor', lesson, { folderId: ids.folder }), 422, 'RESOURCE_FOLDER_NOT_FOUND');
  });

  it('enforces role boundaries for every organization operation', async () => {
    const url = `/courses/${courseId(ITIL)}`;
    const writes: Array<[Method, string, unknown]> = [
      ['POST', `${url}/sections/${ids.module1}/resource-folders`, { title: 'Nope' }],
      ['PUT', `${url}/resource-folders/${ids.folder}`, { title: 'Nope' }],
      ['DELETE', `${url}/resource-folders/${ids.folder}`, undefined],
      ['PUT', `${url}/sections/${ids.module1}/resource-folders/order`, { folderIds: [ids.folder] }],
      ['PUT', `${url}/sections/${ids.module1}/activities/order`, { activityIds: [] }],
      ['PUT', `${url}/activities/${ids.interactive}/organization`, { isVisible: false }],
    ];
    for (const who of ['student', 'ta'] as const) {
      for (const [method, path, body] of writes) expectProblem(await call(who, method, path, body), 403, 'FORBIDDEN');
    }
    // Users without a role in the course (learner B is not in PMF) see nothing and change nothing.
    const pmfSection = (await query<{ id: string }>('SELECT id FROM sections WHERE course_id = $1 LIMIT 1', [courseId(PMF)]))[0]!.id;
    expectProblem(await call('learnerB', 'GET', `/courses/${courseId(PMF)}/sections/${pmfSection}/resource-folders`), 404, 'NOT_FOUND');
    expectProblem(await call('learnerB', 'POST', `/courses/${courseId(PMF)}/sections/${pmfSection}/resource-folders`, { title: 'X' }), 404, 'NOT_FOUND');
    // The design team (content.edit) and administrators may organize; the non-editing instructor may read.
    assert.equal((await ok<Folder>('reviewer', 'POST', `${url}/sections/${ids.module2}/resource-folders`, { title: 'Design team folder' }, 201)).title, 'Design team folder');
    assert.equal((await ok<Folder>('admin', 'POST', `${url}/sections/${ids.module2}/resource-folders`, { title: 'Admin folder' }, 201)).title, 'Admin folder');
    assert.equal((await folders('ta', ids.module2)).length, 2, 'staff see empty folders');
    assert.equal(await count("SELECT count(*)::int AS n FROM resource_folders WHERE title = 'Nope'"), 0);
  });

  it('prevents cross-course changes in the API and the database', async () => {
    const pmf = courseId(PMF);
    const pmfSection = (await query<{ id: string }>('SELECT id FROM sections WHERE course_id = $1 ORDER BY position LIMIT 1', [pmf]))[0]!.id;
    // Folder and activity ids from ITIL used through the PMF course path are not found.
    expectProblem(await call('instructor', 'PUT', `/courses/${pmf}/resource-folders/${ids.folder}`, { title: 'Moved' }), 404, 'NOT_FOUND');
    expectProblem(await call('instructor', 'DELETE', `/courses/${pmf}/resource-folders/${ids.folder}`), 404, 'NOT_FOUND');
    expectProblem(await organize('instructor', ids.interactive, { isVisible: false }, PMF), 404, 'NOT_FOUND');
    expectProblem(await call('instructor', 'POST', `/courses/${courseId(ITIL)}/sections/${pmfSection}/resource-folders`, { title: 'X' }), 404, 'NOT_FOUND');
    // A PMF activity cannot be filed into an ITIL folder.
    const pmfLesson = (await list('instructor', pmfSection, PMF)).find((a) => a.type === 'page')!.id;
    expectProblem(await organize('instructor', pmfLesson, { folderId: ids.folder }, PMF), 404, 'NOT_FOUND');
    // Database backstops: same-section folder key, reading types only, same-course folder section, non-empty delete.
    await assert.rejects(query('UPDATE activities SET folder_id = $1 WHERE id = $2', [ids.folder, pmfLesson]), /activities_folder_fk/);
    const quiz = (await query<{ id: string }>("SELECT a.id FROM activities a WHERE a.section_id = $1 AND a.type = 'quiz' LIMIT 1", [await sectionId(ITIL, 'Module 3 - Practices and continual improvement')]))[0]!.id;
    await assert.rejects(query('UPDATE activities SET folder_id = $1 WHERE id = $2', [ids.folder, quiz]), /activities_folder/);
    await assert.rejects(
      query('INSERT INTO resource_folders (course_id, section_id, title, position) VALUES ($1, $2, $3, 0)', [pmf, ids.module1, 'Cross-course']),
      /resource_folders_section_fk/,
    );
    await assert.rejects(query('DELETE FROM resource_folders WHERE id = $1', [ids.folder]), /activities_folder_fk/);
  });

  it('keeps hidden sections, prerequisite locks and draft courses closed to students', async () => {
    const id = courseId(ITIL);
    // Prerequisite: module 1 requires module 2, which the student has not completed, so module 1 locks.
    await ok('admin', 'PUT', `/courses/${id}/sections/${ids.module1}/prerequisites`, { requiredSectionIds: [ids.module2] });
    expectProblem(await call('student', 'GET', `/courses/${id}/sections/${ids.module1}/resource-folders`), 403, 'SECTION_LOCKED');
    expectProblem(await call('student', 'GET', `/courses/${id}/activities/${ids.interactive}`), 403, 'SECTION_LOCKED');
    assert.equal((await call('instructor', 'GET', `/courses/${id}/sections/${ids.module1}/resource-folders`)).statusCode, 200, 'staff are never locked');
    await ok('admin', 'PUT', `/courses/${id}/sections/${ids.module1}/prerequisites`, { requiredSectionIds: [] });
    // Hidden section: folders are not found for students.
    const hidden = await sectionId(ITIL, 'Instructor notes');
    expectProblem(await call('student', 'GET', `/courses/${id}/sections/${hidden}/resource-folders`), 404, 'NOT_FOUND');
    // Draft course: nothing at all.
    const draftSection = (await query<{ id: string }>('SELECT id FROM sections WHERE course_id = $1 LIMIT 1', [courseId(DRAFT)]))[0]!.id;
    expectProblem(await call('student', 'GET', `/courses/${courseId(DRAFT)}/sections/${draftSection}/resource-folders`), 404, 'NOT_FOUND');
  });

  it('integrates with progress: students complete link resources once; legacy http links stay readable', async () => {
    const before = await progress('student');
    const mark = await call('student', 'PUT', `/courses/${courseId(ITIL)}/activities/${ids.interactive}/completion`);
    assert.equal(mark.statusCode, 200, mark.body);
    await call('student', 'PUT', `/courses/${courseId(ITIL)}/activities/${ids.interactive}/completion`);
    const after = await progress('student');
    assert.deepEqual([after.completedCount, after.totalCount], [before.completedCount + 1, before.totalCount]);
    assert.equal(await count('SELECT count(*)::int AS n FROM activity_completions WHERE activity_id = $1', [ids.interactive]), 1);
    // A link stored before AP-021 with an http URL and no kind is still served (as a website), and only new writes are strict.
    await query(`UPDATE activities SET approved_config = '{"url": "http://example.edu/legacy", "description": null}'::jsonb WHERE id = $1`, [ids.interactive]);
    const legacy = await ok<Activity>('student', 'GET', `/courses/${courseId(ITIL)}/activities/${ids.interactive}`);
    assert.deepEqual(legacy.content, { url: 'http://example.edu/legacy', description: null, kind: 'website' });
  });

  it('protects every new write with CSRF and Origin checks', async () => {
    const id = courseId(ITIL);
    const writes: Array<[Method, string, unknown]> = [
      ['POST', `/courses/${id}/sections/${ids.module1}/resource-folders`, { title: 'CSRF' }],
      ['PUT', `/courses/${id}/resource-folders/${ids.folder}`, { title: 'CSRF' }],
      ['DELETE', `/courses/${id}/resource-folders/${ids.folder}`, undefined],
      ['PUT', `/courses/${id}/sections/${ids.module1}/resource-folders/order`, { folderIds: [ids.folder] }],
      ['PUT', `/courses/${id}/sections/${ids.module1}/activities/order`, { activityIds: [] }],
      ['PUT', `/courses/${id}/activities/${ids.interactive}/organization`, { isVisible: false }],
    ];
    for (const [method, url, body] of writes) {
      expectProblem(await request(method, url, { session: as.instructor, csrf: null, body }), 403, 'CSRF_TOKEN_INVALID');
      expectProblem(await request(method, url, { session: as.instructor, origin: 'https://evil.example', body }), 403, 'ORIGIN_NOT_ALLOWED');
      expectProblem(await request(method, url, { body }), 401, 'UNAUTHENTICATED');
    }
    assert.equal(await count("SELECT count(*)::int AS n FROM resource_folders WHERE title = 'CSRF'"), 0);
    assert.equal((await query<{ is_visible: boolean }>('SELECT is_visible FROM activities WHERE id = $1', [ids.interactive]))[0]!.is_visible, true);
  });
});
