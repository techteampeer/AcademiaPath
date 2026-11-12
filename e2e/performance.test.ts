/**
 * Interaction performance guards that do not depend on machine speed (run through e2e/run.sh):
 *   - request budgets: how many API calls each dashboard makes (the student dashboard used to walk every section
 *     and every activity: 32 calls for the demo student, now 16);
 *   - navigation feedback: under emulated network latency the followed sidebar link is marked as pending at once,
 *     instead of leaving the previous page on screen with no sign of progress. (A route-level loading boundary was
 *     tried and rejected: React holds each Suspense reveal for at least 300 ms, which slowed fast navigations.)
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
  it('a followed sidebar link is marked as pending at once while the next page is on its way', async () => {
    const page = await (await context(browser, 'en', 'student')).newPage();
    await page.goto(`${BASE}/dashboard`);
    await settle(page);
    // Record whether the clicked link ever shows its pending marker before the next page arrives.
    await page.evaluate(() => {
      const w = window as unknown as { __pendingOn?: string | null };
      new MutationObserver(() => {
        const marker = document.querySelector('[data-nav-pending]');
        if (marker) w.__pendingOn = marker.closest('a')?.getAttribute('href') ?? null;
      }).observe(document.body, { childList: true, subtree: true });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: -1, uploadThroughput: -1 });
    await page.locator('aside nav').getByRole('link', { name: MESSAGES.en.nav.calendar }).click();
    await page.waitForURL(/\/calendar$/);
    await settle(page);
    assert.equal(await page.evaluate(() => (window as unknown as { __pendingOn?: string }).__pendingOn), '/calendar');
    assert.equal(await page.locator('[data-nav-pending]').count(), 0, 'the marker is gone once the page has arrived');
    await page.context().close();
  });
});
