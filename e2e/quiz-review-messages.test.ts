/**
 * AP-QA-02 (QA case TC-20): a quiz goes from an empty draft to a student's attempt through the real interface, in
 * English and Spanish (run through e2e/run.sh against the production build and the demo seed).
 * - Submitting an empty quiz is refused (the API rule is unchanged) and the refusal follows a language switch.
 * - Adding a valid question removes that refusal, which no longer describes the quiz; a genuine refusal still
 *   appears when the only question is removed and the quiz is submitted again.
 * - The instructor submits; a different, authorized Design Team member approves; the student starts the quiz.
 * Fixtures: a dedicated course (isolatedCourse) whose enrollments are made inactive afterwards, because quizzes and
 * attempts cannot be deleted. Titles, prompts and options contain no phrase from either interface catalog.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { apiGet, BASE, context, isolatedCourse, launch, leaks, MESSAGES, settle, switchLocale, type Locale, type Role } from './support.ts';

const TAG = randomBytes(3).toString('hex');
let browser: Browser;
let courseId: string;
let sectionId: string;
let cleanup: () => Promise<void> = async () => undefined;

async function open(role: Role, locale: Locale, path: string): Promise<Page> {
  const page = await (await context(browser, locale, role)).newPage();
  await page.goto(`${BASE}${path}`);
  await settle(page);
  return page;
}
/** The review card on an activity page (its messages: errors are role="alert", confirmations role="status"). */
const reviewCard = (page: Page) => page.locator('section[aria-labelledby="review-heading"]');

async function addQuestion(page: Page, locale: Locale) {
  await page.locator('#question-type').selectOption('single_choice');
  await page.locator('#question-prompt').fill(`Fixture ${TAG}: pick kappa`);
  await page.locator('#question-option-0').fill('kappa');
  await page.locator('#question-option-0-correct').check();
  await page.locator('#question-option-1').fill('lambda');
  await page.getByRole('button', { name: MESSAGES[locale].quiz.form.submit, exact: true }).click();
  await page.getByText(MESSAGES[locale].quiz.bank.added).waitFor();
}

before(async () => {
  browser = await launch();
  ({ courseId, sectionId, cleanup } = await isolatedCourse(`ZZ-QA02-REV-${TAG}`, `Review fixture course ${TAG}`, [
    ['instructor', 'instructor'],
    ['reviewer', 'design_team'],
    ['student', 'student'],
  ]));
});
after(async () => {
  await browser?.close();
  await cleanup();
});

describe('quiz review messages and the instructor → Design Team → student flow (TC-20)', () => {
  for (const locale of ['en', 'es'] as const) {
    it(`${locale.toUpperCase()}: an obsolete "no questions" refusal disappears; the approved quiz can be started`, async () => {
      const m = MESSAGES[locale];
      const other: Locale = locale === 'en' ? 'es' : 'en';
      const refusal = (lang: Locale) => MESSAGES[lang].errors.codes.QUIZ_HAS_NO_QUESTIONS!;
      const title = `QA02 review fixture ${locale} ${TAG}`;

      // 1. The instructor creates an empty quiz in the interface.
      const page = await open('instructor', locale, `/courses/${courseId}`);
      await page.getByRole('button', { name: m.content.section.addContent }).click();
      await page.locator(`#new-${sectionId}-type`).selectOption('quiz');
      await page.locator(`#new-${sectionId}-title`).fill(title);
      await page.getByRole('button', { name: m.content.section.saveDraft }).click();
      await page.getByText(m.content.section.savedDraft(title)).waitFor();
      await page.getByRole('link', { name: title }).click();
      await page.waitForURL(/\/activities\//);
      await settle(page);
      const quizPath = new URL(page.url()).pathname;
      const card = reviewCard(page);

      // 2–3. Submitting it is refused, and the refusal follows a language switch.
      await card.getByRole('button', { name: m.content.review.submit }).click();
      await card.locator('[role="alert"]').getByText(refusal(locale)).waitFor();
      await switchLocale(page, other);
      await card.locator('[role="alert"]').getByText(refusal(other)).waitFor();
      await switchLocale(page, locale);
      await card.locator('[role="alert"]').getByText(refusal(locale)).waitFor();

      // 4–5. A valid question is added: the refusal no longer applies and is gone (once the question list has reloaded).
      await addQuestion(page, locale);
      await card.locator('[role="alert"]').first().waitFor({ state: 'detached', timeout: 5_000 });
      assert.equal(await card.locator('[role="alert"]').count(), 0, 'the obsolete refusal is gone');
      assert.equal(await card.getByText(refusal(locale)).count(), 0);

      // A genuine refusal still appears: remove the only question and submit again (the API rule is unchanged).
      await page.getByRole('button', { name: new RegExp(`^${m.quiz.bank.remove}\\b`) }).click();
      await page.getByText(m.quiz.bank.removed(1)).waitFor();
      await card.getByRole('button', { name: m.content.review.submit }).click();
      await card.locator('[role="alert"]').getByText(refusal(locale)).waitFor();
      await addQuestion(page, locale);
      await card.locator('[role="alert"]').first().waitFor({ state: 'detached', timeout: 5_000 });
      assert.equal(await card.locator('[role="alert"]').count(), 0, 'the refusal clears again');

      // 6. The quiz is submitted.
      await card.getByRole('button', { name: m.content.review.submit }).click();
      await card.getByText(m.content.review.submitted).waitFor();
      assert.deepEqual(await leaks(page, locale), []);
      await page.context().close();

      // 7. A different, authorized Design Team member approves it.
      const reviewer = await open('reviewer', locale, quizPath);
      await reviewCard(reviewer).getByRole('button', { name: m.content.review.approve, exact: true }).click();
      await reviewCard(reviewer).getByText(m.content.review.approved).waitFor();
      await reviewer.context().close();

      // 8. The student can start the approved quiz.
      const quizId = quizPath.split('/activities/')[1]!;
      const { content } = await apiGet<{ content: { attemptLimit: number } }>('student', `/courses/${courseId}/activities/${quizId}`);
      const student = await open('student', locale, quizPath);
      await student.getByRole('button', { name: m.quiz.student.start }).click();
      await student.waitForURL(/\/attempts\//);
      await student.locator('main h1').waitFor();
      assert.equal(await student.locator('main h1').innerText(), m.quiz.attempt.title(1, content.attemptLimit));
      await student.context().close();
    });
  }
});
