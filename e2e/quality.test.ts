/**
 * AP-029 content quality checks in the browser (run through e2e/run.sh against the production build): the instructor
 * and design-team experience on the course and activity pages, loading / success / warning / blocking / error / empty
 * states, stale results, one request per click, English and Spanish wording, and who sees the check at all.
 * Draft content is created through the API as the instructor; a legacy invalid lesson is written straight to the
 * disposable database (the editors refuse to save it).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { apiGet, apiWrite, BASE, context, launch, leaks, MESSAGES, settle, type Locale, type Role } from './support.ts';

const ITIL = 'ITIL4-F-2026-2-A';
let browser: Browser;
let courseId: string;
let sectionId: string;
const ids = {} as Record<string, string>;

async function sql(text: string, params: unknown[]) {
  const pg = ((await import(process.env.PG_MODULE!)) as { default: typeof import('pg') }).default;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(text, params);
  } finally {
    await client.end();
  }
}

async function open(role: Role, path: string, locale: Locale = 'en'): Promise<Page> {
  const page = await (await context(browser, locale, role)).newPage();
  await page.goto(`${BASE}${path}`);
  await settle(page);
  return page;
}

const card = (page: Page) => page.locator('section#quality');
const runButton = (page: Page) => card(page).locator('[data-quality-run]');

before(async () => {
  browser = await launch();
  const courses = await apiGet<{ items: Array<{ id: string; code: string }> }>('instructor', '/courses?limit=100');
  courseId = courses.items.find((course) => course.code === ITIL)!.id;
  sectionId = (await apiGet<{ items: Array<{ id: string }> }>('instructor', `/courses/${courseId}/sections`)).items[0]!.id;
});
after(() => browser?.close());

describe('content quality checks (AP-029)', () => {
  it('the instructor checks a clean demo course: loading feedback, one request per click, then a clear result', async () => {
    const page = await open('instructor', `/courses/${courseId}`);
    await card(page).locator('h2', { hasText: MESSAGES.en.quality.heading }).waitFor();
    assert.equal(await runButton(page).innerText(), MESSAGES.en.quality.run);
    const requests: string[] = [];
    page.on('request', (request) => request.url().includes('/quality') && requests.push(request.url()));
    // Slow network: the loading state is visible and the button cannot start a second check.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 600, downloadThroughput: -1, uploadThroughput: -1 });
    await runButton(page).click();
    await card(page).getByRole('status').filter({ hasText: MESSAGES.en.quality.checking }).waitFor();
    assert.equal(await runButton(page).isDisabled(), true);
    await runButton(page).click({ force: true }).catch(() => undefined);
    await card(page).locator('[data-quality-clear]').waitFor({ timeout: 15_000 });
    assert.equal(requests.length, 1, requests.join('\n'));
    assert.equal(await card(page).locator('[data-quality-clear]').innerText(), MESSAGES.en.quality.allClear);
    assert.equal(await runButton(page).innerText(), MESSAGES.en.quality.rerun);
    await page.context().close();
  });

  it('warnings are listed with their location and lead to the activity, whose own check runs on arrival', async () => {
    const lesson = await apiWrite<{ id: string }>('instructor', 'POST', `/courses/${courseId}/sections/${sectionId}/activities`, {
      type: 'page',
      title: 'Incident review TODO',
      body: 'Draft. Read http://example.edu/incidents before class.',
    });
    ids.warningLesson = lesson.id;
    const page = await open('instructor', `/courses/${courseId}`);
    await runButton(page).click();
    const placeholder = card(page).locator('[data-quality-code="PLACEHOLDER_TEXT"]');
    await placeholder.waitFor();
    assert.match(await placeholder.innerText(), /Placeholder text found: “TODO”\./);
    assert.match(await placeholder.innerText(), /Incident review TODO › Title/);
    assert.match(await placeholder.innerText(), new RegExp(MESSAGES.en.quality.issues.PLACEHOLDER_TEXT.fix.replace(/[.]/g, '\\.')));
    assert.ok(await card(page).locator('[data-quality-code="TEXT_LINK_INSECURE"]').count());
    assert.equal(await card(page).getByRole('heading', { name: new RegExp(MESSAGES.en.quality.blockingHeading) }).count(), 0, 'no blocking group');
    await card(page).getByRole('heading', { name: new RegExp(MESSAGES.en.quality.warningsHeading) }).waitFor();
    // Follow the finding to the activity: its check runs at once.
    await placeholder.getByRole('link', { name: new RegExp(MESSAGES.en.quality.openActivity) }).click();
    await page.waitForURL(new RegExp(`/activities/${lesson.id}#quality$`));
    await card(page).locator('[data-quality-code="PLACEHOLDER_TEXT"]').waitFor();
    assert.equal(await card(page).locator('h2').innerText(), MESSAGES.en.quality.heading);
    // Warnings never block: submitting works, and the report is marked stale because the content changed.
    await page.getByRole('button', { name: MESSAGES.en.content.review.submit }).click();
    await page.getByText(MESSAGES.en.content.review.submitted).waitFor();
    await card(page).getByText(MESSAGES.en.quality.stale).waitFor();
    assert.equal(await card(page).locator('[data-quality-report]').getAttribute('data-quality-report'), 'stale');
    await page.context().close();
  });

  it('a blocking issue refuses submission on the server and the activity check lists it; fixing and rechecking clears it', async () => {
    const lesson = await apiWrite<{ id: string }>('instructor', 'POST', `/courses/${courseId}/sections/${sectionId}/activities`, { type: 'page', title: 'Imported lesson', body: 'x' });
    await sql(`UPDATE activities SET config = '{"body": "   "}'::jsonb WHERE id = $1`, [lesson.id]);
    const page = await open('instructor', `/courses/${courseId}/activities/${lesson.id}`);
    await page.getByRole('button', { name: MESSAGES.en.content.review.submit }).click();
    // English shows the API's plain-language detail; Spanish shows the catalog's description of the code.
    await page.getByRole('alert').filter({ hasText: /This content has 1 blocking quality issue\. Run the content quality check/ }).first().waitFor();
    const blocking = card(page).locator('[data-quality-code="PAGE_BODY_EMPTY"]');
    await blocking.waitFor();
    assert.match(await blocking.innerText(), new RegExp(MESSAGES.en.quality.severity.blocking));
    await card(page).getByRole('heading', { name: new RegExp(MESSAGES.en.quality.blockingHeading) }).waitFor();
    // Correct it (as the editor would) and check again without leaving the page.
    await apiWrite('instructor', 'PUT', `/courses/${courseId}/activities/${lesson.id}`, { title: 'Imported lesson', body: 'The restored lesson text.' });
    await runButton(page).click();
    await card(page).locator('[data-quality-clear]').waitFor();
    await page.context().close();
    ids.fixedLesson = lesson.id;
  });

  it('Spanish: the whole check is worded in Spanish, with no English interface text', async () => {
    const page = await open('instructor', `/courses/${courseId}`, 'es');
    assert.equal(await runButton(page).innerText(), MESSAGES.es.quality.run);
    await runButton(page).click();
    const placeholder = card(page).locator('[data-quality-code="PLACEHOLDER_TEXT"]');
    await placeholder.waitFor();
    assert.match(await placeholder.innerText(), /Se encontró texto provisional: «TODO»\./);
    assert.match(await placeholder.innerText(), new RegExp(MESSAGES.es.quality.howToFix));
    await card(page).getByRole('heading', { name: new RegExp(MESSAGES.es.quality.warningsHeading) }).waitFor();
    assert.match(await card(page).innerText(), new RegExp(MESSAGES.es.quality.checkedAt('').trim()));
    assert.deepEqual(await leaks(page, 'es'), []);
    await page.context().close();
  });

  it('the design team checks the course too; non-editing instructors and students never see the check', async () => {
    const reviewer = await open('reviewer', `/courses/${courseId}`);
    await runButton(reviewer).click();
    await card(reviewer).locator('[data-quality-report]').waitFor();
    await reviewer.context().close();
    for (const role of ['ta', 'student'] as const) {
      const page = await open(role, `/courses/${courseId}`);
      assert.equal(await card(page).count(), 0, role);
      await page.context().close();
      const direct = await apiGet<unknown>(role, `/courses/${courseId}/quality`).then(
        () => 'allowed',
        (error: Error) => error.message,
      );
      assert.match(direct, /403/, role);
    }
  });

  it('error and empty states', async () => {
    const page = await open('instructor', `/courses/${courseId}`);
    // The API is unavailable: a clear error, and the check can be run again.
    await page.route('**/api/v1/courses/*/quality', (route) => route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ status: 503, code: 'INTERNAL_ERROR', detail: 'Unavailable.' }) }));
    await runButton(page).click();
    await card(page).getByRole('alert').filter({ hasText: MESSAGES.en.quality.failed }).waitFor();
    assert.equal(await runButton(page).isDisabled(), false);
    // A course with nothing to check yet.
    await page.unroute('**/api/v1/courses/*/quality');
    await page.route('**/api/v1/courses/*/quality', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ courseId, scope: 'course', activityId: null, checkedAt: new Date().toISOString(), summary: { blocking: 0, warnings: 0, sections: 0, activities: 0, questions: 0 }, sections: [], activities: [], findings: [] }),
      }),
    );
    await runButton(page).click();
    await card(page).getByText(MESSAGES.en.quality.nothingToCheck).waitFor();
    await page.context().close();
  });

  it('a course too large for one report gets an actionable message, never a partial "no issues" result', async () => {
    const detail =
      'This course has more than 1000 activities, too many to check in one course report. Check activities one at a time from their pages; submitting and approving still check each activity in full.';
    for (const locale of ['en', 'es'] as const) {
      const page = await open('instructor', `/courses/${courseId}`, locale);
      // A first, complete check (the demo course is small) …
      await runButton(page).click();
      await card(page).locator('[data-quality-report]').waitFor();
      // … then the course grows beyond what one report covers: the API refuses (the real response shape).
      await page.route('**/api/v1/courses/*/quality', (route) =>
        route.fulfill({ status: 422, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail, code: 'QUALITY_REPORT_TOO_LARGE' }) }),
      );
      await runButton(page).click();
      const alert = card(page).getByRole('alert');
      await alert.waitFor();
      const text = await alert.innerText();
      assert.ok(text.startsWith(MESSAGES[locale].quality.failed), text);
      // English shows the API's plain-language detail; Spanish the catalog's description of the code.
      assert.ok(text.includes(locale === 'en' ? detail : MESSAGES.es.errors.codes.QUALITY_REPORT_TOO_LARGE), text);
      // No earlier result is left on screen that could read as "no issues".
      assert.equal(await card(page).locator('[data-quality-report], [data-quality-clear]').count(), 0);
      assert.deepEqual(await leaks(page, locale), []);
      await page.context().close();
    }
  });

  it('works at phone width without horizontal scrolling', async () => {
    const page = await (await context(browser, 'en', 'instructor', { width: 390 })).newPage();
    await page.goto(`${BASE}/courses/${courseId}`);
    await settle(page);
    await runButton(page).click();
    await card(page).locator('[data-quality-report]').waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
    await page.context().close();
  });
});

