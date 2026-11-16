/**
 * Hybrid teaching sessions (AP-045) in the browser, run through e2e/run.sh against the production build. The test
 * creates its own published course (code ZZ-HYB-E2E, listed last) with four units and six sessions (sessions 5 and
 * 6 are final presentations without units). Its enrollments are made inactive at the end so the course leaves the
 * demo users' dashboards, which later files measure. No demo course or seeded account is changed.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { apiGet, apiWrite, BASE, context, EMAIL, launch, leaks, MESSAGES, settle, type Locale, type Role } from './support.ts';

type SessionEvent = { id: string; title: string; session: { number: number; units: Array<{ id: string; title: string }> } | null };
const JOIN = 'https://meet.example.edu/proyectos-e2e';
let browser: Browser;
let courseId = '';
const units: string[] = [];
const enrollmentIds: string[] = [];

/** A date `days` from today in Lima, as YYYY-MM-DD. */
const limaDate = (days: number) => new Date(Date.now() - 5 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
const timed = (days: number) => ({ startsAt: `${limaDate(days)}T19:00:00-05:00`, endsAt: `${limaDate(days)}T21:00:00-05:00` });

before(async () => {
  browser = await launch();
  const program = (await apiGet<{ items: Array<{ id: string }> }>('admin', '/programs?limit=100')).items[0]!;
  const term = (await apiGet<{ items: Array<{ id: string }> }>('admin', '/terms?limit=100')).items[0]!;
  const template = await apiWrite<{ templateId: string }>('admin', 'POST', '/course-templates', {
    code: 'ZZ-HYB-T',
    programId: program.id,
    title: 'Hybrid Project Management',
    sections: [{ title: 'Unit 1 · Initiation' }, { title: 'Unit 2 · Planning' }, { title: 'Unit 3 · Execution' }, { title: 'Unit 4 · Closing' }],
  });
  courseId = (await apiWrite<{ id: string }>('admin', 'POST', '/courses', { programId: program.id, termId: term.id, templateId: template.templateId, code: 'ZZ-HYB-E2E', status: 'published' })).id;
  for (const [role, courseRole] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['ta', 'non_editing_instructor'], ['student', 'student']] as const) {
    enrollmentIds.push((await apiWrite<{ id: string }>('admin', 'POST', `/courses/${courseId}/enrollments`, { email: EMAIL[role], role: courseRole })).id);
  }
  units.push(...(await apiGet<{ items: Array<{ id: string }> }>('admin', `/courses/${courseId}/sections`)).items.map((section) => section.id));
  const reading = await apiWrite<{ id: string }>('instructor', 'POST', `/courses/${courseId}/sections/${units[1]}/activities`, { type: 'page', title: 'Planning reading', body: 'Synthetic material.' });
  await apiWrite('instructor', 'POST', `/courses/${courseId}/activities/${reading.id}/submit`);
  await apiWrite('reviewer', 'POST', `/courses/${courseId}/activities/${reading.id}/review`, { decision: 'approve' });
  const plan: Array<[string, Record<string, unknown>]> = [
    ['Kick-off', { number: 1, deliveryMode: 'live_online', joinUrl: JOIN, unitIds: [units[0]] }],
    ['Guided study', { number: 2, deliveryMode: 'asynchronous', unitIds: [units[0], units[1]], activityId: reading.id }],
    ['Planning workshop', { number: 3, deliveryMode: 'live_online', joinUrl: JOIN, unitIds: [units[1], units[2]] }],
    ['Execution review', { number: 4, deliveryMode: 'live_online', joinUrl: JOIN, unitIds: [units[2], units[3]] }],
    ['Final presentations I', { number: 5, deliveryMode: 'presentation', joinUrl: JOIN }],
    ['Final presentations II', { number: 6, deliveryMode: 'presentation' }],
  ];
  for (const [index, [title, session]] of plan.entries()) {
    await apiWrite('instructor', 'POST', `/courses/${courseId}/calendar/events`, { title, allDay: false, ...timed(1 + index * 4), timeZone: 'America/Lima', status: 'published', session });
  }
  await apiWrite('instructor', 'POST', `/courses/${courseId}/calendar/events`, { title: 'Campus holiday', allDay: false, ...timed(3), timeZone: 'America/Lima', status: 'published' });
});
after(async () => {
  await browser?.close();
  for (const id of enrollmentIds) await apiWrite('admin', 'PUT', `/courses/${courseId}/enrollments/${id}`, { status: 'inactive' });
});

async function open(locale: Locale, role: Role, width = 1440): Promise<Page> {
  const ctx = await context(browser, locale, role, { width });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/courses/${courseId}/calendar`);
  await settle(page);
  return page;
}
const planNumbers = (page: Page) => page.locator('[data-plan-session]').evaluateAll((items) => items.map((item) => Number(item.getAttribute('data-plan-session'))));

describe('hybrid teaching sessions', () => {
  it('EN: instructors see the session plan and add a session from the existing event form, with clear validation', async () => {
    const c = MESSAGES.en.communications.calendar;
    const s = c.session;
    const page = await open('en', 'instructor');
    await page.locator('[data-plan-session="6"]').waitFor();
    assert.deepEqual(await planNumbers(page), [1, 2, 3, 4, 5, 6], 'four units across six sessions');
    assert.equal(await page.locator('[data-plan-session="5"] [data-plan-units]').innerText(), s.noUnits, 'presentations without units');
    assert.equal(await page.locator('[data-plan-session="2"] [data-plan-units]').innerText(), 'Unit 1 · Initiation, Unit 2 · Planning', 'one session, several units');

    const form = page.locator('form[data-event-form="create"]');
    await form.getByLabel(c.manage.title, { exact: true }).fill('Extra consultation');
    await form.getByLabel(s.form.toggle).check();
    await form.getByText(s.form.units).waitFor();
    await form.getByLabel(s.form.number).fill('0');
    await form.getByRole('button', { name: c.manage.create }).click();
    await form.getByText(s.form.numberRange).waitFor();
    await form.getByLabel(s.form.number).fill('3');
    await form.getByLabel(s.form.joinUrl).fill('http://meet.example.edu/insecure');
    await form.getByRole('button', { name: c.manage.create }).click();
    await form.getByText(s.form.joinUrlInvalid).waitFor();
    await form.getByLabel(s.form.joinUrl).fill(JOIN);
    await form.getByLabel(c.manage.visibility).selectOption('published');
    await form.getByRole('button', { name: c.manage.create }).click();
    await form.getByText(MESSAGES.en.errors.codes.SESSION_NUMBER_TAKEN).waitFor();
    await form.getByLabel(s.form.number).fill('7');
    await form.getByLabel('Unit 1 · Initiation').check();
    await form.getByLabel('Unit 4 · Closing').check();
    await form.getByRole('button', { name: c.manage.create }).click();
    await form.getByText(c.manage.created).waitFor();
    await page.locator('[data-plan-session="7"]').waitFor();
    assert.equal(await page.locator('[data-plan-session="7"] [data-plan-units]').innerText(), 'Unit 1 · Initiation, Unit 4 · Closing');
    assert.equal(await form.getByLabel(s.form.number).inputValue(), '8', 'ready for the next session number');
    const saved = (await apiGet<{ events: SessionEvent[] }>('instructor', `/courses/${courseId}/calendar?from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`)).events.find((e) => e.title === 'Extra consultation')!;
    assert.deepEqual([saved.session!.number, saved.session!.units.map((u) => u.id)], [7, [units[0], units[3]]]);
    assert.deepEqual(await leaks(page, 'en'), []);
    await page.context().close();
  });

  for (const locale of ['en', 'es'] as const) {
    it(`${locale.toUpperCase()}: students see session number, mode, units, activity and the virtual class link at 390, 820 and 1440 px`, async () => {
      const c = MESSAGES[locale].communications.calendar;
      const s = c.session;
      for (const width of [390, 820, 1440]) {
        const page = await open(locale, 'student', width);
        await page.locator('[data-plan-session="6"]').waitFor();
        assert.equal(await page.locator('form[data-event-form]').count(), 0, `${width}: no editing for students`);
        const kickoff = page.locator('[data-agenda] [data-event="Kick-off"]');
        assert.ok(await kickoff.getByText(s.number(1), { exact: true }).isVisible());
        assert.ok(await kickoff.getByText(s.modes.live_online, { exact: true }).isVisible());
        const join = kickoff.getByRole('link', { name: s.join });
        assert.deepEqual([await join.getAttribute('href'), await join.getAttribute('target'), await join.getAttribute('rel')], [JOIN, '_blank', 'noopener noreferrer']);
        assert.equal(await kickoff.getByRole('link', { name: 'Unit 1 · Initiation' }).getAttribute('href'), `/courses/${courseId}#section-${units[0]}`);
        const guided = page.locator('[data-agenda] [data-event="Guided study"]');
        assert.ok(await guided.getByText(s.modes.asynchronous, { exact: true }).isVisible());
        assert.equal(await guided.getByRole('link', { name: s.join }).count(), 0, 'no live link for asynchronous sessions');
        assert.match((await guided.getByRole('link', { name: 'Planning reading' }).getAttribute('href'))!, new RegExp(`/courses/${courseId}/activities/`));
        const holiday = page.locator('[data-agenda] [data-event="Campus holiday"]');
        assert.equal(await holiday.locator('[data-session-number], [data-session-details]').count(), 0, 'ordinary events have no session details');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `${locale} ${width}: no horizontal scrolling (${overflow}px)`);
        for (const control of await page.locator('main a, main button').all()) {
          const box = await control.boundingBox();
          if (box && box.width > 0) assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `${locale} ${width}: control inside the screen`);
        }
        assert.deepEqual(await leaks(page, locale), []);
        await page.context().close();
      }
    });
  }

  it('non-editing instructors read sessions without editing; the form keeps ordinary events ordinary', async () => {
    const c = MESSAGES.en.communications.calendar;
    const ta = await open('en', 'ta');
    await ta.locator('[data-plan-session="1"]').waitFor();
    assert.ok(await ta.getByText(c.manage.readOnly).isVisible());
    assert.equal(await ta.locator('form[data-event-form], [data-session-form]').count(), 0);
    await ta.context().close();

    const page = await open('es', 'instructor', 390);
    const form = page.locator('form[data-event-form="create"]');
    const m = MESSAGES.es.communications.calendar;
    await form.getByLabel(m.manage.title, { exact: true }).fill('Reunión de coordinación');
    await form.getByRole('button', { name: m.manage.create }).click();
    await form.getByText(m.manage.created).waitFor();
    const created = (await apiGet<{ events: SessionEvent[] }>('instructor', `/courses/${courseId}/calendar`)).events.find((e) => e.title === 'Reunión de coordinación')!;
    assert.equal(created.session, null, 'an event saved without the session box stays an ordinary event');
    assert.deepEqual(await leaks(page, 'es'), []);
    await page.context().close();
  });
});
