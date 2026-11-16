/**
 * AP-I18N-01 language consistency (run through e2e/run.sh against the production build and the demo seed).
 * 1. All five roles, English and Spanish, at 390, 820 and 1440 px: navigation (including the mobile menu), calendar,
 *    grades, certificates, course pages and account management show only the selected language's interface text,
 *    declare the matching <html lang> and fit the screen.
 * 2. Messages already on screen (sign-in errors, validation errors, API errors) follow a language switch.
 * 3. Switching the language changes no stored data: enrollments, grades, course content, the account's stored
 *    language preference and what each role may open stay the same, and authored text is never translated.
 * 4. File pickers and deadlines are shown in the selected language, and a document uploads through the localized picker.
 * The SCORM inspection page (AP-033B) is part of the matrix; its own language tests are in e2e/scorm-inspection.test.ts.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { makePdf } from '../apps/api/test/helpers/documents.ts';
import { apiGet, BASE, context, launch, leaks, MESSAGES, settle, type Locale, type Role } from './support.ts';

let browser: Browser;
let itil: string;
let iai: string;

async function open(locale: Locale, role: Role | null, path: string, width = 1440): Promise<Page> {
  const page = await (await context(browser, locale, role ?? undefined, { width })).newPage();
  await page.goto(`${BASE}${path}`);
  await settle(page);
  return page;
}

/** Clicks EN or ES in the header and waits until the page has switched. */
async function switchTo(page: Page, locale: Locale) {
  await page.locator(`button[lang="${locale}"]:visible`).first().click();
  await page.waitForFunction((value) => document.documentElement.lang === value, locale);
  await page.waitForTimeout(300);
}

before(async () => {
  browser = await launch();
  const courses = (await apiGet<{ items: Array<{ id: string; code: string }> }>('student', '/courses?limit=100')).items;
  itil = courses.find((c) => c.code === 'ITIL4-F-2026-2-A')!.id;
  iai = courses.find((c) => c.code === 'IAI-2026-2-A')!.id;
});
after(async () => {
  await browser?.close();
});

describe('interface language across roles and screen sizes', () => {
  const pagesFor = (): Array<[Role, string]> => [
    ['admin', '/admin/users'],
    ['admin', '/calendar'],
    ['admin', `/courses/${itil}/certificates`],
    ['reviewer', '/dashboard'],
    ['reviewer', `/courses/${itil}`],
    ['reviewer', `/courses/${itil}/scorm-inspection`],
    ['instructor', `/courses/${itil}/grades`],
    ['instructor', '/calendar'],
    ['instructor', `/courses/${itil}/certificates`],
    ['ta', `/courses/${itil}`],
    ['ta', `/courses/${itil}/grades`],
    ['student', '/dashboard'],
    ['student', `/courses/${itil}/grades`],
    ['student', '/certificates'],
    ['student', '/calendar'],
    ['student', `/courses/${itil}/scorm-inspection`],
  ];
  for (const locale of ['en', 'es'] as const) {
    for (const width of [390, 820, 1440]) {
      it(`${locale.toUpperCase()} at ${width} px: every role sees only ${locale === 'en' ? 'English' : 'Spanish'} interface text`, async () => {
        const problems: string[] = [];
        for (const [role, path] of pagesFor()) {
          const page = await open(locale, role, path, width);
          const where = `${role} ${path} @${width}`;
          const lang = await page.evaluate(() => document.documentElement.lang);
          if (lang !== locale) problems.push(`${where}: <html lang="${lang}">`);
          for (const phrase of await leaks(page, locale)) problems.push(`${where}: "${phrase}"`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) problems.push(`${where}: ${overflow} px wider than the screen`);
          const menu = page.getByRole('button', { name: MESSAGES[locale].common.openMenu });
          if (width === 390 && (await menu.count())) {
            await menu.first().click();
            for (const phrase of await leaks(page, locale)) problems.push(`${where} (menu open): "${phrase}"`);
          }
          await page.context().close();
        }
        assert.deepEqual(problems, []);
      });
    }
  }
});

describe('messages already shown follow a language switch', () => {
  it('a sign-in error', async () => {
    const page = await open('en', null, '/login');
    await page.getByLabel(MESSAGES.en.login.email).fill('nobody@academiapath.example');
    await page.getByLabel(MESSAGES.en.login.password).fill('not-the-password-123');
    await page.getByRole('button', { name: MESSAGES.en.login.submit }).click();
    await page.getByText(MESSAGES.en.login.invalid).waitFor();
    await switchTo(page, 'es');
    await page.getByText(MESSAGES.es.login.invalid).waitFor();
    assert.equal(await page.getByText(MESSAGES.en.login.invalid).count(), 0);
    await page.context().close();
  });

  it('validation errors on the account-management form', async () => {
    const page = await open('en', 'admin', '/admin/users/new');
    await page.locator('main form button[type="submit"]').first().click();
    await page.getByText(MESSAGES.en.users.givenNameRequired).waitFor();
    await switchTo(page, 'es');
    for (const key of ['givenNameRequired', 'familyNameRequired', 'emailInvalid'] as const) await page.getByText(MESSAGES.es.users[key]).first().waitFor();
    assert.deepEqual(await leaks(page, 'es'), []);
    await switchTo(page, 'en');
    await page.getByText(MESSAGES.en.users.givenNameRequired).waitFor();
    await page.context().close();
  });

  it('an error returned by the API (an existing program code), and back', async () => {
    const page = await open('en', 'admin', '/admin/setup');
    await page.locator('#program-code').fill('GTI');
    await page.locator('#program-name').fill('Duplicate program for the language test');
    await page.locator('form:has(#program-code) button[type="submit"]').click();
    const banner = page.locator('form:has(#program-code) [role="alert"]');
    await banner.waitFor();
    const english = await banner.innerText();
    await switchTo(page, 'es');
    await page.locator('form:has(#program-code)').getByText(MESSAGES.es.errors.codes.PROGRAM_CODE_TAKEN!).waitFor();
    await switchTo(page, 'en');
    assert.equal(await banner.innerText(), english);
    await page.context().close();
  });

  it('a range check is the app’s own localized message, not the browser’s (certificate policy)', async () => {
    const page = await open('en', 'instructor', `/courses/${itil}/certificates`);
    const form = page.locator('form:has(#certificate-minimum)');
    await page.getByLabel(MESSAGES.en.certificates.policy.requireFinalGrade).check();
    await page.locator('#certificate-minimum').fill('150');
    await form.locator('button[type="submit"]').click();
    await form.getByText(MESSAGES.en.certificates.policy.minimumRange).waitFor();
    await switchTo(page, 'es');
    await form.getByText(MESSAGES.es.certificates.policy.minimumRange).waitFor();
    await page.context().close();
  });
});

describe('switching the language changes no stored data', () => {
  const snapshot = async () => ({
    me: await apiGet<{ user: unknown }>('student', '/me'),
    courses: await apiGet<unknown>('student', '/courses?limit=100'),
    grades: await apiGet<unknown>('student', `/courses/${itil}/grades/mine`),
    progress: await apiGet<unknown>('student', '/me/progress'),
    courseProgress: await apiGet<unknown>('student', `/courses/${itil}/progress`),
    sections: await apiGet<{ items: Array<{ id: string; title: string }> }>('student', `/courses/${itil}/sections?limit=100`),
    gradebook: await apiGet<unknown>('instructor', `/courses/${itil}/gradebook?limit=100`),
    roster: await apiGet<unknown>('admin', `/courses/${itil}/enrollments?limit=100`),
  });

  it('enrollments, grades, student progress, content, the stored preference and permissions are unchanged, and authored text is not translated', async () => {
    const before = await snapshot();
    const navigation: Record<string, string[]> = {};
    for (const role of ['student', 'instructor', 'admin'] as const) {
      const page = await open('en', role, '/dashboard');
      const hrefs = async () => (await page.locator('nav a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href')!))).sort();
      navigation[`${role}-en`] = await hrefs();
      for (const locale of ['es', 'en', 'es'] as const) await switchTo(page, locale);
      navigation[`${role}-es`] = await hrefs();
      await page.goto(`${BASE}/courses/${itil}/grades`);
      await settle(page);
      await switchTo(page, 'en');
      await page.context().close();
      assert.deepEqual(navigation[`${role}-es`], navigation[`${role}-en`], `${role}: the same places are available in both languages`);
    }
    assert.deepEqual(await snapshot(), before, 'nothing stored changed');

    // Authored content is shown as written in both languages: an English course and a Spanish one.
    const titles = before.sections.items.map((section) => section.title);
    for (const locale of ['en', 'es'] as const) {
      const page = await open(locale, 'student', `/courses/${itil}`);
      const text = await page.locator('main').innerText();
      assert.ok(text.includes('ITIL 4 Foundation') && titles.every((title) => text.includes(title)), `${locale}: English course text unchanged`);
      await page.context().close();
      const spanish = await open(locale, 'student', `/courses/${iai}`);
      assert.ok((await spanish.locator('main').innerText()).includes('Unidad 1 - ¿Qué es la inteligencia artificial?'), `${locale}: Spanish course text unchanged`);
      await spanish.context().close();
    }
  });
});

describe('file pickers and deadlines', () => {
  it('the document file picker is labelled in the selected language and still works', async () => {
    for (const locale of ['en', 'es'] as const) {
      const page = await open(locale, 'instructor', `/courses/${itil}`, 390);
      const picker = page.locator('form:has(#document-file)');
      assert.equal(await picker.locator('[data-file-button]').innerText(), MESSAGES[locale].common.chooseFile);
      assert.equal(await picker.locator('[data-file-name]').innerText(), MESSAGES[locale].common.noFileChosen);
      await page.setInputFiles('#document-file', { name: 'notas-de-clase.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
      assert.equal(await picker.locator('[data-file-name]').innerText(), 'notas-de-clase.pdf');
      assert.equal(await page.getByLabel(MESSAGES[locale].documents.library.file).count(), 1, 'the input keeps its label');
      await page.context().close();
    }
  });

  it('a document is uploaded through the localized picker (Spanish, 390 px)', async () => {
    const page = await open('es', 'instructor', `/courses/${itil}`, 390);
    const form = page.locator('form:has(#document-file)');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), form.locator('[data-file-button]').click()]);
    await chooser.setFiles({ name: 'apuntes-sinteticos.pdf', mimeType: 'application/pdf', buffer: makePdf([['Apuntes sintéticos', 'Texto sintético para comprobar la subida de documentos.']]) });
    assert.equal(await form.locator('[data-file-name]').innerText(), 'apuntes-sinteticos.pdf');
    // The draft stays in this run's course (as document-integrity's do) and later suites scan its page for interface
    // phrases of the other language, so its title and text deliberately contain none from either catalog.
    const title = 'Apuntes sintéticos AP-I18N (borrador)';
    await page.locator('#document-title').fill(title);
    await form.locator('button[type="submit"]').click();
    await page.getByText(MESSAGES.es.documents.library.uploadedDraft(title)).waitFor({ timeout: 30_000 });
    assert.deepEqual(await leaks(page, 'es'), []);
    await page.context().close();
  });

  it('deadlines name their time zone in both languages', async () => {
    for (const [locale, pattern] of [
      ['en', /due [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} (AM|PM) [A-Z][A-Za-z0-9+:-]*/],
      ['es', /vence el \d{1,2} [a-z]{3,4}\.? \d{4}, \d{1,2}:\d{2} (a|p)\. m\. [A-Z][A-Za-z0-9+:-]*/],
    ] as const) {
      const page = await open(locale, 'student', '/dashboard');
      assert.match(await page.locator('main').innerText(), pattern);
      await page.context().close();
    }
  });
});
