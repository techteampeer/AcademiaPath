/**
 * AP-038A course content export in the browser, run through e2e/run.sh against the production build and the
 * synthetic demo seed. Authors download the package from the course page (English and Spanish); non-editing
 * instructors and students see no export control and the API refuses them. Exporting only reads: no course changes.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { API, apiGet, BASE, context, EMAIL, launch, leaks, MESSAGES, session, settle, type Locale, type Role } from './support.ts';

const CODE = 'ITIL4-F-2026-2-A';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let browser: Browser;
let courseId = '';

before(async () => {
  browser = await launch();
  courseId = (await apiGet<{ items: Array<{ id: string; code: string }> }>('instructor', '/courses?limit=100')).items.find((c) => c.code === CODE)!.id;
});
after(() => browser?.close());

async function open(locale: Locale, role: Role, width = 1440): Promise<Page> {
  const ctx = await context(browser, locale, role, { width });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/courses/${courseId}`);
  await settle(page);
  return page;
}

/** Clicks the export button and returns the saved file's name and parsed package. */
async function download(page: Page, label: string) {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: label }).click()]);
  const text = await readFile((await file.path())!, 'utf8');
  return { fileName: file.suggestedFilename(), text, pkg: JSON.parse(text) as { format: string; formatVersion: number; source: { courseCode: string }; counts: { activities: number; units: number }; course: { units: Array<{ activities: unknown[] }> } } };
}

describe('course content export (AP-038A)', () => {
  for (const [locale, role, width] of [['en', 'instructor', 1440], ['es', 'reviewer', 390]] as const) {
    it(`${locale.toUpperCase()}: ${role === 'reviewer' ? 'the design team' : 'an instructor'} downloads the course package from the course page at ${width} px`, async () => {
      const c = MESSAGES[locale].courses;
      const page = await open(locale, role, width);
      const { fileName, text, pkg } = await download(page, c.exportContent);
      assert.equal(fileName, `course-${CODE}.academiapath.json`);
      assert.deepEqual([pkg.format, pkg.formatVersion, pkg.source.courseCode], ['academiapath.course-package', 1, CODE]);
      assert.ok(pkg.counts.units > 0 && pkg.counts.activities > 0, 'the demo course content is included');
      assert.equal(pkg.course.units.reduce((total, unit) => total + unit.activities.length, 0), pkg.counts.activities);
      for (const email of Object.values(EMAIL)) assert.ok(!text.includes(email), `no account address (${email})`);
      assert.doesNotMatch(text, UUID, 'no database identifiers');
      await page.getByText(c.exportDone).waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${locale} ${width}: no horizontal scrolling (${overflow}px)`);
      assert.deepEqual(await leaks(page, locale), []);
      await page.context().close();
    });
  }

  it('non-editing instructors and students see no export control, and the API refuses them', async () => {
    for (const role of ['ta', 'student'] as const) {
      const page = await open('en', role);
      await page.locator('main h1').waitFor();
      assert.equal(await page.getByRole('button', { name: MESSAGES.en.courses.exportContent }).count(), 0, role);
      assert.equal(await page.locator('[data-course-export]').count(), 0, role);
      await page.context().close();
      const signedIn = await session(role);
      const res = await fetch(`${API}/courses/${courseId}/export`, { headers: { cookie: signedIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
      assert.equal(res.status, 403, role);
    }
  });

  it('ES: a course too large to export shows a clear message in Spanish', async () => {
    const page = await open('es', 'instructor');
    await page.route(`**/api/v1/courses/${courseId}/export`, (route) =>
      route.fulfill({ status: 422, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'Unprocessable Content', status: 422, detail: 'too large', code: 'COURSE_EXPORT_TOO_LARGE' }) }),
    );
    await page.getByRole('button', { name: MESSAGES.es.courses.exportContent }).click();
    await page.getByText(MESSAGES.es.errors.codes.COURSE_EXPORT_TOO_LARGE!).waitFor();
    assert.deepEqual(await leaks(page, 'es'), []);
    await page.context().close();
  });
});
