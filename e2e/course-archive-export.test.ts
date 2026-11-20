/**
 * AP-038C1E "Download with documents" in the browser (run through e2e/run.sh against the production build and the demo
 * seed). A dedicated course (isolatedCourse) holds synthetic PDF, DOCX and PPTX documents; the archive is downloaded
 * through the real web proxy and checked entry by entry against its manifest. Failures are simulated in the browser
 * (page.route), so the per-user rate limit and real storage are not spent; the real error paths are covered by the API
 * suite. Exporting only reads: the course and the student's view of it are unchanged afterwards.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { makeDocx, makePdf, makePptx } from '../apps/api/test/helpers/documents.ts';
import { zipEntries } from '../apps/api/test/helpers/zip.ts';
import { scanArchive } from '../apps/api/src/scorm/archive.ts';
import { API, apiGet, BASE, context, isolatedCourse, launch, leaks, MESSAGES, session, settle, type Locale, type Role } from './support.ts';

const TAG = Date.now().toString(36).toUpperCase();
const CODE = `ZZ-C1E-ARC-${TAG}`;
const FILES = [
  { name: 'handout.pdf', title: 'Archive handout', type: 'application/pdf', data: makePdf([['Archive handout', 'Synthetic archive page.']]) },
  { name: 'notes.docx', title: 'Archive notes', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: makeDocx(['Synthetic archive notes.']) },
  { name: 'slides.pptx', title: 'Archive slides', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', data: makePptx([['Synthetic archive slide']]) },
];
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let browser: Browser;
let course: Awaited<ReturnType<typeof isolatedCourse>>;
let before0: unknown;

type Manifest = { format: string; package: { sha256: string; byteSize: number }; assets: Array<{ key: string; path: string; byteSize: number; sha256: string }>; totals: { assets: number; assetBytes: number } };

/** Uploads one synthetic document as the instructor (the documents API's multipart form). */
async function upload(file: (typeof FILES)[number]) {
  const { cookies, csrfToken } = await session('instructor');
  const form = new FormData();
  form.append('title', file.title);
  form.append('file', new Blob([file.data], { type: file.type }), file.name);
  const res = await fetch(`${API}/courses/${course.courseId}/sections/${course.sectionId}/documents`, {
    method: 'POST',
    headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '), origin: BASE, 'x-csrf-token': csrfToken },
    body: form,
  });
  assert.equal(res.status, 201, await res.text());
}

/** The course's stored content and the student's view of it, to prove an export changes nothing. */
async function snapshot() {
  const sections = (await apiGet<{ items: Array<{ id: string }> }>('instructor', `/courses/${course.courseId}/sections?limit=100`)).items;
  const activities = [];
  for (const section of sections) activities.push(await apiGet<unknown>('instructor', `/courses/${course.courseId}/sections/${section.id}/activities?limit=100`));
  return { sections, activities, student: await apiGet<unknown>('student', `/courses/${course.courseId}/sections?limit=100`) };
}

async function open(role: Role, locale: Locale, width = 1440): Promise<Page> {
  const page = await (await context(browser, locale, role, { width })).newPage();
  await page.goto(`${BASE}/courses/${course.courseId}`);
  await settle(page);
  return page;
}

/** Clicks "Download with documents" and returns the saved file, checked as a complete, consistent archive. */
async function downloadArchive(page: Page, locale: Locale) {
  const c = MESSAGES[locale].courses;
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: c.exportArchive, exact: true }).click()]);
  const bytes = await readFile((await file.path())!);
  await page.getByText(c.exportArchiveDone).waitFor();
  return { fileName: file.suggestedFilename(), bytes, ...(await verify(bytes)) };
}

async function verify(bytes: Buffer) {
  const problems: string[] = [];
  assert.equal((await scanArchive(bytes, { error: (problem) => problems.push(problem) })).safe, true, problems.join(', '));
  const entries = await zipEntries(bytes);
  assert.deepEqual(entries.map((entry) => entry.name), ['academiapath-archive.json', 'course.json', 'assets/asset-1.pdf', 'assets/asset-2.docx', 'assets/asset-3.pptx']);
  const manifest = JSON.parse(entries[0]!.data.toString('utf8')) as Manifest;
  assert.equal(manifest.format, 'academiapath.course-archive');
  assert.equal(manifest.package.sha256, sha(entries[1]!.data));
  for (const [index, asset] of manifest.assets.entries()) {
    const entry = entries.find((candidate) => candidate.name === asset.path)!;
    assert.equal(sha(entry.data), asset.sha256, asset.path);
    assert.ok(entry.data.equals(FILES[index]!.data), `${asset.path}: the uploaded bytes`);
  }
  const pkg = JSON.parse(entries[1]!.data.toString('utf8')) as { format: string; source: { courseCode: string } };
  assert.deepEqual([pkg.format, pkg.source.courseCode], ['academiapath.course-package', CODE]);
  return { entries, manifest };
}

/** Clicks EN or ES in the header and waits until the page has switched. */
async function switchTo(page: Page, locale: Locale) {
  await page.locator(`button[lang="${locale}"]:visible`).first().click();
  await page.waitForFunction((value) => document.documentElement.lang === value, locale);
  await page.waitForTimeout(300);
}

const noOverflow = async (page: Page, width: number) => {
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `${width} px: no horizontal overflow`);
  const box = (await page.locator('[data-course-archive-export]').boundingBox())!;
  assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `${width} px: the button is on screen`);
};

before(async () => {
  browser = await launch();
  course = await isolatedCourse(CODE, `Archive export fixture ${TAG}`, [
    ['instructor', 'instructor'],
    ['reviewer', 'design_team'],
    ['ta', 'non_editing_instructor'],
    ['student', 'student'],
  ]);
  for (const file of FILES) await upload(file);
  before0 = await snapshot();
});

after(async () => {
  await browser?.close();
  await course?.cleanup();
});

describe('course archive export (AP-038C1E)', () => {
  it('EN 1440 px: an instructor downloads the ZIP with every document; the JSON export still works beside it', async () => {
    const page = await open('instructor', 'en');
    await noOverflow(page, 1440);
    const { fileName, manifest } = await downloadArchive(page, 'en');
    assert.equal(fileName, `course-${CODE}.academiapath.zip`, 'the server file name is kept');
    assert.deepEqual(manifest.totals, { assets: 3, assetBytes: FILES.reduce((sum, file) => sum + file.data.length, 0) });
    const [json] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: MESSAGES.en.courses.exportContent, exact: true }).click()]);
    assert.equal(json.suggestedFilename(), `course-${CODE}.academiapath.json`);
    assert.equal((JSON.parse(await readFile((await json.path())!, 'utf8')) as { formatVersion: number }).formatVersion, 1);
    assert.deepEqual(await leaks(page, 'en'), []);
    await page.context().close();
  });

  it('ES 390 px: the design team downloads it ("Descargar con documentos"); the layout fits the phone width', async () => {
    const page = await open('reviewer', 'es', 390);
    await noOverflow(page, 390);
    await downloadArchive(page, 'es');
    await noOverflow(page, 390);
    assert.deepEqual(await leaks(page, 'es'), []);
    await page.context().close();
  });

  it('an administrator downloads it twice: both archives are complete and their files identical', async () => {
    const page = await open('admin', 'en');
    const first = await downloadArchive(page, 'en');
    const second = await downloadArchive(page, 'en');
    assert.deepEqual(second.manifest.assets, first.manifest.assets);
    for (const path of first.manifest.assets.map((asset) => asset.path)) {
      assert.ok(first.entries.find((e) => e.name === path)!.data.equals(second.entries.find((e) => e.name === path)!.data), path);
    }
    await page.context().close();
  });

  it('keyboard: the action is reached with Tab and started with Enter; while it runs it is disabled and sends one request', async () => {
    const page = await open('instructor', 'en');
    let requests = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/v1/courses/*/export/archive', async (route) => {
      requests += 1;
      await held;
      await route.continue();
    });
    for (let i = 0; i < 80; i += 1) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.hasAttribute('data-course-archive-export'))) break;
    }
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-course-archive-export')), true, 'reached by keyboard');
    const downloaded = page.waitForEvent('download');
    await page.keyboard.press('Enter');
    const busy = page.getByRole('button', { name: MESSAGES.en.courses.exportingArchive });
    await busy.waitFor();
    assert.equal(await busy.isDisabled(), true);
    await busy.click({ force: true }).catch(() => undefined);
    await page.keyboard.press('Enter');
    release();
    const file = await downloaded;
    await verify(await readFile((await file.path())!));
    assert.equal(requests, 1, 'no duplicate export while one is running');
    await page.context().close();
  });

  it('students and non-editing instructors see no archive action, and the API refuses them', async () => {
    for (const role of ['student', 'ta'] as const) {
      const page = await open(role, 'en');
      await page.locator('main h1').waitFor();
      assert.equal(await page.locator('[data-course-archive-export]').count(), 0, role);
      assert.equal(await page.getByRole('button', { name: MESSAGES.en.courses.exportArchive }).count(), 0, role);
      await page.context().close();
      const signedIn = await session(role);
      const res = await fetch(`${API}/courses/${course.courseId}/export/archive`, { headers: { cookie: signedIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
      assert.equal(res.status, 403, role);
    }
  });

  it('every archive error is shown in Spanish and English and follows a language switch; nothing is downloaded', async () => {
    const page = await open('instructor', 'es');
    let downloads = 0;
    page.on('download', () => (downloads += 1));
    const ES = MESSAGES.es.errors;
    const EN = MESSAGES.en.errors;
    const cases = [
      { status: 422, code: 'COURSE_ARCHIVE_TOO_LARGE' },
      { status: 500, code: 'COURSE_ARCHIVE_DOCUMENT_MISSING' },
      { status: 500, code: 'COURSE_ARCHIVE_DOCUMENT_CORRUPT' },
      { status: 503, code: 'DOCUMENT_STORAGE_UNAVAILABLE' },
      { status: 503, code: 'COURSE_ARCHIVE_BUSY' },
      { status: 429, code: 'RATE_LIMITED' },
      { status: 403, code: 'FORBIDDEN' },
    ];
    const alert = page.locator('[data-course-archive-status="error"]');
    for (const { status, code } of cases) {
      const en = code === 'FORBIDDEN' ? EN.notAllowed : EN.codes[code]!;
      const es = code === 'FORBIDDEN' ? ES.notAllowed : ES.codes[code]!;
      await page.route('**/api/v1/courses/*/export/archive', (route) =>
        route.fulfill({ status, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: code, status, code, detail: en }) }),
      );
      await page.getByRole('button', { name: MESSAGES.es.courses.exportArchive, exact: true }).click();
      await alert.getByText(es).waitFor();
      await switchTo(page, 'en');
      await alert.getByText(en).waitFor();
      assert.equal(await alert.getByText(es).count(), 0, `${code}: no Spanish left`);
      await switchTo(page, 'es');
      await alert.getByText(es).waitFor();
      assert.deepEqual(await leaks(page, 'es'), [], code);
      await page.unroute('**/api/v1/courses/*/export/archive');
    }
    assert.equal(downloads, 0, 'a failed export never produces a file');
    await page.context().close();
  });

  it('a successful response that is not a ZIP is reported as a failure, never saved as an archive', async () => {
    const page = await open('instructor', 'en');
    let downloads = 0;
    page.on('download', () => (downloads += 1));
    for (const fake of [
      { contentType: 'text/html', body: '<!doctype html><title>Login</title>' },
      { contentType: 'application/zip', body: '{"not":"a zip"}' },
    ]) {
      await page.route('**/api/v1/courses/*/export/archive', (route) => route.fulfill({ status: 200, ...fake }));
      await page.getByRole('button', { name: MESSAGES.en.courses.exportArchive, exact: true }).click();
      await page.locator('[data-course-archive-status="error"]').getByText(MESSAGES.en.courses.exportArchiveFailed).waitFor();
      await page.unroute('**/api/v1/courses/*/export/archive');
    }
    await switchTo(page, 'es');
    await page.locator('[data-course-archive-status="error"]').getByText(MESSAGES.es.courses.exportArchiveFailed).waitFor();
    assert.equal(downloads, 0);
    await page.context().close();
  });

  it('the course and the student view are unchanged by the exports', async () => {
    assert.deepEqual(await snapshot(), before0);
  });
});
