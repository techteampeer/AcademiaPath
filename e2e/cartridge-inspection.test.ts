/**
 * AP-038D Common Cartridge inspection in the browser (run through e2e/run.sh against the production build and the demo
 * seed). Synthetic cartridges generated in code (no real or client-owned Canvas export) are inspected through the real
 * web proxy: the report in English and Spanish, the compatibility summary, warnings and errors, who may inspect, no
 * import or publish action, layouts at 390, 820 and 1440 px, and the AP-I18N-01 conventions (a report or error on
 * screen follows an EN/ES switch without the package being sent again). Nothing is imported, stored or executed, so the
 * demo course is only read.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { CARTRIDGE_FIXTURES } from '../apps/api/test/helpers/cartridge.ts';
import { apiGet, BASE, context, launch, leaks, MESSAGES, settle, type Locale, type Role } from './support.ts';

const EN = MESSAGES.en.cartridge;
const ES = MESSAGES.es.cartridge;
let browser: Browser;
let courseId: string;

async function open(role: Role, path: string, locale: Locale = 'en', width = 1440): Promise<Page> {
  const page = await (await context(browser, locale, role, { width })).newPage();
  await page.goto(`${BASE}${path}`);
  await settle(page);
  return page;
}
const inspectionPath = () => `/courses/${courseId}/cartridge-inspection`;

async function inspect(page: Page, name: string, buffer: Buffer, label: string) {
  await page.setInputFiles('#cartridge-file', { name, mimeType: 'application/zip', buffer });
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.locator('[data-cartridge-report]').waitFor({ timeout: 30_000 });
}
const field = (page: Page, key: string) => page.locator(`[data-cartridge-field="${key}"]`).innerText();
const status = (page: Page) => page.locator('[data-cartridge-report]').getAttribute('data-cartridge-status');
const compat = (page: Page, kind: string, support: string) => page.locator(`[data-cartridge-compat="${kind}"][data-support="${support}"]`);

/** Clicks EN or ES in the header and waits until the page has switched. */
async function switchTo(page: Page, locale: Locale) {
  await page.locator(`button[lang="${locale}"]:visible`).first().click();
  await page.waitForFunction((value) => document.documentElement.lang === value, locale);
  await page.waitForTimeout(300);
}

/** The course's stored structure and content, to prove an inspection imports, stores and publishes nothing. */
async function courseContent() {
  const sections = (await apiGet<{ items: Array<{ id: string }> }>('instructor', `/courses/${courseId}/sections?limit=100`)).items;
  const activities = [];
  for (const section of sections) activities.push(await apiGet<unknown>('instructor', `/courses/${courseId}/sections/${section.id}/activities?limit=100`));
  // Documents are section activities, so the activity lists cover them too.
  return { sections, activities, studentView: await apiGet<unknown>('student', `/courses/${courseId}/sections?limit=100`) };
}

before(async () => {
  browser = await launch();
  courseId = (await apiGet<{ items: Array<{ id: string; code: string }> }>('instructor', '/courses?limit=100')).items.find((c) => c.code === 'ITIL4-F-2026-2-A')!.id;
});

after(async () => {
  await browser?.close();
});

describe('Common Cartridge inspection (browser)', () => {
  it('EN: an instructor opens it from the course documents and inspects a Canvas export; the report classifies without importing', async () => {
    const before = await courseContent();
    const page = await open('instructor', `/courses/${courseId}`);
    await page.locator('[data-cartridge-inspection-link]').click();
    await page.waitForURL(new RegExp(`/courses/${courseId}/cartridge-inspection$`));
    await settle(page);
    assert.equal(await page.locator('main h1').innerText(), EN.title);
    await page.getByText(EN.importNotice).waitFor();
    await inspect(page, 'canvas-course-export.imscc', CARTRIDGE_FIXTURES.canvas(), EN.inspect);

    assert.equal(await status(page), 'valid_with_warnings');
    await page.getByText(EN.status.valid_with_warnings, { exact: true }).waitFor();
    await page.locator('[data-cartridge-not-imported]').getByText(EN.notImported).waitFor();
    assert.equal(await field(page, 'format'), `${EN.formats.common_cartridge} · ${EN.version('1.1')} (${EN.declared('1.1.0')})`);
    assert.equal(await field(page, 'title'), 'Synthetic Canvas course');
    assert.equal(await field(page, 'file'), 'canvas-course-export.imscc');
    assert.equal(await field(page, 'canvas'), EN.canvasDetected);
    assert.equal(await field(page, 'content'), EN.contentCounts(2, 13, 16, 10));
    assert.equal(await field(page, 'language'), 'es', 'the language the package declares, as written');

    // Compatibility: recognized types are not all "directly supported".
    assert.deepEqual(await compat(page, 'module', 'transform').locator('td').allInnerTexts(), ['2', EN.targets.section, EN.support.transform]);
    assert.deepEqual(await compat(page, 'web_link', 'direct').locator('td').allInnerTexts(), ['1', EN.targets.link, EN.support.direct]);
    assert.deepEqual(await compat(page, 'assessment', 'transform').locator('td').allInnerTexts(), ['1', EN.targets.quiz, EN.support.transform]);
    assert.deepEqual(await compat(page, 'lti_link', 'new_functionality').locator('td').allInnerTexts(), ['1', EN.targets.none, EN.support.new_functionality]);
    assert.deepEqual(await compat(page, 'unknown', 'unsupported').locator('td').allInnerTexts(), ['1', EN.targets.none, EN.support.unsupported]);

    // The outline keeps the package's order and titles; each item carries its classification.
    const modules = page.locator('[data-cartridge-module]');
    assert.equal(await modules.count(), 2);
    assert.match(await modules.first().innerText(), /Unit 1 - Foundations[\s\S]*Welcome[\s\S]*Course syllabus[\s\S]*Readings[\s\S]*Notes/);
    assert.ok((await modules.nth(1).innerText()).includes(EN.textHeading), 'a heading without content is labelled as such');

    // The inventory opens on demand: question types and their support, Canvas-only content, links found in pages.
    await page.getByText(EN.resourcesHeading(16), { exact: true }).click();
    const mixed = page.locator('[data-cartridge-resource="quiz2"]');
    assert.equal(await mixed.getAttribute('data-classification'), 'transform');
    assert.ok((await mixed.innerText()).includes(`${EN.questionTypes.essay} × 1 (${EN.notSupportedType})`));
    const canvasQuiz = page.locator('[data-cartridge-resource="quiz3"]');
    assert.equal(await canvasQuiz.getAttribute('data-classification'), 'unsupported');
    assert.ok((await canvasQuiz.innerText()).includes(EN.canvasBadge));
    assert.ok((await page.locator('[data-cartridge-resource="page1"]').innerText()).includes(EN.links(1, 1, 1)));
    assert.ok((await page.locator('[data-cartridge-resource="link"]').innerText()).includes(EN.address('https://example.edu/reading-list')));

    const canvas = page.locator('[data-cartridge-issue="CARTRIDGE_CANVAS_EXTENSIONS"]');
    assert.equal(await canvas.getAttribute('data-cartridge-severity'), 'warning');
    assert.ok((await canvas.innerText()).includes(EN.issues.CARTRIDGE_CANVAS_EXTENSIONS));
    const broken = page.locator('[data-cartridge-issue="CARTRIDGE_LINK_BROKEN"]');
    assert.ok((await broken.innerText()).includes(EN.where.path('wiki_content/unit-1-welcome.html')));
    assert.ok((await broken.innerText()).includes(EN.where.value('$IMS-CC-FILEBASE$/missing-handout.pdf')), 'the reference is shown as written');

    // A dry run only: no action imports, uploads into the course or publishes the package.
    for (const role of ['button', 'link'] as const) {
      const names = await page.getByRole(role).allInnerTexts();
      assert.ok(!names.some((name) => /import|publish|upload|add to course/i.test(name)), `${role}: ${names.join(' | ')}`);
    }
    assert.deepEqual(await leaks(page, 'en'), []);
    await page.context().close();
    assert.deepEqual(await courseContent(), before, 'no section, activity or document was created or published');
  });

  it('EN: unsafe, unsupported and non-cartridge packages are explained issue by issue', async () => {
    const page = await open('instructor', inspectionPath());
    await inspect(page, 'traversal.imscc', CARTRIDGE_FIXTURES.traversal(), EN.inspect);
    assert.equal(await status(page), 'invalid');
    await page.getByText(EN.status.invalid, { exact: true }).waitFor();
    const traversal = page.locator('[data-cartridge-issue="CARTRIDGE_PATH_TRAVERSAL"]');
    assert.equal(await traversal.getAttribute('data-cartridge-severity'), 'error');
    assert.ok((await traversal.innerText()).includes(EN.issues.CARTRIDGE_PATH_TRAVERSAL));
    assert.ok((await traversal.innerText()).includes(EN.where.path('../../evil.html')));
    await page.getByRole('button', { name: EN.another }).click();
    assert.equal(await page.locator('[data-cartridge-report]').count(), 0);

    // The version is read from the manifest, not the file name: a 1.4 declaration is reported as not supported.
    await inspect(page, 'course-v1.3.imscc', CARTRIDGE_FIXTURES.unsupportedVersion(), EN.inspect);
    assert.equal(await status(page), 'invalid');
    assert.equal(await field(page, 'format'), `${EN.formats.common_cartridge} (${EN.declared('1.4.0')})`);
    assert.ok((await page.locator('[data-cartridge-issue="CARTRIDGE_VERSION_UNSUPPORTED"]').innerText()).includes(EN.issues.CARTRIDGE_VERSION_UNSUPPORTED));

    // A SCORM package is recognised and pointed elsewhere.
    await inspect(page, 'lesson.zip', CARTRIDGE_FIXTURES.scorm(), EN.inspect);
    assert.equal(await field(page, 'format'), `${EN.formats.scorm} (${EN.declared('1.2')})`, 'the schema version the manifest declares, as written');
    assert.ok((await page.locator('[data-cartridge-issue="CARTRIDGE_IS_SCORM"]').innerText()).includes(EN.issues.CARTRIDGE_IS_SCORM));

    // A file that is not a cartridge is refused before anything is uploaded.
    await page.setInputFiles('#cartridge-file', { name: 'course.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') });
    await page.getByRole('button', { name: EN.inspect, exact: true }).click();
    await page.getByText(EN.onlyCartridge).waitFor();
    await page.context().close();
  });

  it('ES: the Canvas export is reported in Spanish; package titles and paths are shown as written', async () => {
    const page = await open('instructor', inspectionPath(), 'es');
    assert.equal(await page.locator('main h1').innerText(), ES.title);
    await inspect(page, 'curso-canvas.imscc', CARTRIDGE_FIXTURES.canvas(), ES.inspect);
    await page.getByText(ES.status.valid_with_warnings, { exact: true }).waitFor();
    assert.equal(await field(page, 'format'), `${ES.formats.common_cartridge} · ${ES.version('1.1')} (${ES.declared('1.1.0')})`);
    assert.equal(await field(page, 'canvas'), ES.canvasDetected);
    assert.equal(await field(page, 'content'), ES.contentCounts(2, 13, 16, 10));
    assert.equal(await field(page, 'title'), 'Synthetic Canvas course', 'authored content is not translated');
    assert.deepEqual(await compat(page, 'lti_link', 'new_functionality').locator('th, td').allInnerTexts(), [ES.kinds.lti_link, '1', ES.targets.none, ES.support.new_functionality]);
    assert.deepEqual(await compat(page, 'discussion', 'transform').locator('th, td').allInnerTexts(), [ES.kinds.discussion, '1', ES.targets.forum, ES.support.transform]);
    const nested = page.locator('[data-cartridge-issue="CARTRIDGE_ORGANIZATION_NESTED"]');
    assert.ok((await nested.innerText()).includes(ES.issues.CARTRIDGE_ORGANIZATION_NESTED));
    assert.ok((await nested.innerText()).includes(ES.warning));
    await page.getByText(ES.resourcesHeading(16), { exact: true }).click();
    assert.ok((await page.locator('[data-cartridge-resource="quiz1"]').innerText()).includes(`${ES.questionTypes.true_false} × 1`));
    await page.locator('[data-cartridge-not-imported]').getByText(ES.notImported).waitFor();
    assert.deepEqual(await leaks(page, 'es'), []);
    await page.context().close();
  });

  it('students and non-editing instructors see no link and cannot use the page', async () => {
    for (const role of ['student', 'ta'] as const) {
      const course = await open(role, `/courses/${courseId}`);
      assert.equal(await course.locator('[data-cartridge-inspection-link]').count(), 0, role);
      await course.context().close();
      const page = await open(role, inspectionPath());
      await page.getByText(EN.forbidden).waitFor();
      assert.equal(await page.locator('#cartridge-file').count(), 0, role);
      await page.context().close();
    }
  });

  it('layouts at 390, 820 and 1440 px fit the screen with a long report', async () => {
    for (const width of [390, 820, 1440]) {
      const labels = width === 820 ? ES : EN;
      const page = await open('instructor', inspectionPath(), width === 820 ? 'es' : 'en', width);
      await inspect(page, 'canvas-course-export-with-a-rather-long-file-name-for-small-screens.imscc', CARTRIDGE_FIXTURES.canvas(), labels.inspect);
      await page.getByText(labels.resourcesHeading(16), { exact: true }).click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${width} px: horizontal overflow of ${overflow} px`);
      const elements = [
        page.locator('table').first().locator('xpath=..'),
        page.locator('[data-cartridge-module]').first(),
        page.locator('[data-cartridge-resource]').first(),
        page.locator('[data-cartridge-issue]').first(),
        page.getByRole('button', { name: labels.another }),
      ];
      for (const locator of elements) {
        const box = (await locator.boundingBox())!;
        assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `${width} px: element inside the screen`);
      }
      await page.context().close();
    }
  });
});

describe('Common Cartridge inspection follows the selected language (AP-I18N-01 conventions)', () => {
  it('a report on screen switches language without inspecting the package again', async () => {
    const page = await open('instructor', inspectionPath());
    let inspections = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/cartridge-inspections')) inspections += 1;
    });
    await inspect(page, 'traversal.imscc', CARTRIDGE_FIXTURES.traversal(), EN.inspect);
    const issue = page.locator('[data-cartridge-issue="CARTRIDGE_PATH_TRAVERSAL"]');
    assert.ok((await issue.innerText()).includes(EN.issues.CARTRIDGE_PATH_TRAVERSAL));

    await switchTo(page, 'es');
    assert.equal(await page.locator('main h1').innerText(), ES.title);
    await page.getByText(ES.status.invalid, { exact: true }).waitFor();
    assert.ok((await issue.innerText()).includes(ES.issues.CARTRIDGE_PATH_TRAVERSAL));
    assert.ok((await issue.innerText()).includes(ES.where.path('../../evil.html')), 'the package path is shown as found');
    assert.equal(await field(page, 'file'), 'traversal.imscc');
    await page.locator('[data-cartridge-not-imported]').getByText(ES.notImported).waitFor();
    assert.deepEqual(await leaks(page, 'es'), []);

    await switchTo(page, 'en');
    await page.getByText(EN.status.invalid, { exact: true }).waitFor();
    assert.ok((await issue.innerText()).includes(EN.issues.CARTRIDGE_PATH_TRAVERSAL));
    assert.equal(inspections, 1, 'switching re-renders the report; the package is not sent again');
    await page.context().close();
  });

  it('errors on screen switch language: a refused file, a rate-limit refusal and an unexpected API error', async () => {
    const page = await open('instructor', inspectionPath());
    await page.setInputFiles('#cartridge-file', { name: 'course.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') });
    await page.getByRole('button', { name: EN.inspect, exact: true }).click();
    await page.getByText(EN.onlyCartridge).waitFor();
    await switchTo(page, 'es');
    await page.getByText(ES.onlyCartridge).waitFor();
    assert.equal(await page.getByText(EN.onlyCartridge).count(), 0);
    await switchTo(page, 'en');

    // API refusals are answered by the browser here, so the real per-user rate limit is not spent; the response has the
    // API's problem format. The real limit is covered by the API suite.
    const errors = MESSAGES.en.errors.codes;
    const cases = [
      { status: 429, code: 'RATE_LIMITED', en: EN.rateLimited, es: ES.rateLimited },
      { status: 500, code: 'INTERNAL_ERROR', en: errors.INTERNAL_ERROR!, es: MESSAGES.es.errors.codes.INTERNAL_ERROR! },
    ];
    for (const { status: code, code: name, en, es } of cases) {
      await page.route('**/api/v1/courses/*/cartridge-inspections', (route) =>
        route.fulfill({ status: code, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: name, status: code, code: name, detail: en }) }),
      );
      await page.setInputFiles('#cartridge-file', { name: 'course.imscc', mimeType: 'application/zip', buffer: CARTRIDGE_FIXTURES.cc13() });
      await page.getByRole('button', { name: EN.inspect, exact: true }).click();
      const alert = page.locator('form:has(#cartridge-file) [role="alert"]');
      await alert.getByText(en).waitFor();
      await switchTo(page, 'es');
      await alert.getByText(es).waitFor();
      assert.equal(await alert.getByText(en).count(), 0, `${code}: no English left`);
      assert.deepEqual(await leaks(page, 'es'), []);
      await switchTo(page, 'en');
      await alert.getByText(en).waitFor();
      await page.unroute('**/api/v1/courses/*/cartridge-inspections');
    }
    await page.context().close();
  });

  it('the Design Team can inspect; the picker is labelled in the selected language and cleared for another package', async () => {
    for (const locale of ['en', 'es'] as const) {
      const labels = MESSAGES[locale];
      const page = await open('reviewer', inspectionPath(), locale, 390);
      const picker = page.locator('form:has(#cartridge-file)');
      assert.equal(await picker.locator('[data-file-button]').innerText(), labels.common.chooseFile);
      assert.equal(await picker.locator('[data-file-name]').innerText(), labels.common.noFileChosen);
      assert.equal(await page.getByLabel(labels.cartridge.fileLabel, { exact: true }).count(), 1, 'the input keeps its label');
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), picker.locator('[data-file-button]').click()]);
      await chooser.setFiles({ name: 'course.imscc', mimeType: 'application/zip', buffer: CARTRIDGE_FIXTURES.cc13() });
      assert.equal(await picker.locator('[data-file-name]').innerText(), 'course.imscc');
      await page.getByRole('button', { name: labels.cartridge.inspect, exact: true }).click();
      await page.getByText(labels.cartridge.status.valid, { exact: true }).waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: labels.cartridge.another }).click();
      assert.equal(await picker.locator('[data-file-name]').innerText(), labels.common.noFileChosen);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${locale} 390 px: horizontal overflow of ${overflow} px`);
      await page.context().close();
    }
  });
});
