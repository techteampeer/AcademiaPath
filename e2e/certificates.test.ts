/**
 * Certificate signatories (AP-043) in the browser, run through e2e/run.sh against the production build.
 * The test creates its own published course (code ZZ-SIG-E2E, listed last) with one reading that the demo
 * student completes, so no demo course or seeded account is changed. Its enrollments are made inactive at the
 * end, so the course leaves the demo users' dashboards (later files measure them). Signatory names are fictional.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { apiGet, apiWrite, BASE, context, EMAIL, launch, leaks, MESSAGES, settle, type Locale, type Role } from './support.ts';

type Signatory = { name: string; title: string };
type Policy = { version: number; enabled: boolean; signatories: Signatory[] };
const DIRECTOR = { name: 'María Fernanda Quispe Huamán', title: 'Directora de Programas Académicos' };
const COORDINATOR = { name: 'Jorge Luis Paredes Salazar', title: 'Coordinador del Programa de Maestría' };
const DEAN = { name: 'Rosa Elena Mamani Condori', title: 'Decana de la Facultad de Ingeniería' };

let browser: Browser;
let courseId = '';
const enrollmentIds: string[] = [];
const url = () => `/courses/${courseId}/certificates`;
const policy = () => apiGet<Policy>('admin', `${url().replace('/certificates', '')}/certificate-policy`);

before(async () => {
  browser = await launch();
  const program = (await apiGet<{ items: Array<{ id: string }> }>('admin', '/programs?limit=100')).items[0]!;
  const term = (await apiGet<{ items: Array<{ id: string }> }>('admin', '/terms?limit=100')).items[0]!;
  const template = await apiWrite<{ templateId: string }>('admin', 'POST', '/course-templates', { code: 'ZZ-SIG-T', programId: program.id, title: 'Certificate Signatories Workshop', sections: [{ title: 'Unit 1' }] });
  courseId = (await apiWrite<{ id: string }>('admin', 'POST', '/courses', { programId: program.id, termId: term.id, templateId: template.templateId, code: 'ZZ-SIG-E2E', status: 'published' })).id;
  for (const [role, courseRole] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['ta', 'non_editing_instructor'], ['student', 'student']] as const) {
    enrollmentIds.push((await apiWrite<{ id: string }>('admin', 'POST', `/courses/${courseId}/enrollments`, { email: EMAIL[role], role: courseRole })).id);
  }
  const section = (await apiGet<{ items: Array<{ id: string }> }>('admin', `/courses/${courseId}/sections`)).items[0]!.id;
  const lesson = await apiWrite<{ id: string }>('instructor', 'POST', `/courses/${courseId}/sections/${section}/activities`, { type: 'page', title: 'Reading 1', body: 'Synthetic reading.' });
  await apiWrite('instructor', 'POST', `/courses/${courseId}/activities/${lesson.id}/submit`);
  await apiWrite('reviewer', 'POST', `/courses/${courseId}/activities/${lesson.id}/review`, { decision: 'approve' });
  await apiWrite('student', 'PUT', `/courses/${courseId}/activities/${lesson.id}/completion`);
});
after(async () => {
  await browser?.close();
  for (const id of enrollmentIds) await apiWrite('admin', 'PUT', `/courses/${courseId}/enrollments/${id}`, { status: 'inactive' });
});

async function open(locale: Locale, role: Role | null, path: string, width = 1440): Promise<Page> {
  const ctx = await context(browser, locale, role ?? undefined, { width });
  const page = await ctx.newPage();
  await page.goto(`${BASE}${path}`);
  await settle(page);
  return page;
}
const row = (page: Page, position: number) => page.locator(`[data-signatory-row="${position}"]`);
const fill = async (page: Page, locale: Locale, position: number, signer: Signatory) => {
  const p = MESSAGES[locale].certificates.policy;
  await row(page, position).getByLabel(p.signatoryName).fill(signer.name);
  await row(page, position).getByLabel(p.signatoryTitle).fill(signer.title);
};
/** The name and title fields of every signatory row, in order. */
const values = async (page: Page, locale: Locale) => {
  const p = MESSAGES[locale].certificates.policy;
  const rows = await page.locator('[data-signatory-row]').all();
  return Promise.all(rows.map(async (element) => ({ name: await element.getByLabel(p.signatoryName).inputValue(), title: await element.getByLabel(p.signatoryTitle).inputValue() })));
};
const button = (page: Page, name: string, exact = false) => page.getByRole('button', { name, exact });

describe('certificate signatories', () => {
  it('17. EN: instructors add, validate, reorder, remove and save signatories in the existing policy form', async () => {
    const p = MESSAGES.en.certificates.policy;
    const page = await open('en', 'instructor', url());
    const editor = page.locator('[data-signatory-editor]');
    await editor.getByText(p.signatories, { exact: true }).waitFor();
    assert.ok(await editor.getByText(p.noSignatories).isVisible(), 'empty state');
    for (let i = 0; i < 3; i++) await button(page, p.addSignatory).click();
    assert.equal(await page.locator('[data-signatory-row]').count(), 3);
    assert.equal(await button(page, p.addSignatory).count(), 0, 'no fourth signatory');
    assert.ok(await editor.getByText(p.maxSignatories).isVisible());

    await page.getByLabel(MESSAGES.en.certificates.policy.requireFinalGrade).uncheck();
    await button(page, p.save, true).click();
    assert.ok(await page.getByText(p.signatoryIncomplete(1)).isVisible(), 'incomplete signatories are explained');
    await fill(page, 'en', 1, DIRECTOR);
    await fill(page, 'en', 2, COORDINATOR);
    await fill(page, 'en', 3, { name: 'maria fernanda QUISPE huaman', title: 'Rectora' });
    await button(page, p.save, true).click();
    assert.ok(await page.getByText(p.signatoryDuplicate(3)).isVisible(), 'a repeated person is explained');
    assert.equal((await policy()).version, 0, 'nothing saved while invalid');

    await fill(page, 'en', 3, DEAN);
    await button(page, `${p.moveUp} ${p.signatory(3)}`).click();
    assert.deepEqual(await values(page, 'en'), [DIRECTOR, DEAN, COORDINATOR], 'moved up');
    const preview = await page.locator('[data-signatory-preview] p.font-semibold').allInnerTexts();
    assert.deepEqual(preview, [DIRECTOR.name, DEAN.name, COORDINATOR.name], 'the preview follows the print order');
    await button(page, `${p.remove} ${p.signatory(2)}`).click();
    assert.deepEqual(await values(page, 'en'), [DIRECTOR, COORDINATOR], 'removed');
    assert.ok(await button(page, `${p.moveUp} ${p.signatory(1)}`).isDisabled(), 'the first cannot move up');
    assert.ok(await button(page, `${p.moveDown} ${p.signatory(2)}`).isDisabled(), 'the last cannot move down');

    await button(page, p.save, true).click();
    await page.getByText(p.saved).waitFor();
    const saved = await policy();
    assert.deepEqual([saved.version, saved.signatories], [1, [DIRECTOR, COORDINATOR]]);
    assert.deepEqual(await leaks(page, 'en'), []);
    await page.reload();
    await settle(page);
    await page.locator('[data-signatory-row="2"]').waitFor();
    assert.deepEqual(await values(page, 'en'), [DIRECTOR, COORDINATOR], 'saved values are shown again');
    await page.context().close();
  });

  it('17, 18. ES at 390 px: the editor fits the screen, its controls are reachable, and names are never translated', async () => {
    const p = MESSAGES.es.certificates.policy;
    const page = await open('es', 'instructor', url(), 390);
    await page.locator('[data-signatory-row="2"]').waitFor();
    assert.ok(await page.getByText(p.signatories, { exact: true }).isVisible());
    assert.deepEqual(await values(page, 'es'), [DIRECTOR, COORDINATOR], 'stored names and titles exactly as entered');
    await button(page, p.addSignatory).click();
    await fill(page, 'es', 3, DEAN);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `no horizontal scrolling (${overflow}px)`);
    for (const control of await page.locator('[data-signatory-editor] button, [data-signatory-editor] input').all()) {
      const box = (await control.boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= 390, 'inside the screen');
      assert.ok(box.height >= 32, `touch target ${box.height}px`);
    }
    assert.ok(((await row(page, 1).getByLabel(p.signatoryName).boundingBox())!.width) >= 250, 'full-width fields');
    await button(page, p.save, true).click();
    await page.getByText(p.saved).waitFor();
    assert.deepEqual((await policy()).signatories, [DIRECTOR, COORDINATOR, DEAN]);
    assert.deepEqual(await leaks(page, 'es'), []);
    await page.context().close();
  });

  it('15, 16. non-editing instructors see the signatories read-only; students do not see the editor', async () => {
    const p = MESSAGES.en.certificates.policy;
    const page = await open('en', 'ta', url());
    await page.locator('[data-signatory-row="3"]').waitFor();
    assert.ok(await page.getByText(p.readOnly).isVisible());
    assert.equal(await button(page, p.addSignatory).count(), 0);
    assert.equal(await page.locator('[data-signatory-editor] button').count(), 0, 'no add, move or remove controls');
    for (const input of await page.locator('[data-signatory-editor] input').all()) assert.ok(await input.isDisabled());
    await page.context().close();
    const student = await open('en', 'student', url());
    assert.equal(await student.locator('[data-signatory-editor]').count(), 0);
    await student.context().close();
  });

  it('12, 19. verification and the certificate page show the signatories saved at issue time (EN and ES)', async () => {
    const eligibility = await apiGet<{ items: Array<{ student: { id: string; email: string }; eligibility: { eligible: boolean } }> }>('instructor', `${url()}/eligibility`);
    const student = eligibility.items.find((item) => item.student.email === EMAIL.student)!;
    assert.ok(student.eligibility.eligible, 'the demo student completed the only reading');
    const certificate = await apiWrite<{ id: string; verificationPath: string; signatories: Signatory[] }>('instructor', 'POST', `${url()}`, { userId: student.student.id });
    assert.deepEqual(certificate.signatories, [DIRECTOR, COORDINATOR, DEAN]);
    // A later change of the policy does not rewrite the issued certificate.
    const current = await policy();
    await apiWrite('instructor', 'PUT', `${url().replace('/certificates', '')}/certificate-policy`, {
      expectedVersion: current.version,
      enabled: true,
      requireCompletion: true,
      requireFinalGrade: false,
      minimumGradePercent: null,
      issuerName: 'AcademiaPath',
      signatories: [{ name: 'Carlos Alberto Rojas Medina', title: 'Rector' }],
    });
    for (const locale of ['en', 'es'] as const) {
      const v = MESSAGES[locale].certificates.verify;
      const page = await open(locale, null, certificate.verificationPath);
      await page.locator('[data-verification="valid"]').waitFor();
      const text = await page.locator('main').innerText();
      assert.ok(text.includes(v.signatories), `${locale}: heading`);
      assert.deepEqual(await page.locator('[data-signatory] .font-medium').allInnerTexts(), [DIRECTOR.name, COORDINATOR.name, DEAN.name], `${locale}: in order`);
      assert.ok(text.includes(DEAN.title) && !text.includes('Rojas Medina'), `${locale}: only the snapshot`);
      assert.deepEqual(await leaks(page, locale), []);
      await page.context().close();
      const detail = await open(locale, 'student', `/certificates/${certificate.id}`);
      assert.deepEqual(await detail.locator('[data-signatory] .font-medium').allInnerTexts(), [DIRECTOR.name, COORDINATOR.name, DEAN.name]);
      await detail.context().close();
    }
  });
});
