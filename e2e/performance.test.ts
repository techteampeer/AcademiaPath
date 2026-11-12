/**
 * Interaction performance guards that do not depend on machine speed (run through e2e/run.sh):
 *   - request budgets: how many API calls each dashboard makes (the student dashboard used to walk every section
 *     and every activity: 32 calls for the demo student, now 16);
 *   - navigation feedback: under emulated network latency a followed link shows the loading state at once,
 *     instead of leaving the previous page on screen with no sign of progress.
 * Timings are measured by e2e/bench.ts, not asserted here (wall-clock limits are flaky).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser } from 'playwright';
import { API, BASE, context, launch, MESSAGES, settle, type Role } from './support.ts';

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(() => browser?.close());

/** Generous ceilings above the demo data's current counts (before → after: student 32 → 16, ta 30 → 25). */
const DASHBOARD_BUDGET: Record<Exclude<Role, 'admin'>, number> = { student: 20, ta: 28, reviewer: 32, instructor: 40 };

describe('request budgets', () => {
  for (const [role, budget] of Object.entries(DASHBOARD_BUDGET) as Array<[Exclude<Role, 'admin'>, number]>) {
    it(`${role} dashboard makes at most ${budget} API requests and none twice by accident`, async () => {
      const page = await (await context(browser, 'en', role)).newPage();
      const calls: string[] = [];
      page.on('request', (request) => {
        if (request.url().startsWith(API)) calls.push(`${request.method()} ${request.url().slice(API.length)}`);
      });
      await page.goto(`${BASE}/dashboard`);
      await settle(page);
      assert.ok(calls.length <= budget, `${calls.length} requests:\n${calls.join('\n')}`);
      // The session, workspace and unread summary are loaded once per page view, not per component.
      for (const once of ['GET /me', 'GET /me/messaging/summary']) {
        assert.ok(calls.filter((call) => call === once).length <= 1, `${once} requested more than once`);
      }
      await page.context().close();
    });
  }
});

describe('navigation feedback', () => {
  it('a followed link shows the localized loading state while the next page is on its way', async () => {
    for (const locale of ['en', 'es'] as const) {
      const page = await (await context(browser, locale, 'student')).newPage();
      await page.goto(`${BASE}/dashboard`);
      await settle(page);
      // Record whether the loading state ever appears between the click and the next page.
      await page.evaluate(() => {
        const w = window as unknown as { __loadingSeen?: string };
        new MutationObserver(() => {
          const status = document.querySelector('[data-route-loading] [role="status"]');
          if (status) w.__loadingSeen = status.textContent ?? '';
        }).observe(document.body, { childList: true, subtree: true });
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: -1, uploadThroughput: -1 });
      await page.locator('aside nav').getByRole('link', { name: MESSAGES[locale].nav.calendar }).click();
      await page.waitForURL(/\/calendar$/);
      await settle(page);
      const seen = await page.evaluate(() => (window as unknown as { __loadingSeen?: string }).__loadingSeen);
      assert.equal(seen, MESSAGES[locale].common.navigating);
      await page.context().close();
    }
  });
});
