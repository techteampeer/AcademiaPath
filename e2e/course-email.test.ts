/**
 * Professor-to-student e-mail composition (AP-044). The first part checks the mailto links without a browser; the
 * second runs through e2e/run.sh against the production build. AcademiaPath never sends the e-mail: the page opens
 * the user's own e-mail application, so these tests also check that nothing claims a delivery.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { composePlan, MAILTO_SAFE_LENGTH, mailtoHref } from '../apps/web/src/lib/mailto.ts';
import { apiGet, apiWrite, BASE, context, EMAIL, launch, leaks, MESSAGES, settle, type Locale, type Role } from './support.ts';

/** The fields of a mailto link, decoded: recipients (To) and each header field. */
function parse(href: string): { to: string[]; fields: Record<string, string>; keys: string[] } {
  assert.ok(href.startsWith('mailto:'), href);
  const [path = '', query = ''] = href.slice('mailto:'.length).split('?');
  const pairs = query ? query.split('&').map((pair) => pair.split('=') as [string, string]) : [];
  for (const pair of pairs) assert.equal(pair.length, 2, `one "=" per field: ${pair.join('=')}`);
  return {
    to: path ? path.split(',').map(decodeURIComponent) : [],
    fields: Object.fromEntries(pairs.map(([key, value]) => [key, decodeURIComponent(value)])),
    keys: pairs.map(([key]) => key),
  };
}
const NO_DELIVERY_CLAIM = /e-?mail (was |has been )?sent|message (was |has been )?sent|sent successfully|delivered|correo enviado|mensaje enviado|enviado correctamente|entregado/i;

describe('mailto composition (no browser)', () => {
  it('puts students in BCC and the sender in To, never anyone in CC', () => {
    const plan = composePlan({ self: 'docente@universidad.example', recipients: ['ana@universidad.example', 'luis@universidad.example'], subject: 'Hola', body: 'Línea 1' });
    assert.equal(plan.mode, 'complete');
    const link = parse(plan.href);
    assert.deepEqual(link.to, ['docente@universidad.example']);
    assert.deepEqual(link.keys, ['bcc', 'subject', 'body'], 'no cc field');
    assert.equal(link.fields.bcc, 'ana@universidad.example,luis@universidad.example');
    assert.equal(plan.bccText, 'ana@universidad.example, luis@universidad.example');
    assert.deepEqual(parse(composePlan({ self: null, recipients: ['ana@universidad.example'], subject: '', body: '' }).href), { to: [], fields: { bcc: 'ana@universidad.example' }, keys: ['bcc'] });
  });

  it('encodes the subject and the message safely (spaces, &, ?, #, =, %, accents, emoji, line breaks)', () => {
    const subject = 'Examen & tarea? 100% #1 = ¡listo! Ñandú 🎓';
    const body = 'Hola a todos,\nEl examen es el lunes.\r\n¿Preguntas? Escríbanme: a+b=c & más.\rGracias';
    const href = mailtoHref({ to: ['docente@universidad.example'], bcc: ['ana@universidad.example'], subject, body });
    assert.doesNotMatch(href, /[\s#]/, 'no raw spaces, line breaks or fragment marks');
    assert.equal(href.split('&').length, 3, 'only the field separators are raw "&"');
    const link = parse(href);
    assert.equal(link.fields.subject, subject);
    assert.equal(link.fields.body, 'Hola a todos,\r\nEl examen es el lunes.\r\n¿Preguntas? Escríbanme: a+b=c & más.\r\nGracias', 'line breaks are CRLF (RFC 6068)');
    assert.match(href, /body=Hola%20a%20todos%2C%0D%0AEl/);
  });

  it('drops addresses that could add fields or recipients, and encodes the rest', () => {
    const plan = composePlan({
      self: 'docente@universidad.example',
      recipients: ['ana@universidad.example', 'evil@x.edu?cc=attacker@y.edu', 'two@x.edu,three@x.edu', 'line@x.edu\r\nBcc: z@y.edu', 'space @x.edu', '<tag>@x.edu', 'ok+tag@universidad.example'],
      subject: '',
      body: '',
    });
    const link = parse(plan.href);
    assert.deepEqual(link.keys, ['bcc']);
    assert.equal(link.fields.bcc, 'ana@universidad.example,ok+tag@universidad.example');
    assert.doesNotMatch(plan.href, /cc=attacker|attacker/);
  });

  it('large classes: the link leaves out BCC and the list is copied instead; very long messages are copied too', () => {
    const recipients = Array.from({ length: 300 }, (_, i) => `student${i}@universidad.example`);
    const large = composePlan({ self: 'docente@universidad.example', recipients, subject: 'Aviso', body: 'Mensaje corto.' });
    assert.equal(large.mode, 'paste-bcc');
    assert.ok(large.length > MAILTO_SAFE_LENGTH && large.href.length <= MAILTO_SAFE_LENGTH);
    assert.deepEqual(parse(large.href).keys, ['subject', 'body'], 'subject and message in the link, no BCC');
    assert.equal(large.bccText.split(', ').length, 300, 'every address in the copy text');
    const long = composePlan({ self: 'docente@universidad.example', recipients: recipients.slice(0, 2), subject: 'Aviso', body: 'x'.repeat(5000) });
    assert.equal(long.mode, 'copy-all');
    assert.deepEqual(parse(long.href).keys, ['subject'], 'only the subject fits in the link');
    const small = composePlan({ self: 'docente@universidad.example', recipients: recipients.slice(0, 5), subject: 'Aviso', body: 'Mensaje corto.' });
    assert.ok(small.mode === 'complete' && small.href.length <= MAILTO_SAFE_LENGTH);
  });
});

describe('compose email to students (browser)', () => {
  let browser: Browser;
  const course = {} as Record<'instructor' | 'student' | 'ta' | 'empty', string>;
  let emptyEnrollment = '';
  let listed: { recipientCount: number; recipients: Array<{ name: string; email: string }> };

  before(async () => {
    browser = await launch();
    const first = async (role: Role) => (await apiGet<{ items: Array<{ id: string }> }>(role, '/courses')).items[0]!.id;
    [course.instructor, course.student, course.ta] = await Promise.all([first('instructor'), first('student'), first('ta')]);
    listed = await apiGet('instructor', `/courses/${course.instructor}/email-recipients`);
    // A course with no students (listed last); the instructor's enrollment is made inactive at the end so it leaves
    // the instructor's dashboard, which later files measure.
    const program = (await apiGet<{ items: Array<{ id: string }> }>('admin', '/programs?limit=100')).items[0]!;
    const term = (await apiGet<{ items: Array<{ id: string }> }>('admin', '/terms?limit=100')).items[0]!;
    const template = await apiWrite<{ templateId: string }>('admin', 'POST', '/course-templates', { code: 'ZZ-MAIL-T', programId: program.id, title: 'Email Workshop', sections: [{ title: 'Unit 1' }] });
    course.empty = (await apiWrite<{ id: string }>('admin', 'POST', '/courses', { programId: program.id, termId: term.id, templateId: template.templateId, code: 'ZZ-MAIL-EMPTY', status: 'published' })).id;
    emptyEnrollment = (await apiWrite<{ id: string }>('admin', 'POST', `/courses/${course.empty}/enrollments`, { email: EMAIL.instructor, role: 'instructor' })).id;
  });
  after(async () => {
    await browser?.close();
    if (emptyEnrollment) await apiWrite('admin', 'PUT', `/courses/${course.empty}/enrollments/${emptyEnrollment}`, { status: 'inactive' });
  });

  async function open(locale: Locale, role: Role, path: string, width = 1440): Promise<Page> {
    const ctx = await context(browser, locale, role, { width });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    const page = await ctx.newPage();
    await page.goto(`${BASE}${path}`);
    await settle(page);
    return page;
  }

  it('EN: instructors open it from the course, review the recipients and get a BCC link; nothing claims a delivery', async () => {
    const m = MESSAGES.en.courseEmail;
    assert.ok(listed.recipientCount > 0, 'the demo course has active students');
    const page = await open('en', 'instructor', `/courses/${course.instructor}`);
    await page.getByRole('link', { name: m.action }).click();
    await page.waitForURL(`**/courses/${course.instructor}/email`);
    await page.locator('[data-recipient-count]').waitFor();
    assert.ok(await page.getByRole('heading', { level: 1, name: m.title }).isVisible());
    assert.ok(await page.getByText(m.recipients.count(listed.recipientCount)).isVisible());
    assert.ok(await page.getByRole('navigation').getByRole('link', { name: m.navLabel }).first().isVisible(), 'course navigation entry');
    const subject = 'Reminder: midterm exam';
    const body = 'Hello everyone,\nThe exam is on Monday.\nQuestions? Reply to me.';
    await page.getByRole('textbox', { name: m.message.subject, exact: true }).fill(subject);
    await page.getByRole('textbox', { name: m.message.body, exact: true }).fill(body);
    const href = (await page.locator('[data-mailto]').getAttribute('href'))!;
    const emails = listed.recipients.map((r) => r.email);
    assert.equal(href, composePlan({ self: EMAIL.instructor, recipients: emails, subject, body }).href);
    const link = parse(href);
    assert.deepEqual(link.to, [EMAIL.instructor], 'the instructor in To');
    assert.deepEqual(link.fields.bcc!.split(',').sort(), [...emails].sort(), 'every student in BCC');
    assert.ok(!link.keys.includes('cc'), 'nobody in CC');
    assert.equal(await page.locator('[data-compose-mode]').getAttribute('data-compose-mode'), 'complete');

    await page.getByRole('button', { name: m.send.copyBcc }).click();
    await page.getByText(m.send.bccCopied).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), emails.join(', '));
    await page.getByRole('button', { name: m.send.showAddresses }).click();
    assert.equal(await page.getByLabel(m.send.addressesLabel).inputValue(), emails.join(', '));
    await page.locator('[data-mailto]').click();
    await page.getByText(m.send.opened).waitFor();
    assert.ok(page.url().endsWith(`/courses/${course.instructor}/email`), 'the page stays open');
    const text = await page.locator('main').innerText();
    assert.doesNotMatch(text, NO_DELIVERY_CLAIM);
    assert.deepEqual(await leaks(page, 'en'), []);
    await page.context().close();
  });

  it('ES at 390, 820 and 1440 px: fits the screen, explains the long-list fallbacks, and claims no delivery', async () => {
    const m = MESSAGES.es.courseEmail;
    const emails = listed.recipients.map((r) => r.email);
    // A message long enough that the BCC list no longer fits in one link, but the subject and text still do.
    let pasteBody = '';
    for (let size = 100; size < 2000; size += 10) {
      if (composePlan({ self: EMAIL.instructor, recipients: emails, subject: 'Aviso', body: 'a'.repeat(size) }).mode === 'paste-bcc') {
        pasteBody = 'a'.repeat(size);
        break;
      }
    }
    assert.ok(pasteBody, 'found a message length for the paste-bcc case');
    for (const width of [390, 820, 1440]) {
      const page = await open('es', 'instructor', `/courses/${course.instructor}/email`, width);
      await page.locator('[data-recipient-count]').waitFor();
      assert.ok(await page.getByRole('heading', { level: 1, name: m.title }).isVisible());
      await page.getByRole('textbox', { name: m.message.subject, exact: true }).fill('Aviso');
      await page.getByRole('textbox', { name: m.message.body, exact: true }).fill(pasteBody);
      await page.locator('[data-compose-mode="paste-bcc"]').waitFor();
      assert.ok(await page.getByText(m.send.longList).isVisible(), `${width}: long-list explanation`);
      assert.deepEqual(parse((await page.locator('[data-mailto]').getAttribute('href'))!).keys, ['subject', 'body'], `${width}: no BCC in the link`);
      await page.getByRole('textbox', { name: m.message.body, exact: true }).fill('b'.repeat(4000));
      await page.locator('[data-compose-mode="copy-all"]').waitFor();
      assert.ok(await page.getByText(m.send.longMessage).isVisible() && (await page.getByRole('button', { name: m.send.copyMessage }).isVisible()));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${width}: no horizontal scrolling (${overflow}px)`);
      for (const control of await page.locator('main a[data-mailto], main button, main input, main textarea').all()) {
        const box = await control.boundingBox();
        if (box) assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `${width}: control inside the screen`);
      }
      assert.doesNotMatch(await page.locator('main').innerText(), NO_DELIVERY_CLAIM);
      assert.deepEqual(await leaks(page, 'es'), []);
      await page.context().close();
    }
  });

  it('students and non-editing instructors cannot use it and see no addresses; administrators can', async () => {
    for (const [role, id] of [['student', course.student], ['ta', course.ta]] as const) {
      for (const locale of ['en', 'es'] as const) {
        const m = MESSAGES[locale].courseEmail;
        const page = await open(locale, role, `/courses/${id}/email`);
        await page.getByText(m.forbidden).waitFor();
        assert.equal(await page.locator('[data-mailto], [data-recipient-list], [data-recipient-count]').count(), 0, `${role} ${locale}: no list`);
        assert.equal(await page.getByRole('link', { name: m.navLabel }).count(), 0, `${role} ${locale}: no navigation entry`);
        await page.context().close();
      }
      const coursePage = await open('en', role, `/courses/${id}`);
      assert.equal(await coursePage.getByRole('link', { name: MESSAGES.en.courseEmail.action }).count(), 0, `${role}: no action on the course page`);
      await coursePage.context().close();
    }
    const admin = await open('en', 'admin', `/courses/${course.instructor}/email`);
    await admin.getByText(MESSAGES.en.courseEmail.recipients.count(listed.recipientCount)).waitFor();
    await admin.context().close();
  });

  it('an empty class explains that there is nobody to email', async () => {
    for (const locale of ['en', 'es'] as const) {
      const m = MESSAGES[locale].courseEmail;
      const page = await open(locale, 'instructor', `/courses/${course.empty}/email`);
      await page.locator('[data-recipients-empty]').waitFor();
      assert.ok(await page.getByText(m.recipients.none).isVisible());
      assert.equal(await page.locator('[data-mailto]').count(), 0, 'no compose actions without recipients');
      await page.context().close();
    }
  });
});
