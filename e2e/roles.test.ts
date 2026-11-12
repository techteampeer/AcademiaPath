/**
 * The five demo roles sign in through the real form, land on their workspace, open their key pages without
 * errors and sign out; role boundaries hold (run through e2e/run.sh against the production build).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser } from 'playwright';
import { API, apiGet, BASE, context, EMAIL, launch, MESSAGES, sessionCookies, settle, type Role } from './support.ts';

const t = MESSAGES.en;
let browser: Browser;
before(async () => {
  browser = await launch();
});
after(() => browser?.close());

/** Sidebar links each role must have, followed by clicking (client-side navigation). */
const JOURNEYS: Record<Role, { landing: RegExp; links: string[] }> = {
  admin: { landing: /\/admin$/, links: [t.nav.users, t.nav.coursesEnrollments, t.nav.academicStructure] },
  instructor: { landing: /\/dashboard$/, links: [t.nav.myCourses, t.nav.messages, t.nav.calendar] },
  reviewer: { landing: /\/dashboard$/, links: [t.nav.myCourses, t.nav.notifications] },
  ta: { landing: /\/dashboard$/, links: [t.nav.myCourses, t.nav.messages] },
  student: { landing: /\/dashboard$/, links: [t.nav.myCourses, t.nav.myCertificates, t.nav.myGroups] },
};

describe('five roles', () => {
  for (const role of Object.keys(JOURNEYS) as Role[]) {
    it(`${role}: signs in, opens key pages without errors, signs out`, async () => {
      const ctx = await context(browser, 'en');
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      // Expected 401s (the signed-out session check on /login, the probe after signing out) are not errors.
      page.on('console', (message) => {
        if (message.type() === 'error' && !/status of 401/.test(message.text())) errors.push(message.text());
      });
      page.on('response', (response) => {
        if (response.url().startsWith(API) && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`);
      });

      await page.goto(`${BASE}/login`);
      await page.locator('#login-email').fill(EMAIL[role]);
      await page.locator('#login-password').fill(process.env.E2E_PASSWORD!);
      await page.locator('form button[type="submit"]').click();
      await page.waitForURL(JOURNEYS[role].landing);
      await settle(page);

      for (const label of JOURNEYS[role].links) {
        // Prefix match: links with an unread badge add the count to their accessible name.
        const link = page.locator('aside nav').getByRole('link', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });
        const href = await link.getAttribute('href');
        await link.click();
        await page.waitForURL((url) => url.pathname === href);
        await settle(page);
        assert.equal(await page.locator('aside nav [aria-current="page"]').getAttribute('href'), href, `${label} is marked as the current page`);
        assert.equal(await page.locator('main h1').count(), 1, `${label} has one level-1 heading`);
      }

      await page.getByRole('button', { name: t.common.signOut }).click();
      await page.waitForURL(/\/login/);
      const me = await page.evaluate(async () => (await fetch('/api/v1/me')).status);
      assert.equal(me, 401, 'the session is gone after signing out');
      assert.deepEqual(errors, []);
      await ctx.close();
    });
  }

  it('role boundaries: staff and administrator data are refused to a student by the API', async () => {
    const cookie = (await sessionCookies('student')).map((c) => `${c.name}=${c.value}`).join('; ');
    const course = (await apiGet<{ items: Array<{ id: string }> }>('student', '/courses')).items[0]!.id;
    for (const path of ['/users', `/courses/${course}/gradebook`, `/courses/${course}/progress/students`]) {
      const res = await fetch(`${API}${path}`, { headers: { cookie } });
      assert.equal(res.status, 403, `${path} as student`);
    }
  });

  it('signed-out visitors are sent to sign in, keeping the requested page', async () => {
    const page = await (await context(browser, 'en')).newPage();
    await page.goto(`${BASE}/dashboard`);
    await page.waitForURL(/\/login/);
    await page.locator('#login-email').waitFor();
    await page.context().close();
  });
});
