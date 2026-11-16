/**
 * AP-038B course import in the browser, run through e2e/run.sh against the production build and the synthetic demo seed.
 * A demo course is exported (AP-038A) and imported back as new draft courses by the administrator in English and in
 * Spanish, at 390, 820 and 1440 px, with the clear refusals for a changed file, a file that is not JSON, a missing
 * acknowledgement and a taken course code. Other roles cannot reach the import. Only new draft courses without
 * enrollments are created, so the demo users' dashboards are unchanged.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { API, apiGet, BASE, context, launch, leaks, MESSAGES, session, settle, type Locale, type Role } from './support.ts';

const SOURCE = 'ITIL4-F-2026-2-A';
let browser: Browser;
let dir = '';
const files = { valid: '', changed: '', notJson: '' };

before(async () => {
  browser = await launch();
  dir = await mkdtemp(join(tmpdir(), 'ap-import-e2e-'));
  const courseId = (await apiGet<{ items: Array<{ id: string; code: string }> }>('instructor', '/courses?limit=100')).items.find((c) => c.code === SOURCE)!.id;
  const signedIn = await session('instructor');
  const res = await fetch(`${API}/courses/${courseId}/export`, { headers: { cookie: signedIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
  assert.equal(res.status, 200);
  const text = await res.text();
  files.valid = join(dir, `course-${SOURCE}.academiapath.json`);
  await writeFile(files.valid, text);
  const changed = JSON.parse(text) as { course: { title: string } };
  changed.course.title = `${changed.course.title} (edited)`;
  files.changed = join(dir, 'changed.academiapath.json');
  await writeFile(files.changed, JSON.stringify(changed));
  files.notJson = join(dir, 'notes.json');
  await writeFile(files.notJson, 'this is not a course package');
});
after(async () => {
  await browser?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function open(locale: Locale, width: number, role: Role = 'admin'): Promise<Page> {
  const ctx = await context(browser, locale, role, { width });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/courses/import`);
  await settle(page);
  return page;
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function previewOf(page: Page, file: string) {
  await page.locator('#import-file').setInputFiles(file);
  await page.locator('[data-import-preview]').waitFor();
}

describe('course import (AP-038B)', () => {
  for (const [locale, width, code] of [['en', 1440, 'IMP-E2E-EN'], ['es', 390, 'IMP-E2E-ES']] as const) {
    it(`${locale.toUpperCase()} at ${width} px: preview, choose the context, acknowledge what is skipped and import a new draft course`, async () => {
      const c = MESSAGES[locale].courseImport;
      const ctx = await context(browser, locale, 'admin', { width });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/admin/courses`);
      await settle(page);
      await page.getByRole('link', { name: c.action }).click();
      await page.waitForURL('**/admin/courses/import');
      await settle(page);
      await previewOf(page, files.valid);
      const preview = page.locator('[data-import-preview]');
      assert.equal(await preview.getAttribute('data-import-valid'), 'true');
      await preview.getByText(c.validTitle).waitFor();
      await preview.getByText(c.hashVerified).waitFor();
      assert.ok(await page.locator('[data-import-documents]').isVisible(), 'the demo course document is listed');
      assert.ok(await page.locator('[data-import-skipped]').getByText(c.skippedReason.DOCUMENT_NOT_BUNDLED!).first().isVisible());

      const programs = (await apiGet<{ items: Array<{ id: string; isActive: boolean }> }>('admin', '/programs?limit=100')).items.filter((p) => p.isActive);
      const terms = (await apiGet<{ items: Array<{ id: string }> }>('admin', '/terms?limit=100')).items;
      await page.getByLabel(c.program).selectOption(programs[0]!.id);
      await page.getByLabel(c.term).selectOption(terms[0]!.id);
      await page.getByLabel(c.code).fill(code);
      assert.ok((await page.getByLabel(c.courseTitle).inputValue()).length > 0, 'the source title is suggested');
      assert.ok((await page.getByLabel(c.dueDate).inputValue()).length > 0, 'a due date is suggested from the term');
      // Without the acknowledgement the import does not start.
      await page.getByRole('button', { name: c.confirm }).click();
      await page.getByText(c.required.acknowledge).waitFor();
      await page.getByLabel(c.acknowledge(await page.locator('[data-import-skipped] li').count())).check();
      assert.ok((await overflow(page)) <= 0, `${locale} ${width}: no horizontal scrolling`);
      assert.deepEqual(await leaks(page, locale), []);
      await page.getByRole('button', { name: c.confirm }).click();
      const result = page.locator(`[data-import-result="${code}"]`);
      await result.getByText(c.success(code)).waitFor();
      await result.getByText(c.nextSteps).waitFor();
      assert.ok((await overflow(page)) <= 0, `${locale} ${width}: result fits`);
      await result.getByRole('link', { name: c.openCourse }).click();
      await page.waitForURL(/\/courses\/[0-9a-f-]{36}$/);
      await settle(page);
      await page.locator('main h1').waitFor();
      const created = (await apiGet<{ items: Array<{ code: string; status: string }> }>('admin', '/courses?limit=100')).items.find((item) => item.code === code)!;
      assert.equal(created.status, 'draft');
      await ctx.close();
    });
  }

  it('ES at 820 px: a changed file, a file that is not JSON and a taken code are refused with clear Spanish messages', async () => {
    const c = MESSAGES.es.courseImport;
    const page = await open('es', 820);
    await previewOf(page, files.changed);
    assert.equal(await page.locator('[data-import-preview]').getAttribute('data-import-valid'), 'false');
    await page.getByText(c.invalidTitle).waitFor();
    await page.locator('[data-import-error="HASH_MISMATCH"]').waitFor();
    assert.equal(await page.locator('[data-import-form]').count(), 0, 'no import form for an invalid package');
    assert.ok((await overflow(page)) <= 0, 'es 820: no horizontal scrolling');

    await page.locator('#import-file').setInputFiles(files.notJson);
    await page.getByText(c.notJson).waitFor();
    assert.equal(await page.locator('[data-import-preview]').count(), 0);

    await previewOf(page, files.valid);
    const programs = (await apiGet<{ items: Array<{ id: string; isActive: boolean }> }>('admin', '/programs?limit=100')).items.filter((p) => p.isActive);
    const terms = (await apiGet<{ items: Array<{ id: string }> }>('admin', '/terms?limit=100')).items;
    await page.getByLabel(c.program).selectOption(programs[0]!.id);
    await page.getByLabel(c.term).selectOption(terms[0]!.id);
    await page.getByLabel(c.code).fill('IMP-E2E-EN');
    await page.getByLabel(c.acknowledge(await page.locator('[data-import-skipped] li').count())).check();
    await page.getByRole('button', { name: c.confirm }).click();
    await page.getByText(MESSAGES.es.errors.codes.COURSE_CODE_TAKEN!).waitFor();
    assert.ok((await overflow(page)) <= 0, 'es 820: form fits');
    assert.deepEqual(await leaks(page, 'es'), []);
    await page.context().close();
  });

  it('only administrators can import: authors and students see the restriction and the API refuses them', async () => {
    for (const role of ['instructor', 'reviewer', 'student'] as const) {
      const page = await open('en', 1440, role);
      await page.getByText(MESSAGES.en.session.restricted).waitFor();
      assert.equal(await page.locator('#import-file').count(), 0, role);
      await page.context().close();
      const signedIn = await session(role);
      const res = await fetch(`${API}/course-imports/preview`, {
        method: 'POST',
        headers: { cookie: signedIn.cookies.map((c) => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': signedIn.csrfToken, origin: BASE, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 403, role);
    }
  });
});
