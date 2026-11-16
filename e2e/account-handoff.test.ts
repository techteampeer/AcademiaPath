/**
 * Activation links issued by an administrator (AP-DEMO-02) in the browser, run through e2e/run.sh against the
 * production build. The suite's API uses local synthetic links, so the real request is checked there; the
 * administrator-handoff wording is checked by relabelling the real API answer in the browser (the API side of that
 * mode is covered by apps/api/test/users/account-handoff.test.ts). The accounts are synthetic, pending accounts
 * created by this file; no seeded account is changed.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { apiWrite, BASE, context, launch, leaks, MESSAGES, settle, type Locale } from './support.ts';

type Created = { user: { id: string } };
let browser: Browser;
const pending: Record<Locale, string> = { en: '', es: '' };

before(async () => {
  browser = await launch();
  for (const locale of ['en', 'es'] as const) {
    const body = { email: `handoff.${locale}@academiapath.example`, givenName: 'Demo', familyName: `Handoff ${locale.toUpperCase()}`, preferredLocale: locale };
    pending[locale] = (await apiWrite<Created>('admin', 'POST', '/users', body)).user.id;
  }
});
after(() => browser?.close());

async function open(locale: Locale, path: string, width = 1440): Promise<Page> {
  const ctx = await context(browser, locale, 'admin', { width });
  const page = await ctx.newPage();
  await page.goto(`${BASE}${path}`);
  await settle(page);
  return page;
}

/** Relabels the real API answer as an administrator-handed-over link (the suite's API issues local links). */
async function asHandoff(page: Page, pattern: string, change: (json: Record<string, unknown>) => void) {
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    const json = (await response.json()) as Record<string, unknown>;
    change(json);
    await route.fulfill({ response, json });
  });
}

describe('administrator-issued activation links', () => {
  for (const locale of ['en', 'es'] as const) {
    it(`${locale.toUpperCase()}: a new link needs the identity confirmation, which is sent with the request`, async () => {
      const u = MESSAGES[locale].users;
      const page = await open(locale, `/admin/users/${pending[locale]}`);
      const confirm = page.getByLabel(u.confirmIdentity);
      const issue = page.getByRole('button', { name: u.newLink });
      await confirm.waitFor();
      assert.equal(await confirm.isChecked(), false);
      assert.equal(await issue.isDisabled(), true, 'no link before the confirmation');

      await confirm.check();
      const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/users/${pending[locale]}/invitations`));
      await issue.click();
      assert.deepEqual((await sent).postDataJSON(), { identityConfirmed: true });
      const panel = page.locator('[data-link-delivery="local_link"]');
      await panel.getByText(u.linkTitle, { exact: true }).waitFor();
      assert.match(await panel.getByLabel(u.linkLabel).inputValue(), /\/activate#token=[A-Za-z0-9_-]{43}$/);
      assert.equal(await confirm.isChecked(), false, 'every further link needs a fresh confirmation');
      assert.equal(await issue.isDisabled(), true);
      assert.deepEqual(await leaks(page, locale), []);
      await page.context().close();
    });

    it(`${locale.toUpperCase()}: a handed-over link is labelled for private delivery to a verified person, at 390 and 1440 px`, async () => {
      const u = MESSAGES[locale].users;
      for (const width of [390, 1440]) {
        const page = await open(locale, `/admin/users/${pending[locale]}`, width);
        await asHandoff(page, '**/api/v1/users/*/invitations', (json) => void (json.delivery = 'administrator_handoff'));
        await page.getByLabel(u.confirmIdentity).check();
        await page.getByRole('button', { name: u.newLink }).click();
        const panel = page.locator('[data-link-delivery="administrator_handoff"]');
        await panel.getByText(u.handoffTitle, { exact: true }).waitFor();
        assert.ok((await panel.innerText()).includes(u.handoffIntro));
        assert.equal(await panel.getByText(u.linkTitle).count(), 0, 'no local demonstration label');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `${locale} ${width}: no horizontal scrolling (${overflow}px)`);
        assert.deepEqual(await leaks(page, locale), []);
        await page.context().close();
      }
    });

    it(`${locale.toUpperCase()}: creating an account under administrator handoff explains that no link was sent`, async () => {
      const u = MESSAGES[locale].users;
      const page = await open(locale, '/admin/users/new');
      await asHandoff(page, '**/api/v1/users', (json) => {
        json.invitation = null;
        json.invitationStatus = 'handoff_required';
      });
      await page.getByLabel(u.givenName).fill('Demo');
      await page.getByLabel(u.familyName).fill(`Created ${locale.toUpperCase()}`);
      await page.getByLabel(u.email).fill(`handoff.created.${locale}@academiapath.example`);
      await page.getByRole('button', { name: u.create, exact: true }).click();
      await page.getByText(u.linkHandoffRequired).waitFor();
      assert.equal(await page.locator('[data-link-delivery]').count(), 0, 'no link is shown');
      assert.deepEqual(await leaks(page, locale), []);
      await page.context().close();
    });
  }
});
