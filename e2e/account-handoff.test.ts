/**
 * Activation links issued by an administrator (AP-DEMO-02) in the browser, run through e2e/run.sh against the
 * production build. The tests follow the delivery mode of the running API: the suite's default is local synthetic
 * links, and `ACCOUNT_INVITATION_DELIVERY=administrator_handoff e2e/run.sh …` runs the same tests with the setting the
 * demo deployment uses. The handoff wording is also checked in local mode by relabelling the real API answer in the
 * browser (the API side of that mode is covered by apps/api/test/users/account-handoff.test.ts). The accounts are
 * synthetic accounts created by this file; no seeded account is changed.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { apiGet, apiWrite, BASE, context, launch, leaks, MESSAGES, settle, type Locale } from './support.ts';

type Created = { user: { id: string }; invitationStatus: string };
type Delivery = 'local_link' | 'administrator_handoff';
let browser: Browser;
let delivery: Delivery = 'local_link';
const pending: Record<Locale, string> = { en: '', es: '' };

before(async () => {
  browser = await launch();
  for (const locale of ['en', 'es'] as const) {
    const body = { email: `handoff.${locale}@academiapath.example`, givenName: 'Demo', familyName: `Handoff ${locale.toUpperCase()}`, preferredLocale: locale };
    const created = await apiWrite<Created>('admin', 'POST', '/users', body);
    pending[locale] = created.user.id;
    // A synthetic address gets a link at creation with local links, and never with administrator handoff.
    delivery = created.invitationStatus === 'handoff_required' ? 'administrator_handoff' : 'local_link';
  }
  // e2e/run.sh passes this variable on to the API it starts: prove that the requested mode is the one under test.
  const requested = process.env.ACCOUNT_INVITATION_DELIVERY;
  if (requested) assert.equal(delivery, requested, 'the running API uses the requested delivery mode');
});
const panelTitle = (locale: Locale) => (delivery === 'administrator_handoff' ? MESSAGES[locale].users.handoffTitle : MESSAGES[locale].users.linkTitle);
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
      const panel = page.locator(`[data-link-delivery="${delivery}"]`);
      await panel.getByText(panelTitle(locale), { exact: true }).waitFor();
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

    it(`${locale.toUpperCase()}: end to end, the person activates with the handed-over link, chooses a password and signs in; the link then stops working`, async () => {
      const m = MESSAGES[locale];
      const email = `journey.${locale}@academiapath.example`;
      const admin = await open(locale, '/admin/users/new');
      await admin.getByLabel(m.users.givenName).fill('Demo');
      await admin.getByLabel(m.users.familyName).fill(`Journey ${locale.toUpperCase()}`);
      await admin.getByLabel(m.users.email).fill(email);
      await admin.getByRole('button', { name: m.users.create, exact: true }).click();
      await admin.getByRole('link', { name: m.users.openUser }).waitFor();
      if (delivery === 'administrator_handoff') {
        await admin.getByText(m.users.linkHandoffRequired).waitFor();
        assert.equal(await admin.locator('[data-link-delivery]').count(), 0, 'no link at creation');
      } else {
        await admin.locator('[data-link-delivery="local_link"]').waitFor();
      }
      await admin.getByRole('link', { name: m.users.openUser }).click();
      await admin.waitForURL(/\/admin\/users\/[0-9a-f-]{36}$/);
      await settle(admin);
      await admin.getByLabel(m.users.confirmIdentity).check();
      await admin.getByRole('button', { name: m.users.newLink }).click();
      const panel = admin.locator(`[data-link-delivery="${delivery}"]`);
      await panel.getByText(panelTitle(locale), { exact: true }).waitFor();
      const link = await panel.getByLabel(m.users.linkLabel).inputValue();
      assert.match(link, /\/activate#token=[A-Za-z0-9_-]{43}$/);
      const userId = admin.url().split('/').pop()!;
      await admin.context().close();

      // The person, in a browser without any session, opens the link and chooses a password nobody else knows.
      const password = `Journey ${randomBytes(9).toString('base64url')}`;
      const person = await (await context(browser, locale)).newPage();
      await person.goto(link);
      await person.getByRole('heading', { name: m.activation.title }).waitFor();
      assert.ok((await person.locator('main').innerText()).includes(email), 'the page names the account being activated');
      assert.deepEqual(await leaks(person, locale), []);
      await person.getByLabel(m.activation.password, { exact: true }).fill(password);
      await person.getByLabel(m.activation.confirm, { exact: true }).fill(password);
      await person.getByRole('button', { name: m.activation.submit }).click();
      await person.getByRole('heading', { name: m.activation.doneTitle }).waitFor();
      await person.getByRole('link', { name: m.activation.goToSignIn }).click();
      await person.waitForURL(/\/login/);
      const form = person.locator('form');
      await form.getByLabel(m.login.email).fill(email);
      await form.getByLabel(m.login.password).fill(password);
      await form.getByRole('button', { name: m.login.submit }).click();
      await person.waitForURL((url) => !url.pathname.startsWith('/login'));
      await person.context().close();

      const detail = await apiGet<{ activationState: string; systemRole: string; activation: { pendingInvitation: unknown } }>('admin', `/users/${userId}`);
      assert.deepEqual([detail.activationState, detail.systemRole, detail.activation.pendingInvitation], ['activated', 'user', null]);
      const replay = await (await context(browser, locale)).newPage();
      await replay.goto(link);
      await replay.getByRole('heading', { name: m.activation.invalidTitle }).waitFor();
      await replay.context().close();
    });
  }
});
