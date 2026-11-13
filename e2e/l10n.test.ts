/**
 * EN/ES interface language across the five roles (run through e2e/run.sh against the production build).
 * A page fails when it shows any interface phrase of the OTHER language's catalog (visible text, accessible
 * names, titles, placeholders, progress value texts), or when <html lang> does not match the selected language.
 * Authored content (course material, announcements, posts, messages) is never in the catalogs, so it is not flagged.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { apiGet, BASE, context, EMAIL, launch, leaks, MESSAGES, settle, type Locale, type Role } from './support.ts';

let browser: Browser;
let pages: Array<{ role: Role | null; path: string }>;

before(async () => {
  browser = await launch();
  const first = async (role: Role) => (await apiGet<{ items: Array<{ id: string }> }>(role, '/courses')).items[0]!.id;
  const [teaching, reviewing, assisting, learning] = await Promise.all([first('instructor'), first('reviewer'), first('ta'), first('student')]);
  pages = [
    { role: null, path: '/' },
    { role: null, path: '/login' },
    { role: null, path: '/preview/courses' },
    { role: null, path: '/e2e-no-such-page' },
    ...['/admin', '/admin/academics', '/admin/setup', '/admin/users', '/admin/courses', '/admin/communications', '/announcements', '/calendar', '/notifications'].map((path) => ({ role: 'admin' as const, path })),
    ...['/dashboard', `/courses/${teaching}`, `/courses/${teaching}/grades`, `/courses/${teaching}/progress`, `/courses/${teaching}/forum`, '/messages'].map((path) => ({ role: 'instructor' as const, path })),
    ...['/dashboard', `/courses/${reviewing}`].map((path) => ({ role: 'reviewer' as const, path })),
    ...['/dashboard', `/courses/${assisting}/grades`].map((path) => ({ role: 'ta' as const, path })),
    ...['/dashboard', '/courses', `/courses/${learning}`, `/courses/${learning}/grades`, `/courses/${learning}/progress`, '/certificates', '/groups', '/calendar'].map((path) => ({ role: 'student' as const, path })),
  ];
});
after(() => browser?.close());

async function open(locale: Locale, role: Role | null, path: string): Promise<Page> {
  const ctx = await context(browser, locale, role ?? undefined);
  const page = await ctx.newPage();
  await page.goto(`${BASE}${path}`);
  await settle(page);
  return page;
}

describe('interface language', () => {
  for (const locale of ['en', 'es'] as const) {
    it(`${locale}: every checked page is entirely in ${locale === 'en' ? 'English' : 'Spanish'} and declares lang="${locale}"`, async () => {
      const problems: string[] = [];
      for (const { role, path } of pages) {
        const page = await open(locale, role, path);
        const lang = await page.evaluate(() => document.documentElement.lang);
        if (lang !== locale) problems.push(`${role ?? 'public'} ${path}: <html lang="${lang}">`);
        for (const phrase of await leaks(page, locale)) problems.push(`${role ?? 'public'} ${path}: "${phrase}"`);
        await page.context().close();
      }
      assert.deepEqual(problems, []);
    });
  }

  it('academic term names follow the interface language without changing the stored name', async () => {
    const en = await open('en', 'admin', '/admin/academics');
    const enText = await en.locator('main').innerText();
    assert.match(enText, /Semester 2026-2/);
    assert.doesNotMatch(enText, /Semestre 2026-2/);
    await en.context().close();
    const es = await open('es', 'admin', '/admin/academics');
    assert.match(await es.locator('main').innerText(), /Semestre 2026-2/);
    await es.context().close();
    const terms = await apiGet<{ items: Array<{ code: string; name: string }> }>('admin', '/terms');
    assert.equal(terms.items.find((term) => term.code === '2026-2')?.name, 'Semestre 2026-2', 'the stored name is left as entered');
  });

  it('dates use the interface language', async () => {
    const en = await open('en', 'admin', '/admin/academics');
    assert.match(await en.locator('main').innerText(), /Aug 17, 2026/);
    await en.context().close();
    const es = await open('es', 'admin', '/admin/academics');
    const esText = await es.locator('main').innerText();
    assert.match(esText, /17\s+(de\s+)?ago\.?\s+(de\s+)?2026/i);
    assert.doesNotMatch(esText, /Aug 17, 2026/);
    await es.context().close();
  });

  it('unknown addresses get a translated 404 page with the right status and title', async () => {
    for (const locale of ['en', 'es'] as const) {
      const ctx = await context(browser, locale);
      const page = await ctx.newPage();
      const response = await page.goto(`${BASE}/e2e-no-such-page`);
      assert.equal(response?.status(), 404);
      await page.locator('main h1').waitFor();
      assert.equal(await page.locator('main h1').innerText(), MESSAGES[locale].common.notFoundTitle);
      assert.match(await page.title(), new RegExp(MESSAGES[locale].meta.notFound));
      await ctx.close();
    }
  });

  it('sign-in errors are shown in Spanish when Spanish is selected', async () => {
    const page = await (await context(browser, 'es')).newPage();
    await page.goto(`${BASE}/login`);
    await page.locator('#login-email').fill('nobody@academiapath.example');
    await page.locator('#login-password').fill('not-the-password');
    await page.locator('form button[type="submit"]').click();
    await page.locator('#login-error').getByText(MESSAGES.es.login.invalid).waitFor();
    assert.deepEqual(await leaks(page, 'es'), []);
    await page.context().close();
  });

  it('the chosen language persists across navigation, reload, sign-out and sign-in', async () => {
    const page = await (await context(browser, 'en', 'student')).newPage();
    await page.goto(`${BASE}/dashboard`);
    await settle(page);
    await page.getByRole('group', { name: MESSAGES.en.common.language }).getByRole('button', { name: 'Español' }).click();
    await page.waitForFunction(() => document.documentElement.lang === 'es');
    await page.getByRole('button', { name: MESSAGES.es.common.signOut }).waitFor();
    assert.deepEqual(await leaks(page, 'es'), [], 'switching updates the current page');

    await page.reload();
    await settle(page);
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'es', 'after reload');

    await page.locator('aside nav').getByRole('link', { name: MESSAGES.es.nav.myCourses }).click();
    await page.waitForURL(/\/courses$/);
    await settle(page);
    assert.deepEqual(await leaks(page, 'es'), [], 'after client-side navigation');

    await page.getByRole('button', { name: MESSAGES.es.common.signOut }).click();
    await page.waitForURL(/\/login/);
    await page.locator('main h1').getByText(MESSAGES.es.login.title).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'es', 'after sign-out');

    await page.locator('#login-email').fill(EMAIL.student);
    await page.locator('#login-password').fill(process.env.E2E_PASSWORD!);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL(/\/dashboard/);
    await settle(page);
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'es', 'after sign-in');
    assert.deepEqual(await leaks(page, 'es'), []);

    await page.getByRole('group', { name: MESSAGES.es.common.language }).getByRole('button', { name: 'English' }).click();
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await page.getByRole('button', { name: MESSAGES.en.common.signOut }).waitFor();
    assert.deepEqual(await leaks(page, 'en'), [], 'and back to English');
    await page.context().close();
  });
});

describe('production presentation (AP-042)', () => {
  const BRANDING = /Development preview|Versión de desarrollo|Synthetic data only|Solo datos sintéticos|Mock AI|IA simulada|demonstration|demostración/i;
  it('login, header and footer carry no development branding, for all five roles, in English and Spanish', async () => {
    for (const locale of ['en', 'es'] as const) {
      const footerText = MESSAGES[locale].common.footer;
      const login = await open(locale, null, '/login');
      const loginText = await login.locator('body').innerText();
      assert.ok(loginText.includes(footerText), `${locale} login shows the institutional line`);
      assert.doesNotMatch(loginText, BRANDING, `${locale} login`);
      await login.context().close();
      for (const role of ['admin', 'instructor', 'reviewer', 'ta', 'student'] as const) {
        const page = await open(locale, role, '/dashboard');
        const header = await page.locator('header').first().innerText();
        const footer = await page.locator('footer').first().innerText();
        assert.ok(footer.includes(footerText), `${locale} ${role} footer`);
        assert.doesNotMatch(`${header}\n${footer}`, BRANDING, `${locale} ${role} header and footer`);
        await page.context().close();
      }
    }
  });
});
