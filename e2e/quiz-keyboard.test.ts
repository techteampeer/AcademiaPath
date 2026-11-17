/**
 * AP-QA-02 (QA case TC-24): a student takes a quiz with the keyboard only, in English and Spanish (run through
 * e2e/run.sh against the production build and the demo seed).
 * - Tab, Shift+Tab, Space, the arrow keys (native radio groups) and Enter; no custom key handling.
 * - Focus after each state change: the attempt heading when the quiz starts, the first button of the submission
 *   confirmation, Submit again after "Keep working", and the result heading after submission. Focus stays visible.
 * - The answers chosen with the keyboard are the ones the server stored.
 * Fixtures: a dedicated course (isolatedCourse) with one uniquely named quiz per language, created through the API;
 * its enrollments are made inactive afterwards, so no other suite sees the quizzes or the student's attempts (quizzes
 * and attempts cannot be deleted, and a hidden quiz with a submission would still count in the student's course
 * grade). Titles, prompts and options contain no phrase from either interface catalog.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { apiGet, apiWrite, BASE, context, isolatedCourse, launch, MESSAGES, settle, type Locale } from './support.ts';

const TAG = randomBytes(3).toString('hex');
let browser: Browser;
let courseId: string;
let sectionId: string;
let cleanup: () => Promise<void> = async () => undefined;
const quizzes = {} as Record<Locale, string>;

type Focus = { tag: string; type: string | null; text: string; visible: boolean; checked: boolean | null; describedBy: string | null };
/** The focused element: tag, input type, its visible or accessible name, and whether a focus indicator is shown. */
const focused = (page: Page): Promise<Focus> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { tag: 'BODY', type: null, text: '', visible: false, checked: null, describedBy: null };
    const input = el as HTMLInputElement;
    const text = (input.labels?.[0]?.innerText ?? el.getAttribute('aria-label') ?? el.innerText ?? '').trim();
    return { tag: el.tagName, type: el.tagName === 'INPUT' ? input.type : null, text, visible: el.matches(':focus-visible'), checked: el.tagName === 'INPUT' ? input.checked : null, describedBy: el.getAttribute('aria-describedby') };
  });

async function press(page: Page, key: string): Promise<Focus> {
  await page.keyboard.press(key);
  return focused(page);
}

/** Presses Tab until the focused element matches (at most `max` presses). */
async function tabTo(page: Page, match: (focus: Focus) => boolean, what: string, max = 60): Promise<Focus> {
  const seen: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const focus = await press(page, 'Tab');
    if (match(focus)) return focus;
    seen.push(`${focus.tag}:${focus.text.slice(0, 30)}`);
  }
  throw new Error(`${what} was not reached with Tab: ${seen.join(' | ')}`);
}

async function fixtureQuiz(locale: Locale) {
  const quiz = await apiWrite<{ id: string }>('instructor', 'POST', `/courses/${courseId}/sections/${sectionId}/activities`, { type: 'quiz', title: `QA02 keyboard fixture ${locale} ${TAG}`, attemptLimit: 1 });
  const base = `/courses/${courseId}/activities/${quiz.id}/questions`;
  await apiWrite('instructor', 'POST', base, { type: 'single_choice', prompt: `Fixture ${TAG}: pick kappa`, points: 1, options: [{ text: 'kappa', isCorrect: true }, { text: 'lambda', isCorrect: false }, { text: 'sigma', isCorrect: false }] });
  await apiWrite('instructor', 'POST', base, { type: 'multiple_choice', prompt: `Fixture ${TAG}: pick omega and theta`, points: 1, options: [{ text: 'omega', isCorrect: true }, { text: 'theta', isCorrect: true }, { text: 'zeta', isCorrect: false }] });
  await apiWrite('instructor', 'POST', base, { type: 'true_false', prompt: `Fixture ${TAG}: delta is first`, points: 1, correctAnswer: true });
  await apiWrite('instructor', 'POST', `/courses/${courseId}/activities/${quiz.id}/submit`, {});
  await apiWrite('reviewer', 'POST', `/courses/${courseId}/activities/${quiz.id}/review`, { decision: 'approve' });
  return quiz.id;
}

before(async () => {
  browser = await launch();
  const course = await isolatedCourse(`ZZ-QA02-KBD-${TAG}`, `Keyboard fixture course ${TAG}`, [
    ['instructor', 'instructor'],
    ['reviewer', 'design_team'],
    ['student', 'student'],
  ]);
  ({ courseId, sectionId, cleanup } = course);
  for (const locale of ['en', 'es'] as const) quizzes[locale] = await fixtureQuiz(locale);
});

after(async () => {
  await browser?.close();
  await cleanup();
});

describe('quiz taking with the keyboard only (TC-24)', () => {
  for (const locale of ['en', 'es'] as const) {
    it(`${locale.toUpperCase()}: start, answer, confirm, keep working, submit — focus follows every step`, async () => {
      const q = MESSAGES[locale].quiz;
      const quizId = quizzes[locale];
      const page = await (await context(browser, locale, 'student')).newPage();
      await page.goto(`${BASE}/courses/${courseId}/activities/${quizId}`);
      await settle(page);

      // Start the quiz: focus moves to the attempt heading.
      const start = await tabTo(page, (f) => f.tag === 'BUTTON' && f.text === q.student.start, q.student.start);
      assert.ok(start.visible, 'the Start button shows its focus');
      await page.keyboard.press('Enter');
      await page.waitForURL(/\/attempts\//);
      await page.locator('main h1').waitFor();
      await page.waitForFunction(() => document.activeElement?.tagName === 'H1');
      const heading = await focused(page);
      assert.equal(heading.text, q.attempt.title(1, 1), 'focus is on the attempt heading');

      // Single choice: Tab into the group, Space selects, the arrow keys move the selection (native radio group).
      let focus = await press(page, 'Tab');
      assert.deepEqual([focus.type, focus.text], ['radio', 'kappa']);
      assert.ok(focus.visible, 'radio focus is visible');
      focus = await press(page, 'Space');
      assert.equal(focus.checked, true, 'Space selects the focused option');
      focus = await press(page, 'ArrowDown');
      assert.deepEqual([focus.text, focus.checked], ['lambda', true], 'ArrowDown moves to and selects the next option');
      focus = await press(page, 'ArrowUp');
      assert.deepEqual([focus.text, focus.checked], ['kappa', true], 'ArrowUp moves back');

      // Multiple choice: each checkbox is a Tab stop and Space toggles it; Shift+Tab goes back.
      focus = await press(page, 'Tab');
      assert.deepEqual([focus.type, focus.text], ['checkbox', 'omega']);
      focus = await press(page, 'Space');
      assert.equal(focus.checked, true);
      focus = await press(page, 'Tab');
      assert.equal(focus.text, 'theta');
      focus = await press(page, 'Space');
      assert.equal(focus.checked, true);
      focus = await press(page, 'Shift+Tab');
      assert.deepEqual([focus.text, focus.checked], ['omega', true], 'Shift+Tab returns to the previous control');
      focus = await press(page, 'Tab');
      focus = await press(page, 'Tab');
      assert.deepEqual([focus.type, focus.text], ['checkbox', 'zeta']);

      // True / false: Tab into the group, Space selects the first option.
      focus = await press(page, 'Tab');
      assert.equal(focus.type, 'radio');
      focus = await press(page, 'Space');
      assert.equal(focus.checked, true);

      // Submit: the confirmation's first button receives focus and is described by the confirmation text.
      focus = await tabTo(page, (f) => f.tag === 'BUTTON' && f.text === q.attempt.submit, q.attempt.submit, 5);
      assert.ok(focus.visible, 'the Submit button shows its focus');
      focus = await press(page, 'Enter');
      assert.deepEqual([focus.tag, focus.text], ['BUTTON', q.attempt.confirmSubmit], 'focus moves to Confirm submission');
      assert.ok(focus.visible, 'the confirmation button shows its focus');
      assert.ok(focus.describedBy, 'the button is described by the confirmation text');
      assert.equal(await page.locator(`#${focus.describedBy}`).innerText(), q.attempt.confirm);
      assert.equal(await page.locator('[role="status"]').filter({ hasText: q.attempt.confirm }).count(), 1, 'the confirmation is announced');

      // Keep working returns focus to Submit; nothing was sent.
      focus = await press(page, 'Tab');
      assert.equal(focus.text, q.attempt.keepWorking);
      focus = await press(page, 'Enter');
      assert.deepEqual([focus.tag, focus.text], ['BUTTON', q.attempt.submit], 'focus returns to Submit attempt');
      assert.equal(await page.getByRole('button', { name: q.attempt.confirmSubmit }).count(), 0);

      // Submit and confirm: focus moves to the result heading.
      focus = await press(page, 'Enter');
      assert.equal(focus.text, q.attempt.confirmSubmit);
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: q.attempt.recordedHeading }).waitFor();
      await page.waitForFunction(() => document.activeElement?.tagName === 'H2');
      focus = await focused(page);
      assert.deepEqual([focus.tag, focus.text], ['H2', q.attempt.recordedHeading], 'focus is on the result heading');
      assert.ok(focus.visible, 'the result heading shows its focus after keyboard use');

      // The server stored exactly what was chosen with the keyboard.
      const attemptId = page.url().split('/attempts/')[1]!.split(/[?#]/)[0]!;
      const stored = await apiGet<{ status: string; questions: Array<{ prompt: string; options: Array<{ id: string; text: string }>; selectedOptionIds: string[] }> }>('student', `/courses/${courseId}/attempts/${attemptId}`);
      assert.equal(stored.status, 'submitted');
      const chosen = (fragment: string) => {
        const question = stored.questions.find((item) => item.prompt.includes(fragment))!;
        return question.options.filter((option) => question.selectedOptionIds.includes(option.id)).map((option) => option.text).sort();
      };
      assert.deepEqual(chosen('pick kappa'), ['kappa']);
      assert.deepEqual(chosen('omega and theta'), ['omega', 'theta']);
      assert.equal(chosen('delta is first').length, 1);
      await page.context().close();
    });
  }
});
