/**
 * AP-038C2D course archive preview in the browser (run through e2e/run.sh against the production build and the demo
 * seed). Synthetic archives come from the real exporter (test/helpers/archives.ts) plus one archive of the demo course
 * downloaded from the API; each is checked through the real web proxy and preview API. Covered: the administrator's
 * report in English and Spanish, the PDF/DOCX/PPTX inventory, an empty course, invalid archives explained by code,
 * the browser's own refusals (nothing is sent), other roles, keyboard-only use, 390 and 1440 px layouts, the EN/ES
 * switch of a report and of errors already on screen, and that a preview creates no course and stores no file.
 *
 * The API allows 10 previews per administrator per 10 minutes and the demo seed has one administrator, so this file
 * sends at most 9 real previews; API refusals that are not about the archive are answered by the browser.
 */
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { validateCourseArchive } from '../apps/api/src/portability/archive-validation.ts';
import { ARCHIVE_MANIFEST_PATH } from '../apps/api/src/portability/course-archive.ts';
import { dataOf, editJson, exported, OFFICE, replace, tampered } from '../apps/api/test/helpers/archives.ts';
import { API, apiGet, BASE, context, launch, leaks, MESSAGES, session, settle, switchLocale, type Locale, type Role } from './support.ts';

const EN = MESSAGES.en.courseImport;
const ES = MESSAGES.es.courseImport;
const PATH = '/admin/courses/import/archive';
const PREVIEW_URL = '/api/v1/course-imports/archive/preview';
/** An authored title with markup: it must be shown as text, never rendered. */
const HTML_TITLE = '<img src=x onerror="window.__archiveXss=1"> Curso <b>Gestión</b> de servicios';
let browser: Browser;
const archives = {} as Record<'office' | 'empty' | 'corrupt' | 'version' | 'damaged' | 'demo', Buffer>;

async function open(role: Role, locale: Locale = 'en', width = 1440, path = PATH): Promise<Page> {
  const page = await (await context(browser, locale, role, { width })).newPage();
  await page.goto(`${BASE}${path}`);
  await settle(page);
  return page;
}
/** Counts the preview requests the page sends (each one is a real upload to the API). */
function countPreviews(page: Page) {
  const counter = { sent: 0 };
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes(PREVIEW_URL)) counter.sent += 1;
  });
  return counter;
}
async function check(page: Page, name: string, buffer: Buffer, labels = EN) {
  await page.setInputFiles('#archive-file', { name, mimeType: 'application/zip', buffer });
  await page.getByRole('button', { name: labels.archive.check, exact: true }).click();
  await page.locator('[data-archive-report]').waitFor({ timeout: 30_000 });
}
const status = (page: Page) => page.locator('[data-archive-report]').getAttribute('data-archive-status');
const field = (page: Page, key: string) => page.locator(`[data-archive-field="${key}"]`).innerText();
const count = (page: Page, key: string) => page.locator(`[data-archive-count="${key}"] [data-archive-count-value]`).innerText();
const issue = (page: Page, code: string) => page.locator(`[data-archive-issue="${code}"]`);
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? '');
const focusedText = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText?.trim() ?? '');

/** Rows that a preview must never create: courses and their content, documents, summaries and audit entries. */
async function databaseCounts() {
  const pg = ((await import(process.env.PG_MODULE!)) as { default: typeof import('pg') }).default;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const tables = ['courses', 'sections', 'activities', 'course_documents', 'document_summaries', 'audit_log'];
    const counts: Record<string, number> = {};
    for (const table of tables) counts[table] = Number((await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);
    return counts;
  } finally {
    await client.end();
  }
}
const storedFiles = async () => (await readdir(process.env.DOCUMENT_STORAGE_DIR!, { recursive: true }).catch(() => [] as string[])).sort();

/** A multipart upload straight to the API through the web proxy, as `role` (or anonymous). */
async function apiPreview(role: Role | null, buffer: Buffer) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: 'application/zip' }), 'course.zip');
  const signedIn = role ? await session(role) : null;
  const res = await fetch(`${API}/course-imports/archive/preview`, {
    method: 'POST',
    headers: { origin: BASE, ...(signedIn ? { cookie: signedIn.cookies.map((c) => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': signedIn.csrfToken } : {}) },
    body: form,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as { code?: string } | null };
}

before(async () => {
  assert.ok(process.env.DOCUMENT_STORAGE_DIR && process.env.DATABASE_URL && process.env.PG_MODULE, 'run through e2e/run.sh');
  browser = await launch();
  archives.office = await exported(OFFICE, { unsupported: true, title: HTML_TITLE, description: 'Primera línea.\nSegunda línea.' });
  archives.empty = await exported([], { page: false });
  archives.corrupt = Buffer.from('this is not a zip archive');
  archives.version = await tampered((entries) => editJson(entries, ARCHIVE_MANIFEST_PATH, (manifest) => (manifest.formatVersion = 2)));
  // A changed PDF (wrong checksum) and a missing Word file in one archive.
  archives.damaged = await tampered((entries) => {
    const pdf = Buffer.from(dataOf(entries, 'assets/asset-1.pdf'));
    pdf[pdf.length - 1] = pdf[pdf.length - 1]! ^ 0xff;
    return replace(entries, 'assets/asset-1.pdf', pdf).filter((entry) => entry.name !== 'assets/asset-2.docx');
  });
  // The demo course, exported with its documents through the real archive export (AP-038C1D).
  const demo = (await apiGet<{ items: Array<{ id: string; code: string }> }>('admin', '/courses?limit=100')).items.find((c) => c.code === 'ITIL4-F-2026-2-A')!;
  const admin = await session('admin');
  const res = await fetch(`${API}/courses/${demo.id}/export/archive`, { headers: { cookie: admin.cookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
  assert.equal(res.status, 200, 'the ZIP export still works');
  archives.demo = Buffer.from(await res.arrayBuffer());
});

after(async () => {
  await browser?.close();
});

describe('course archive preview (AP-038C2D)', () => {
  it('EN at 1440 px: from the course import page, an archive with PDF, DOCX and PPTX is previewed; nothing is created or stored', async () => {
    const rows = await databaseCounts();
    const files = await storedFiles();
    const page = await open('admin', 'en', 1440, '/admin/courses/import');
    assert.equal(await page.locator('#import-file').count(), 1, 'the JSON import is still offered');
    await page.locator('[data-archive-preview-link]').click();
    await page.waitForURL(new RegExp(`${PATH}$`));
    await settle(page);
    assert.equal(await page.locator('main h1').innerText(), EN.archive.title);
    await page.locator('[data-archive-draft-notice]').getByText(EN.archive.draftNotice).waitFor();
    let dialogs = 0;
    page.on('dialog', (dialog) => ((dialogs += 1), void dialog.dismiss()));
    const previews = countPreviews(page);

    await check(page, 'office-course.zip', archives.office);
    assert.equal(await status(page), 'valid_with_warnings');
    assert.equal(await page.locator('[data-archive-status-text]').innerText(), EN.archive.status.valid_with_warnings);
    await page.locator('[data-archive-not-imported]').getByText(EN.archive.notImported).waitFor();
    assert.equal(await focusedId(page), 'archive-result-heading', 'the result is announced by moving focus to it');

    // Authored metadata is plain text, as written: the markup in the title is neither rendered nor run.
    assert.equal(await field(page, 'title'), HTML_TITLE);
    assert.equal(await page.locator('[data-archive-report] img, [data-archive-report] b').count(), 0);
    assert.equal(await page.evaluate(() => (window as unknown as { __archiveXss?: number }).__archiveXss), undefined);
    assert.equal(dialogs, 0);
    assert.equal(await field(page, 'description'), 'Primera línea.\nSegunda línea.');
    assert.equal(await field(page, 'sourceCode'), 'ARC-V');
    assert.match(await field(page, 'exportedAt'), /November 19, 2026/);
    assert.equal(await field(page, 'format'), EN.archive.formatVersion(1));
    assert.equal(await field(page, 'file'), 'office-course.zip');

    // Content counts, supported and unsupported content.
    for (const [key, value] of [
      ['units', '1'],
      ['lessons', '1'],
      ['quizzes', '0'],
      ['assignments', '0'],
      ['documents', '3'],
      ['questions', '0'],
    ] as const) {
      assert.equal(await count(page, key), value, key);
    }
    assert.equal(await page.locator('[data-archive-other-type="scorm"]').innerText(), `${EN.types.scorm}: 1`);
    assert.equal(await page.locator('[data-archive-importable]').innerText(), EN.archive.importable(4));
    const skipped = await page.locator('[data-archive-skipped-item="activity-scorm"]').innerText();
    assert.ok(skipped.includes('SCORM lesson') && skipped.includes(EN.skippedReason.UNSUPPORTED_ACTIVITY_TYPE!), skipped);

    // The document inventory: one row per file, by format.
    for (const [format, n] of [
      ['pdf', 1],
      ['docx', 1],
      ['pptx', 1],
    ] as const) {
      assert.equal(await page.locator(`[data-archive-format="${format}"]`).innerText(), `${EN.archive.formats[format]}: ${n}`);
    }
    for (const [i, doc] of OFFICE.entries()) {
      const cells = await page
        .locator(`[data-archive-document="asset-${i + 1}"]`)
        .locator('th, td')
        .allInnerTexts();
      assert.deepEqual([cells[0], cells[1], cells[3]], [doc.name, EN.archive.formats[doc.format], EN.archive.usedBy(1)]);
    }

    // Warnings are described by their stable code.
    const notImportable = issue(page, 'ACTIVITY_NOT_IMPORTABLE');
    assert.equal(await notImportable.getAttribute('data-archive-severity'), 'warning');
    assert.ok((await notImportable.innerText()).includes(EN.archiveIssues.ACTIVITY_NOT_IMPORTABLE));
    assert.ok((await notImportable.innerText()).includes(EN.archive.where('activity-scorm')));
    assert.ok((await issue(page, 'PACKAGE_UNSUPPORTED_ACTIVITY_TYPE').innerText()).includes(EN.archiveIssues.PACKAGE_UNSUPPORTED_ACTIVITY_TYPE));

    // A preview only: no action imports, confirms or creates anything.
    // (The file picker's native input also has the button role; the actions are the <button> elements.)
    const actions = await page.locator('main [data-archive-form] button, main [data-archive-report] button').allInnerTexts();
    assert.deepEqual(actions.sort(), [EN.archive.another, EN.archive.check, EN.archive.clear].sort());
    assert.equal(await page.locator('main [data-archive-report]').getByRole('link').count(), 0);
    assert.equal(
      await page.evaluate(() => document.querySelectorAll('#archive-file').length && (document.querySelector('#archive-file') as HTMLInputElement).files?.length),
      0,
      'the file is released after the check',
    );
    assert.deepEqual(await leaks(page, 'en'), []);
    assert.ok((await overflow(page)) <= 0, '1440 px: no horizontal overflow');
    assert.equal(previews.sent, 1);
    await page.context().close();

    assert.deepEqual(await databaseCounts(), rows, 'no course, section, activity, document, summary or audit entry was created');
    assert.deepEqual(await storedFiles(), files, 'no document file was stored');
  });

  it('EN: the demo course archive from the ZIP export previews with the counts the API reports', async () => {
    const expected = await validateCourseArchive(archives.demo);
    assert.notEqual(expected.status, 'invalid', JSON.stringify(expected.issues));
    const page = await open('admin');
    await check(page, 'ITIL4-F-2026-2-A.academiapath.zip', archives.demo);
    assert.equal(await status(page), expected.status);
    const p = expected.preview!;
    const byType = p.counts.activitiesByType;
    for (const [key, value] of [
      ['units', p.counts.units],
      ['lessons', byType.page ?? 0],
      ['quizzes', byType.quiz ?? 0],
      ['assignments', byType.assignment ?? 0],
      ['documents', p.documents.length],
      ['questions', p.counts.questions],
    ] as const) {
      assert.equal(await count(page, key), new Intl.NumberFormat('en').format(value), key);
    }
    assert.equal(await field(page, 'title'), p.title);
    assert.equal(await page.locator('[data-archive-document]').count(), p.documents.length);
    assert.equal(await page.locator('[data-archive-issue]').count(), expected.issues.length);
    await page.context().close();
  });

  it('EN: an empty course, and corrupt, unsupported-version and damaged archives explained by code', async () => {
    const page = await open('admin');
    await check(page, 'empty-course.zip', archives.empty);
    assert.equal(await status(page), 'valid');
    for (const key of ['lessons', 'quizzes', 'assignments', 'documents', 'questions']) assert.equal(await count(page, key), '0', key);
    assert.equal(await count(page, 'units'), '1');
    await page.locator('[data-archive-documents]').getByText(EN.archive.documentsEmpty).waitFor();
    await page.locator('[data-archive-support]').getByText(EN.archive.allImportable).waitFor();
    await page.getByText(EN.archive.noIssues).waitFor();

    await page.getByRole('button', { name: EN.archive.another }).click();
    assert.equal(await page.locator('[data-archive-report]').count(), 0);
    assert.equal(await focusedId(page), 'archive-file', 'focus returns to the file picker');

    await check(page, 'corrupt.zip', archives.corrupt);
    assert.equal(await status(page), 'invalid');
    assert.equal(await page.locator('[data-archive-status-text]').innerText(), EN.archive.status.invalid);
    assert.equal(await issue(page, 'ARCHIVE_INVALID').getAttribute('data-archive-severity'), 'error');
    assert.ok((await issue(page, 'ARCHIVE_INVALID').innerText()).includes(EN.archiveIssues.ARCHIVE_INVALID));
    assert.equal(await field(page, 'format'), EN.archive.formatUnknown);
    assert.equal(await page.locator('[data-archive-documents], [data-archive-support], [data-archive-count]').count(), 0, 'no course preview for an invalid archive');

    await check(page, 'future-version.zip', archives.version);
    assert.equal(await status(page), 'invalid');
    assert.ok((await issue(page, 'VERSION_UNSUPPORTED').innerText()).includes(EN.archiveIssues.VERSION_UNSUPPORTED));
    assert.ok((await issue(page, 'VERSION_UNSUPPORTED').innerText()).includes(EN.archive.where(ARCHIVE_MANIFEST_PATH)));

    await check(page, 'damaged.zip', archives.damaged);
    assert.equal(await status(page), 'invalid');
    const checksum = await issue(page, 'ASSET_INTEGRITY').innerText();
    assert.ok(checksum.includes(EN.archiveIssues.ASSET_INTEGRITY) && checksum.includes(EN.archive.where('assets/asset-1.pdf')), checksum);
    const missing = await issue(page, 'ASSET_MISSING').innerText();
    assert.ok(missing.includes(EN.archiveIssues.ASSET_MISSING) && missing.includes(EN.archive.where('assets/asset-2.docx')), missing);
    assert.equal(await page.locator('[data-archive-issue-counts]').innerText(), EN.archive.issueCounts(2, 0));
    assert.deepEqual(await leaks(page, 'en'), []);
    await page.context().close();
  });

  it('files over 25 MB, other file types and empty files are refused in the browser before anything is sent', async () => {
    const page = await open('admin');
    const previews = countPreviews(page);
    const form = page.locator('[data-archive-form]');
    await page.getByRole('button', { name: EN.archive.check, exact: true }).click();
    await form.getByText(EN.archive.chooseFile).waitFor();
    const cases: Array<[string, Buffer, string]> = [
      ['too-large.zip', Buffer.alloc(25 * 1024 * 1024 + 1), EN.archive.tooLarge],
      ['course.academiapath.json', Buffer.from('{}'), EN.archive.onlyZip],
      ['empty.zip', Buffer.alloc(0), EN.archive.emptyFile],
    ];
    for (const [name, buffer, message] of cases) {
      await page.setInputFiles('#archive-file', { name, mimeType: 'application/zip', buffer });
      await page.getByRole('button', { name: EN.archive.check, exact: true }).click();
      await form.getByText(message).waitFor();
      assert.equal(await page.locator('#archive-file').getAttribute('aria-invalid'), 'true', name);
    }
    assert.equal(previews.sent, 0, 'nothing was uploaded');
    await page.context().close();
    // The API keeps its own limit (through the web proxy) for a client that skips the browser's check.
    const direct = await apiPreview('admin', Buffer.alloc(25 * 1024 * 1024 + 1));
    assert.deepEqual([direct.status, direct.body?.code], [413, 'PAYLOAD_TOO_LARGE']);
  });

  it('students and non-editing instructors get no form and no link, and the API refuses them', async () => {
    for (const role of ['student', 'ta'] as const) {
      const page = await open(role);
      await page.getByText(MESSAGES.en.session.restricted).waitFor();
      assert.equal(await page.locator('#archive-file').count(), 0, role);
      await page.goto(`${BASE}/admin/courses/import`);
      await settle(page);
      assert.equal(await page.locator('[data-archive-preview-link]').count(), 0, role);
      await page.context().close();
      const refused = await apiPreview(role, archives.empty);
      assert.deepEqual([refused.status, refused.body?.code], [403, 'FORBIDDEN'], role);
    }
    const anonymous = await apiPreview(null, archives.empty);
    assert.equal(anonymous.status, 401);
  });

  it('ES at 390 px: the report is in Spanish, authored text unchanged; it switches language without sending the archive again', async () => {
    const page = await open('admin', 'es', 390);
    const previews = countPreviews(page);
    assert.equal(await page.locator('main h1').innerText(), ES.archive.title);
    await check(page, 'un-nombre-de-archivo-bastante-largo-para-pantallas-pequenas-de-curso.zip', archives.office, ES);
    assert.equal(await page.locator('[data-archive-status-text]').innerText(), ES.archive.status.valid_with_warnings);
    assert.equal(await field(page, 'title'), HTML_TITLE, 'authored content is not translated');
    assert.equal(await field(page, 'format'), ES.archive.formatVersion(1));
    assert.match(await field(page, 'exportedAt'), /19 de noviembre de 2026/);
    assert.equal(await page.locator('[data-archive-format="docx"]').innerText(), `${ES.archive.formats.docx}: 1`);
    assert.ok((await issue(page, 'ACTIVITY_NOT_IMPORTABLE').innerText()).includes(ES.archiveIssues.ACTIVITY_NOT_IMPORTABLE));
    await page.locator('[data-archive-not-imported]').getByText(ES.archive.notImported).waitFor();
    assert.deepEqual(await leaks(page, 'es'), []);

    // 390 px: the long report and file name fit the screen.
    assert.ok((await overflow(page)) <= 0, `390 px: horizontal overflow of ${await overflow(page)} px`);
    for (const locator of [page.locator('[data-archive-documents] table').locator('xpath=..'), page.locator('[data-archive-issue]').first(), page.getByRole('button', { name: ES.archive.another })]) {
      const box = (await locator.boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= 390.5, '390 px: element inside the screen');
    }

    await switchLocale(page, 'en');
    assert.equal(await page.locator('main h1').innerText(), EN.archive.title);
    assert.equal(await page.locator('[data-archive-status-text]').innerText(), EN.archive.status.valid_with_warnings);
    assert.ok((await issue(page, 'ACTIVITY_NOT_IMPORTABLE').innerText()).includes(EN.archiveIssues.ACTIVITY_NOT_IMPORTABLE));
    assert.match(await field(page, 'exportedAt'), /November 19, 2026/);
    assert.deepEqual(await leaks(page, 'en'), []);
    await switchLocale(page, 'es');
    assert.equal(await page.locator('[data-archive-status-text]').innerText(), ES.archive.status.valid_with_warnings);
    assert.equal(previews.sent, 1, 'switching re-renders the report; the archive is not sent again');
    await page.context().close();
  });

  it('errors on screen switch language: a refused file, a busy server and a rate-limit refusal', async () => {
    const page = await open('admin');
    const form = page.locator('[data-archive-form]');
    await page.setInputFiles('#archive-file', { name: 'too-large.zip', mimeType: 'application/zip', buffer: Buffer.alloc(25 * 1024 * 1024 + 1) });
    await page.getByRole('button', { name: EN.archive.check, exact: true }).click();
    await form.getByText(EN.archive.tooLarge).waitFor();
    await switchLocale(page, 'es');
    await form.getByText(ES.archive.tooLarge).waitFor();
    assert.equal(await form.getByText(EN.archive.tooLarge).count(), 0);
    await switchLocale(page, 'en');

    // Answered by the browser, so the real per-administrator limits are not spent (the API suite covers them).
    const cases = [
      {
        status: 503,
        code: 'ARCHIVE_PREVIEW_BUSY',
        en: MESSAGES.en.errors.codes.ARCHIVE_PREVIEW_BUSY!,
        es: MESSAGES.es.errors.codes.ARCHIVE_PREVIEW_BUSY!,
        detail: 'Other course archives are being checked. Try again in a minute.',
      },
      { status: 429, code: 'RATE_LIMITED', en: EN.archive.rateLimited, es: ES.archive.rateLimited, detail: 'Too many attempts. Try again later.' },
    ];
    for (const { status: code, code: name, en, es, detail } of cases) {
      await page.route(`**${PREVIEW_URL}`, (route) =>
        route.fulfill({ status: code, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: name, status: code, code: name, detail }) }),
      );
      await page.setInputFiles('#archive-file', { name: 'course.zip', mimeType: 'application/zip', buffer: archives.empty });
      await page.getByRole('button', { name: EN.archive.check, exact: true }).click();
      const alert = form.locator('[role="alert"]');
      await alert.getByText(code === 503 ? detail : en).waitFor();
      await switchLocale(page, 'es');
      await alert.getByText(es).waitFor();
      assert.deepEqual(await leaks(page, 'es'), []);
      await switchLocale(page, 'en');
      await page.unroute(`**${PREVIEW_URL}`);
    }
    await page.context().close();
  });

  it('keyboard only: choose the file, check it, read the result and start again', async () => {
    const page = await open('admin');
    for (let n = 0; n < 40 && (await focusedId(page)) !== 'archive-file'; n += 1) await page.keyboard.press('Tab');
    assert.equal(await focusedId(page), 'archive-file', 'the file picker is reachable with Tab');
    // Playwright starts intercepting file choosers asynchronously once it waits for one; a round trip to the page makes
    // sure that is in effect before the key is pressed (otherwise Chromium may open its own, invisible dialog instead).
    const opened = page.waitForEvent('filechooser');
    await page.evaluate(() => undefined);
    await page.keyboard.press('Space');
    const chooser = await opened;
    await chooser.setFiles({ name: 'keyboard.zip', mimeType: 'application/zip', buffer: archives.empty });
    await page.keyboard.press('Tab');
    assert.equal(await focusedText(page), EN.archive.check);
    await page.keyboard.press('Enter');
    await page.locator('[data-archive-report]').waitFor({ timeout: 30_000 });
    assert.equal(await focusedId(page), 'archive-result-heading', 'focus moves to the result');
    for (let n = 0; n < 40 && (await focusedText(page)) !== EN.archive.another; n += 1) await page.keyboard.press('Tab');
    assert.equal(await focusedText(page), EN.archive.another);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-archive-report]').count(), 0);
    assert.equal(await focusedId(page), 'archive-file', 'focus returns to the file picker');
    await page.context().close();
  });
});
