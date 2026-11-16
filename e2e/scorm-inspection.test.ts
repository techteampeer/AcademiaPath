/**
 * AP-033B SCORM package inspection in the browser (run through e2e/run.sh against the production build and the demo
 * seed). Synthetic packages generated in code are inspected through the real web proxy: the report in English and
 * Spanish, errors and warnings, who may inspect, no import or publish action, layouts at 390, 820 and 1440 px, and a
 * 20 MB package (above the old 12 MB proxy body limit). Nothing is imported, stored or executed.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { largeValidPackage, SCORM_FIXTURES } from '../apps/api/test/helpers/scorm.ts';
import { apiGet, BASE, context, launch, leaks, MESSAGES, settle, type Locale, type Role } from './support.ts';

const EN = MESSAGES.en.scorm;
const ES = MESSAGES.es.scorm;
let browser: Browser;
let courseId: string;

async function open(role: Role, path: string, locale: Locale = 'en', width = 1440): Promise<Page> {
  const page = await (await context(browser, locale, role, { width })).newPage();
  await page.goto(`${BASE}${path}`);
  await settle(page);
  return page;
}
const inspectionPath = () => `/courses/${courseId}/scorm-inspection`;

async function inspect(page: Page, name: string, buffer: Buffer, label: string) {
  await page.setInputFiles('#scorm-file', { name, mimeType: 'application/zip', buffer });
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.locator('[data-scorm-report]').waitFor({ timeout: 30_000 });
}
const field = (page: Page, key: string) => page.locator(`[data-scorm-field="${key}"]`).innerText();

before(async () => {
  browser = await launch();
  courseId = (await apiGet<{ items: Array<{ id: string; code: string }> }>('instructor', '/courses?limit=100')).items.find((c) => c.code === 'ITIL4-F-2026-2-A')!.id;
});

after(async () => {
  await browser?.close();
});

describe('SCORM package inspection (browser)', () => {
  it('EN: an instructor opens it from the course documents, inspects a valid SCORM 1.2 package and sees its structure; nothing is imported', async () => {
    const page = await open('instructor', `/courses/${courseId}`);
    await page.locator('[data-scorm-inspection-link]').click();
    await page.waitForURL(new RegExp(`/courses/${courseId}/scorm-inspection$`));
    await settle(page);
    assert.equal(await page.locator('main h1').innerText(), EN.title);
    await page.getByText(EN.playbackNotice).waitFor();
    await inspect(page, 'pm-basics.zip', SCORM_FIXTURES.scorm12Multi(), EN.inspect);

    assert.equal(await page.locator('[data-scorm-report]').getAttribute('data-scorm-status'), 'valid');
    await page.getByText(EN.status.valid, { exact: true }).waitFor();
    await page.locator('[data-scorm-not-imported]').getByText(EN.notImported).waitFor();
    assert.equal(await field(page, 'standard'), `SCORM 1.2 (${EN.declared('1.2')})`);
    assert.equal(await field(page, 'title'), 'Project Management Basics');
    assert.equal(await field(page, 'file'), 'pm-basics.zip');
    assert.equal(await field(page, 'content'), EN.contentCounts(3, 1, 6));
    assert.equal(await field(page, 'playback'), EN.playback.planned);
    const launchable = await page.locator('[data-scorm-launchable]').allInnerTexts();
    assert.equal(launchable.length, 3);
    assert.match(launchable[1]!, /Lesson 2: Stakeholders[\s\S]*lessons\/lesson2\.html\?section=2/);
    await page.getByText(EN.noIssues).waitFor();
    // A dry run only: no action imports, uploads into the course or publishes the package.
    for (const role of ['button', 'link'] as const) {
      const names = await page.getByRole(role).allInnerTexts();
      assert.ok(!names.some((name) => /import|publish|upload|add to course/i.test(name)), `${role}: ${names.join(' | ')}`);
    }
    assert.deepEqual(await leaks(page, 'en'), []);
    await page.context().close();
  });

  it('EN: an unsafe package is explained issue by issue, and another package can be inspected', async () => {
    const page = await open('instructor', inspectionPath());
    await inspect(page, 'traversal.zip', SCORM_FIXTURES.pathTraversal(), EN.inspect);
    assert.equal(await page.locator('[data-scorm-report]').getAttribute('data-scorm-status'), 'invalid');
    await page.getByText(EN.status.invalid, { exact: true }).waitFor();
    const issue = page.locator('[data-scorm-issue="SCORM_PATH_TRAVERSAL"]');
    assert.equal(await issue.getAttribute('data-scorm-severity'), 'error');
    assert.match(await issue.innerText(), new RegExp(`${EN.issues.SCORM_PATH_TRAVERSAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*${EN.where.path('../../evil.html').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(await field(page, 'playback'), EN.playback.not_supported);
    await page.getByRole('button', { name: EN.another }).click();
    assert.equal(await page.locator('[data-scorm-report]').count(), 0);
    // A non-ZIP file is refused before anything is uploaded.
    await page.setInputFiles('#scorm-file', { name: 'course.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') });
    await page.getByRole('button', { name: EN.inspect, exact: true }).click();
    await page.getByText(EN.onlyZip).waitFor();
    // A Canvas course export is recognised as Common Cartridge, not SCORM.
    await inspect(page, 'canvas-export.imscc.zip', SCORM_FIXTURES.commonCartridge(), EN.inspect);
    await page.getByText(EN.commonCartridgeHint).waitFor();
    await page.context().close();
  });

  it('ES: a SCORM 2004 package with sequencing shows a Spanish report with its warning', async () => {
    const page = await open('instructor', inspectionPath(), 'es');
    assert.equal(await page.locator('main h1').innerText(), ES.title);
    await inspect(page, 'etica-de-datos.zip', SCORM_FIXTURES.scorm2004Sequencing(), ES.inspect);
    await page.getByText(ES.status.valid_with_warnings, { exact: true }).waitFor();
    assert.equal(await field(page, 'standard'), `SCORM 2004 · ${ES.editions['4th']} (${ES.declared('2004 4th Edition')})`);
    assert.equal(await field(page, 'playback'), ES.playback.planned_without_sequencing);
    const warning = page.locator('[data-scorm-issue="SCORM_SEQUENCING_IGNORED"]');
    assert.equal(await warning.getAttribute('data-scorm-severity'), 'warning');
    assert.match(await warning.innerText(), new RegExp(ES.warning));
    assert.ok((await warning.innerText()).includes(ES.issues.SCORM_SEQUENCING_IGNORED));
    await page.locator('[data-scorm-not-imported]').getByText(ES.notImported).waitFor();
    assert.deepEqual(await leaks(page, 'es'), []);
    await page.context().close();
  });

  it('students and non-editing instructors see no link and cannot use the page', async () => {
    for (const role of ['student', 'ta'] as const) {
      const course = await open(role, `/courses/${courseId}`);
      assert.equal(await course.locator('[data-scorm-inspection-link]').count(), 0, role);
      await course.context().close();
      const page = await open(role, inspectionPath());
      await page.getByText(EN.forbidden).waitFor();
      assert.equal(await page.locator('#scorm-file').count(), 0, role);
      await page.context().close();
    }
  });

  it('layouts at 390, 820 and 1440 px fit the screen with a long report', async () => {
    for (const width of [390, 820, 1440]) {
      const page = await open('instructor', inspectionPath(), width === 820 ? 'es' : 'en', width);
      const labels = width === 820 ? ES : EN;
      await inspect(page, 'pm-basics-with-a-rather-long-file-name-for-small-screens.zip', SCORM_FIXTURES.scorm12Warnings(), labels.inspect);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${width} px: horizontal overflow of ${overflow} px`);
      for (const locator of [page.locator('[data-scorm-launchable]').first(), page.locator('[data-scorm-issue]').first(), page.getByRole('button', { name: labels.another })]) {
        const box = (await locator.boundingBox())!;
        assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `${width} px: element inside the screen`);
      }
      await page.context().close();
    }
  });

  it('a 20 MB package passes through the web proxy unchanged and is inspected in full', async () => {
    const page = await open('instructor', inspectionPath());
    const bytes = largeValidPackage(20);
    await inspect(page, 'video-course.zip', bytes, EN.inspect);
    assert.equal(await page.locator('[data-scorm-report]').getAttribute('data-scorm-status'), 'valid');
    assert.match(await field(page, 'size'), /^2[01](\.\d)? MB compressed/);
    await page.context().close();
  });
});
