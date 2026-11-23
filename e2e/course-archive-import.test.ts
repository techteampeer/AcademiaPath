/**
 * AP-038C2F archive import confirmation in the browser (run through e2e/run.sh, whose disposable local API runs with
 * ARCHIVE_IMPORT_ENABLED=true; production refuses that setting). Synthetic archives from the real exporter are checked,
 * configured, reviewed and imported as NEW draft courses through the real web proxy and API.
 *
 * A dedicated administrator is created in this run's database for this file, so its preview and import rate limits are
 * its own (the demo administrator's are used by other files). Courses created here use ZZ- codes, are drafts and have
 * no enrollments, so no other suite or demo dashboard sees them. The feature-disabled view is shown by answering the
 * availability request in the browser; the API suite covers the server's own refusal.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { hashPassword } from '../apps/api/src/auth/password.ts';
import { dataOf, exported, OFFICE, replace, tampered } from '../apps/api/test/helpers/archives.ts';
import { API, apiGet, BASE, launch, leaks, MESSAGES, session, settle, switchLocale, type Locale } from './support.ts';

const EN = MESSAGES.en.courseImport;
const ES = MESSAGES.es.courseImport;
const PATH = '/admin/courses/import/archive';
const IMPORT_URL = '/api/v1/course-imports/archive';
const AVAILABILITY_URL = '/api/v1/course-imports/archive/availability';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let browser: Browser;
let importer: { cookies: Array<{ name: string; value: string }>; csrfToken: string };
let program: { id: string; code: string; name: string };
let term: { id: string; code: string; name: string; endsOn: string };

async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const pg = ((await import(process.env.PG_MODULE!)) as { default: typeof import('pg') }).default;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}
const coursesWithCode = async (code: string) => Number((await sql<{ n: string }>('SELECT count(*) AS n FROM courses WHERE code = $1', [code]))[0]!.n);
const storedFiles = async () => (await readdir(process.env.DOCUMENT_STORAGE_DIR!, { recursive: true }).catch(() => [] as string[])).length;

/** A browser page signed in as this file's administrator (or as a demo role), in the given language and width. */
async function open(locale: Locale = 'en', width = 1440, role?: 'student' | 'ta'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const cookies = role ? (await session(role)).cookies : importer.cookies;
  await ctx.addCookies([{ name: 'ap_locale', value: locale }, ...cookies].map((cookie) => ({ ...cookie, url: BASE })));
  const page = await ctx.newPage();
  await page.goto(`${BASE}${PATH}`);
  await settle(page);
  return page;
}
function countImports(page: Page) {
  const counter = { sent: 0 };
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === IMPORT_URL) counter.sent += 1;
  });
  return counter;
}
async function check(page: Page, buffer: Buffer, labels = EN) {
  await page.setInputFiles('#archive-file', { name: 'course-archive.zip', mimeType: 'application/zip', buffer });
  await page.getByRole('button', { name: labels.archive.check, exact: true }).click();
  await page.locator('[data-archive-report]').waitFor({ timeout: 30_000 });
}
const importState = (page: Page) => page.locator('[data-archive-import]').getAttribute('data-archive-import');
async function waitForForm(page: Page) {
  await page.locator('[data-archive-import="form"]').waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => (document.querySelector('#archive-import-program') as HTMLSelectElement | null)?.options.length! > 1);
}
async function fill(page: Page, code: string, labels = EN) {
  await waitForForm(page);
  await page.selectOption('#archive-import-program', program.id);
  await page.selectOption('#archive-import-term', term.id);
  await page.fill('#archive-import-code', code);
  await page.getByLabel(labels.archive.import.confirmNew).check();
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const focusedText = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText?.trim() ?? '');
const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? '');

before(async () => {
  assert.ok(process.env.DATABASE_URL && process.env.PG_MODULE && process.env.DOCUMENT_STORAGE_DIR, 'run through e2e/run.sh');
  browser = await launch();
  // This file's own administrator (synthetic; the password is random and never printed).
  const email = 'e2e-archive-importer@academiapath.example';
  const password = randomBytes(18).toString('base64url');
  const [user] = await sql<{ id: string }>(`INSERT INTO users (email, given_name, family_name, system_role) VALUES ($1, 'E2E', 'Importer', 'administrator') RETURNING id`, [email]);
  await sql('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [user!.id, await hashPassword(password)]);
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200);
  importer = {
    csrfToken: ((await res.json()) as { csrfToken: string }).csrfToken,
    cookies: res.headers.getSetCookie().map((cookie) => {
      const pair = cookie.split(';')[0]!;
      return { name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1) };
    }),
  };
  program = (await apiGet<{ items: Array<{ id: string; code: string; name: string; isActive: boolean }> }>('admin', '/programs?limit=100')).items.find((item) => item.isActive)!;
  term = (await apiGet<{ items: Array<{ id: string; code: string; name: string; endsOn: string }> }>('admin', '/terms?limit=100')).items[0]!;
});

after(async () => {
  await browser?.close();
});

describe('course archive import confirmation (AP-038C2F)', () => {
  it('feature off: a localized explanation, no import action, and nothing is sent', async () => {
    const page = await open();
    const imports = countImports(page);
    await page.route(`**${AVAILABILITY_URL}`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false }) }));
    await check(page, await exported());
    assert.equal(await importState(page), 'unavailable');
    await page.locator('[data-archive-import-unavailable]').getByText(EN.archive.import.unavailable).waitFor();
    for (const name of [EN.archive.import.review, EN.archive.import.confirm]) assert.equal(await page.getByRole('button', { name }).count(), 0, name);
    assert.equal(await page.locator('[data-archive-import-form], #archive-import-code').count(), 0);
    await switchLocale(page, 'es');
    await page.locator('[data-archive-import-unavailable]').getByText(ES.archive.import.unavailable).waitFor();
    assert.deepEqual(await leaks(page, 'es'), []);
    assert.equal(imports.sent, 0, 'no import request');
    await page.context().close();
  });

  it('EN at 1440 px: configure, review and import PDF, DOCX and PPTX into a NEW draft course; one click, one request', async () => {
    const page = await open();
    const imports = countImports(page);
    const files = await storedFiles();
    await check(page, await exported());
    await fill(page, 'ZZ-ARC-UI-1');
    assert.equal(await page.inputValue('#archive-import-title'), 'Archive validation fixture', 'the archived title is suggested');
    await page.fill('#archive-import-title', 'Imported through the interface');
    await page.getByRole('button', { name: EN.archive.import.review, exact: true }).click();
    await page.locator('[data-archive-import="review"]').waitFor();
    assert.equal(await focusedId(page), 'archive-import-review-heading');
    const field = (key: string) => page.locator(`[data-archive-import-field="${key}"]`).innerText();
    assert.deepEqual(
      [await field('program'), await field('term'), await field('code'), await field('title'), await field('version')],
      [`${program.code} · ${program.name}`, `${term.code} · ${term.name}`, 'ZZ-ARC-UI-1', 'Imported through the interface', EN.approvedVersion],
    );
    assert.equal(await page.locator('[data-archive-import-content]').innerText(), EN.archive.import.contentSummary(1, 4, 3));
    assert.equal(imports.sent, 0, 'nothing is sent before the explicit confirmation');
    assert.ok((await overflow(page)) <= 0, '1440 px review fits');

    // A double click still sends one request.
    await page.locator('[data-archive-import-confirm]').dblclick();
    await page.locator('[data-archive-import="done"]').waitFor({ timeout: 60_000 });
    assert.equal(imports.sent, 1);
    await page.getByText(EN.success('ZZ-ARC-UI-1')).waitFor();
    await page.getByText(EN.archive.import.documentsCreated(3)).waitFor();
    const [course] = await sql<{ id: string; status: string; title: string }>('SELECT id, status, title FROM courses WHERE code = $1', ['ZZ-ARC-UI-1']);
    assert.deepEqual([course!.status, course!.title], ['draft', 'Imported through the interface']);
    const documents = await sql<{ sha256: string; malware_scan_status: string }>(
      'SELECT d.sha256, d.malware_scan_status FROM course_documents d JOIN activities a ON a.id = d.activity_id JOIN sections s ON s.id = a.section_id WHERE s.course_id = $1',
      [course!.id],
    );
    assert.deepEqual(documents.map((d) => d.sha256).sort(), OFFICE.map((doc) => sha256(doc.bytes)).sort(), 'PDF, DOCX and PPTX restored byte for byte');
    assert.ok(documents.every((d) => d.malware_scan_status === 'not_scanned'));
    assert.equal(await storedFiles(), files + 3);
    assert.equal(await page.locator('[data-archive-import-open]').getAttribute('href'), `/courses/${course!.id}`);
    assert.doesNotMatch(await page.locator('main').innerText(), /storage|stack|\/srv\//i);
    assert.deepEqual(await leaks(page, 'en'), []);
    await page.locator('[data-archive-import-open]').click();
    await page.waitForURL(new RegExp(`/courses/${course!.id}$`));
    await settle(page);
    assert.match(await page.locator('main h1').innerText(), /Imported through the interface/);
    await page.context().close();
  });

  it('a repeated confirmation with a code already used is refused on the code field; no second course, no files kept', async () => {
    const page = await open();
    await check(page, await exported());
    await fill(page, 'ZZ-ARC-UI-1');
    await page.getByRole('button', { name: EN.archive.import.review, exact: true }).click();
    const files = await storedFiles();
    await page.locator('[data-archive-import-confirm]').click();
    await page.locator('[data-archive-import="form"]').waitFor({ timeout: 60_000 });
    await page.getByText(EN.archive.import.codeTaken).waitFor();
    assert.equal(await page.locator('#archive-import-code').getAttribute('aria-invalid'), 'true');
    assert.equal(await coursesWithCode('ZZ-ARC-UI-1'), 1, 'no second course');
    assert.equal(await storedFiles(), files, 'no file left by the refused import');
    await switchLocale(page, 'es');
    await page.getByText(ES.archive.import.codeTaken).waitFor();
    await page.context().close();
  });

  it('missing prerequisites are asked for before anything is sent, in the selected language', async () => {
    const page = await open();
    const imports = countImports(page);
    await check(page, await exported(OFFICE, { unsupported: true }));
    await waitForForm(page);
    await page.getByRole('button', { name: EN.archive.import.review, exact: true }).click();
    for (const message of [EN.required.program, EN.required.term, EN.required.code, EN.required.acknowledge, EN.archive.import.required.confirmNew]) {
      await page.locator('[data-archive-import-form]').getByText(message).waitFor();
    }
    await switchLocale(page, 'es');
    for (const message of [ES.required.program, ES.required.acknowledge, ES.archive.import.required.confirmNew]) await page.locator('[data-archive-import-form]').getByText(message).waitFor();
    assert.deepEqual(await leaks(page, 'es'), []);
    assert.equal(imports.sent, 0);
    // Without an active program to import into, there is nothing to choose and no way to continue.
    await switchLocale(page, 'en');
    await page.route('**/api/v1/programs?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], nextCursor: null }) }));
    await page.getByRole('button', { name: EN.archive.another }).click();
    await check(page, await exported());
    await page.getByText(EN.archive.import.noPrograms).waitFor();
    assert.equal(await page.getByRole('button', { name: EN.archive.import.review, exact: true }).isDisabled(), true);
    assert.equal(imports.sent, 0);
    await page.context().close();
  });

  it('invalid and corrupted archives offer no import at all', async () => {
    const page = await open();
    await check(page, Buffer.from('this is not a zip archive'));
    assert.equal(await page.locator('[data-archive-report]').getAttribute('data-archive-status'), 'invalid');
    assert.equal(await page.locator('[data-archive-import]').count(), 0);
    const corrupted = await tampered((entries) => {
      const pdf = Buffer.from(dataOf(entries, 'assets/asset-1.pdf'));
      pdf[pdf.length - 1] = pdf[pdf.length - 1]! ^ 0xff;
      return replace(entries, 'assets/asset-1.pdf', pdf);
    });
    await check(page, corrupted);
    assert.equal(await page.locator('[data-archive-report]').getAttribute('data-archive-status'), 'invalid');
    assert.equal(await page.locator('[data-archive-import]').count(), 0);
    await page.context().close();
  });

  it('students and non-editing instructors cannot reach it, and the API refuses them', async () => {
    for (const role of ['student', 'ta'] as const) {
      const page = await open('en', 1440, role);
      await page.getByText(MESSAGES.en.session.restricted).waitFor();
      assert.equal(await page.locator('#archive-file, [data-archive-import]').count(), 0);
      await page.context().close();
      const { cookies, csrfToken } = await session(role);
      const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      assert.equal((await fetch(`${BASE}${AVAILABILITY_URL}`, { headers: { cookie } })).status, 403, role);
      const form = new FormData();
      form.append('programId', program.id);
      form.append('termId', term.id);
      form.append('code', 'ZZ-ARC-UI-ROLE');
      form.append('file', new Blob([new Uint8Array(await exported())], { type: 'application/zip' }), 'course.zip');
      const res = await fetch(`${BASE}${IMPORT_URL}`, { method: 'POST', headers: { cookie, origin: BASE, 'x-csrf-token': csrfToken }, body: form });
      assert.equal(res.status, 403, role);
    }
    assert.equal(await coursesWithCode('ZZ-ARC-UI-ROLE'), 0);
  });

  it('ES at 390 px: the flow in Spanish; a failed import is explained in the selected language and creates nothing', async () => {
    const page = await open('es', 390);
    await check(page, await exported(), ES);
    await fill(page, 'ZZ-ARC-UI-ES', ES);
    assert.ok((await overflow(page)) <= 0, '390 px form fits');
    await page.getByRole('button', { name: ES.archive.import.review, exact: true }).click();
    await page.locator('[data-archive-import="review"]').waitFor();
    assert.equal(await page.locator('[data-archive-import-content]').innerText(), ES.archive.import.contentSummary(1, 4, 3));
    assert.ok((await overflow(page)) <= 0, '390 px review fits');
    for (const locator of [page.locator('[data-archive-import-confirm]'), page.getByRole('button', { name: ES.archive.import.back })]) {
      const box = (await locator.boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= 390.5, '390 px: button inside the screen');
    }
    // The server's storage refusal (answered by the browser here; the API suite causes real ones).
    const detail = 'Document storage could not keep the archive’s files; nothing was created. Try again later.';
    await page.route(`**${IMPORT_URL}`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Service Unavailable', status: 503, code: 'ARCHIVE_IMPORT_STORAGE_FAILED', detail }),
      }),
    );
    await page.locator('[data-archive-import-confirm]').click();
    const alert = page.locator('[data-archive-import="review"] [role="alert"]');
    await alert.getByText(MESSAGES.es.errors.codes.ARCHIVE_IMPORT_STORAGE_FAILED!).waitFor();
    assert.equal(await importState(page), 'review', 'no success is shown');
    await switchLocale(page, 'en');
    await alert.getByText(detail).waitFor();
    await switchLocale(page, 'es');
    await alert.getByText(MESSAGES.es.errors.codes.ARCHIVE_IMPORT_STORAGE_FAILED!).waitFor();
    // The server switched import off meanwhile: the action disappears.
    await page.route(`**${IMPORT_URL}`, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Forbidden', status: 403, code: 'ARCHIVE_IMPORT_DISABLED', detail: 'off' }),
      }),
    );
    await page.locator('[data-archive-import-confirm]').click();
    await page.locator('[data-archive-import-unavailable]').getByText(ES.archive.import.unavailable).waitFor();
    assert.equal(await page.locator('[data-archive-import-confirm]').count(), 0);
    assert.deepEqual(await leaks(page, 'es'), []);
    assert.equal(await coursesWithCode('ZZ-ARC-UI-ES'), 0, 'no course from the failed attempts');
    await page.context().close();
  });

  it('keyboard only: configure, review and import, then reach the new course', async () => {
    const page = await open();
    await check(page, await exported([], { page: false }));
    await waitForForm(page);
    for (let n = 0; n < 40 && (await focusedId(page)) !== 'archive-import-program'; n += 1) await page.keyboard.press('Tab');
    assert.equal(await focusedId(page), 'archive-import-program');
    await page.keyboard.press('ArrowDown');
    assert.notEqual(await page.inputValue('#archive-import-program'), '', 'a program chosen with the keyboard');
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowDown');
    assert.notEqual(await page.inputValue('#archive-import-term'), '');
    await page.keyboard.press('Tab');
    await page.keyboard.type('ZZ-ARC-UI-KB');
    for (let n = 0; n < 10 && (await focusedId(page)) !== 'archive-import-confirm-new'; n += 1) await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    assert.equal(await page.isChecked('#archive-import-confirm-new'), true);
    await page.keyboard.press('Tab');
    assert.equal(await focusedText(page), EN.archive.import.review);
    await page.keyboard.press('Enter');
    await page.locator('[data-archive-import="review"]').waitFor();
    assert.equal(await focusedId(page), 'archive-import-review-heading');
    await page.keyboard.press('Tab');
    assert.equal(await focusedText(page), EN.archive.import.confirm);
    await page.keyboard.press('Enter');
    await page.locator('[data-archive-import="done"]').waitFor({ timeout: 60_000 });
    assert.equal(await focusedId(page), 'archive-import-done-heading');
    for (let n = 0; n < 10 && (await focusedText(page)) !== EN.openCourse; n += 1) await page.keyboard.press('Tab');
    assert.equal(await focusedText(page), EN.openCourse, 'the new course is reachable with Tab');
    assert.equal(await coursesWithCode('ZZ-ARC-UI-KB'), 1);
    await page.context().close();
  });
});
