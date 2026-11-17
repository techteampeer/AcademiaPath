/**
 * AP-QA-02 (QA case TC-14): every catalog with search and filters offers one "Clear filters" action, in English and
 * Spanish at 390 and 1440 px (run through e2e/run.sh against the production build and the demo seed).
 * - My courses (/courses), the administrator's courses (/admin/courses) and users (/admin/users).
 * - Search with results, search without results, a filter, then Clear filters: the full list returns, every field is
 *   empty again and focus moves to the search field. The control is shown only while a filter is active.
 * Read-only: nothing is created. Expected numbers come from the page's own unfiltered list (other suites may add
 * courses or users to the shared run database), never from fixed counts.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { BASE, context, launch, leaks, MESSAGES, settle, type Locale, type Role } from './support.ts';

const NO_MATCH = 'qa02-no-match-7c41';
let browser: Browser;

before(async () => {
  browser = await launch();
});
after(async () => {
  await browser?.close();
});

async function open(role: Role, locale: Locale, path: string, width: number): Promise<Page> {
  const page = await (await context(browser, locale, role, { width })).newPage();
  await page.goto(`${BASE}${path}`);
  await settle(page);
  return page;
}
const clearButton = (page: Page, locale: Locale) => page.getByRole('button', { name: MESSAGES[locale].common.clearFilters, exact: true });
const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? '');
const noOverflow = async (page: Page, where: string) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `${where}: ${overflow} px wider than the screen`);
};

async function clearAndCheck(page: Page, locale: Locale, searchId: string, where: string) {
  const button = clearButton(page, locale);
  assert.equal(await button.count(), 1, `${where}: Clear filters is offered while a filter is active`);
  await button.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction((id) => document.activeElement?.id === id, searchId);
  assert.equal(await focusedId(page), searchId, `${where}: focus moves to the search field`);
  assert.equal(await page.locator(`#${searchId}`).inputValue(), '', `${where}: the search text is cleared`);
  assert.equal(await clearButton(page, locale).count(), 0, `${where}: nothing left to clear`);
}

describe('catalog filters can be cleared in one step (TC-14)', () => {
  for (const locale of ['en', 'es'] as const) {
    for (const width of [390, 1440]) {
      const m = MESSAGES[locale];

      it(`${locale.toUpperCase()} ${width} px: My courses`, async () => {
        // The non-editing instructor holds two roles (course staff in two courses, student in one).
        const page = await open('ta', locale, '/courses', width);
        const cards = page.locator('main ul > li');
        const status = page.locator('main p[aria-live]');
        const total = await cards.count();
        assert.ok(total >= 3, 'the unfiltered list');
        assert.equal(await status.innerText(), m.common.showing(total, total));
        assert.equal(await clearButton(page, locale).count(), 0, 'no Clear filters without a filter');

        await page.locator('#courses-search').fill('ITIL');
        const itil = await cards.count();
        assert.ok(itil >= 1 && itil < total, 'a search with results');
        await page.locator('#courses-search').fill(NO_MATCH);
        assert.equal(await cards.count(), 0, 'a search without results');
        await page.getByText(m.courses.empty).waitFor();
        await noOverflow(page, `${locale} ${width} no results`);
        await clearAndCheck(page, locale, 'courses-search', 'My courses (no results)');
        assert.equal(await status.innerText(), m.common.showing(total, total), 'the full list returns');

        await page.locator('#courses-role').selectOption('student');
        const students = await cards.count();
        assert.ok(students >= 1 && students < total, 'the role filter narrows the list');
        await page.locator('#courses-search').fill('ITIL');
        await clearAndCheck(page, locale, 'courses-search', 'My courses (search and role)');
        assert.equal(await page.locator('#courses-role').inputValue(), '', 'the role filter is reset');
        assert.equal(await cards.count(), total, 'the full list returns');
        assert.deepEqual(await leaks(page, locale), []);
        await noOverflow(page, `${locale} ${width}`);
        await page.context().close();
      });

      it(`${locale.toUpperCase()} ${width} px: administrator courses`, async () => {
        const page = await open('admin', locale, '/admin/courses', width);
        const status = page.locator('main p[aria-live]');
        const initial = await status.innerText();
        assert.equal(await clearButton(page, locale).count(), 0);
        await page.locator('#course-search').fill('ITIL');
        assert.notEqual(await status.innerText(), initial, 'a search with results');
        await page.locator('#course-search').fill(NO_MATCH);
        await page.getByText(m.admin.noCourses).waitFor();
        await page.locator('#course-status').selectOption('draft');
        await noOverflow(page, `${locale} ${width} admin courses`);
        await clearAndCheck(page, locale, 'course-search', 'administrator courses');
        for (const id of ['course-term', 'course-program', 'course-status']) assert.equal(await page.locator(`#${id}`).inputValue(), '', id);
        assert.equal(await status.innerText(), initial, 'the full list returns');
        assert.deepEqual(await leaks(page, locale), []);
        await page.context().close();
      });

      it(`${locale.toUpperCase()} ${width} px: administrator users`, async () => {
        const page = await open('admin', locale, '/admin/users', width);
        const rows = page.locator('main table tbody tr');
        await rows.first().waitFor();
        const initial = await rows.allInnerTexts();
        assert.equal(await clearButton(page, locale).count(), 0);
        await page.locator('#user-search').fill('student');
        await page.locator('#user-search').press('Enter');
        await page.waitForFunction((count) => document.querySelectorAll('main table tbody tr').length < count, initial.length);
        await page.locator('#user-search').fill(NO_MATCH);
        await page.locator('#user-search').press('Enter');
        await page.getByText(m.users.noResults).waitFor();
        await page.locator('#user-status').selectOption('active');
        await noOverflow(page, `${locale} ${width} users`);
        await clearAndCheck(page, locale, 'user-search', 'administrator users');
        for (const id of ['user-status', 'user-activation']) assert.equal(await page.locator(`#${id}`).inputValue(), '', id);
        await rows.first().waitFor();
        assert.deepEqual(await rows.allInnerTexts(), initial, 'the full first page returns');
        assert.deepEqual(await leaks(page, locale), []);
        await page.context().close();
      });
    }
  }
});
