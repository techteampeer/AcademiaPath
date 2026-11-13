/**
 * AP-030D guided demo tutor in the browser (run through e2e/run.sh against the production build and the demo seed):
 * course-aware suggestions, lesson context from a lesson page, explanations with links to the course material,
 * practice with correct and incorrect feedback, the unsupported-question fallback, English, Spanish and switching
 * language mid-conversation, who may use it, keyboard use, screen-reader structure, a 390 px phone, and no request
 * leaving the application.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { apiGet, BASE, context, launch, leaks, MESSAGES, settle, type Locale, type Role } from './support.ts';

const EN = MESSAGES.en.tutor;
const ES = MESSAGES.es.tutor;
let browser: Browser;
const courses = {} as Record<'itil' | 'pmf' | 'iai' | 'draft', string>;
const lessons = {} as Record<'principles' | 'dimensions' | 'submitted' | 'supervised', string>;

async function open(role: Role, path: string, locale: Locale = 'en', width = 1440): Promise<Page> {
  const page = await (await context(browser, locale, role, { width })).newPage();
  await page.goto(`${BASE}${path}`);
  await settle(page);
  return page;
}

/** Waits for the tutor's first response (the course- or lesson-aware greeting). */
async function ready(page: Page) {
  await page.locator('[role="log"] article').first().waitFor({ timeout: 15_000 });
  await page.locator('[role="status"]', { hasText: /preparing|preparando/ }).waitFor({ state: 'detached' });
}

const turns = (page: Page) => page.locator('[role="log"] article');
const chip = (page: Page, label: string) => page.getByRole('group', { name: /next|ahora/ }).getByRole('button', { name: label, exact: true });

async function choose(page: Page, label: string) {
  const count = await turns(page).count();
  await chip(page, label).click();
  await turns(page).nth(count).waitFor();
  return turns(page).nth(count);
}

before(async () => {
  browser = await launch();
  const list = await apiGet<{ items: Array<{ id: string; code: string }> }>('instructor', '/courses?limit=100');
  const id = (code: string) => list.items.find((course) => course.code === code)?.id;
  courses.itil = id('ITIL4-F-2026-2-A')!;
  courses.pmf = id('PMF-2026-2-A')!;
  courses.draft = id('ITIL4-F-2026-2-B')!;
  courses.iai = (await apiGet<{ items: Array<{ id: string; code: string }> }>('student', '/courses?limit=100')).items.find((c) => c.code === 'IAI-2026-2-A')!.id;
  const find = async (course: string, title: string, role: Role = 'instructor') => {
    const sections = await apiGet<{ items: Array<{ id: string }> }>(role, `/courses/${course}/sections?limit=100`);
    for (const section of sections.items) {
      const items = await apiGet<{ items: Array<{ id: string; title: string }> }>(role, `/courses/${course}/sections/${section.id}/activities?limit=100`);
      const match = items.items.find((a) => a.title === title);
      if (match) return match.id;
    }
    throw new Error(`activity not found: ${title}`);
  };
  lessons.principles = await find(courses.itil, 'Guiding principles in practice');
  lessons.dimensions = await find(courses.itil, 'The four dimensions of service management');
  lessons.submitted = await find(courses.itil, 'Change enablement');
  lessons.supervised = await find(courses.iai, 'Aprendizaje supervisado y no supervisado', 'student');
});
after(() => browser?.close());

describe('guided demo tutor (AP-030D)', () => {
  it('19a. a student opens the course tutor: course-aware greeting, guided-demo label, suggestions, lessons to focus on', async () => {
    const page = await open('student', `/courses/${courses.itil}/tutor`);
    await ready(page);
    assert.equal(await page.locator('main h1').innerText(), EN.heading);
    await page.getByText(EN.badge, { exact: true }).waitFor();
    assert.match(await turns(page).first().innerText(), /guided demo tutor for ITIL 4 Foundation/);
    for (const action of ['review', 'summarize', 'practice', 'next', 'material', 'quiz_prep'] as const) {
      assert.equal(await chip(page, EN.actions[action]).isVisible(), true, action);
    }
    const options = await page.locator('#tutor-lesson option').allInnerTexts();
    assert.ok(options.includes('Guiding principles in practice') && options.includes('Service value chain overview'));
    assert.ok(!options.includes('Change enablement'), 'unapproved content is not offered');
    assert.deepEqual(await leaks(page, 'en'), []);
    await page.context().close();
  });

  it('2, 8, 12. from a lesson: explain, simpler and the quoted material links to the lesson the student can open', async () => {
    const page = await open('student', `/courses/${courses.itil}/activities/${lessons.principles}`);
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.getByRole('link', { name: EN.askAboutLesson }).click();
    await page.waitForURL(/\/tutor\?activity=/);
    await ready(page);
    assert.equal(await page.locator('#tutor-lesson').inputValue(), lessons.principles);
    assert.match(await turns(page).first().innerText(), /You are studying “Guiding principles in practice”/);
    const before = requests.filter((url) => url.includes('/tutor/guide')).length;
    const explain = await choose(page, EN.actions.explain);
    assert.equal(requests.filter((url) => url.includes('/tutor/guide')).length, before + 1, 'one request per click');
    assert.match(await explain.locator('blockquote').first().innerText(), /The guiding principles are recommendations/);
    assert.equal(await explain.locator('blockquote span[lang="en"]').count() > 0, true);
    const simpler = await choose(page, EN.actions.simpler);
    assert.ok((await simpler.locator('ul li').allInnerTexts()).includes('keep it simple and practical'));
    // Changing the lesson changes the context of the next answer.
    await page.locator('#tutor-lesson').selectOption(lessons.dimensions);
    await turns(page).nth(3).waitFor();
    assert.match(await turns(page).nth(3).innerText(), /You are studying “The four dimensions of service management”/);
    const other = await choose(page, EN.actions.explain);
    assert.match(await other.locator('blockquote').first().innerText(), /four dimensions/i);
    // References open the material itself.
    await other.getByRole('link', { name: 'The four dimensions of service management' }).click();
    await page.waitForURL(new RegExp(`/activities/${lessons.dimensions}$`));
    await settle(page);
    assert.equal(await page.locator('main h1').innerText(), 'The four dimensions of service management');
    await page.context().close();
  });

  it('10–11. practice questions: the correct answer is confirmed, a wrong one is explained with the lesson to review', async () => {
    const page = await open('student', `/courses/${courses.itil}/tutor?activity=${lessons.principles}`);
    await ready(page);
    const first = await choose(page, EN.actions.practice);
    await first.getByRole('radio', { name: 'guiding principles' }).check();
    await first.getByRole('button', { name: EN.check }).click();
    await first.getByText(/^Correct! That is exactly what the material says:/).waitFor();
    assert.match(await first.innerText(), new RegExp(`guiding principles\\s*\\(${EN.correctAnswer}\\)`));
    assert.equal(await first.getByRole('button', { name: EN.check }).count(), 0, 'one answer per question');
    // Start over gives the same first question; this time answer it wrongly.
    await page.getByRole('button', { name: EN.restart }).click();
    await page.waitForFunction(() => document.querySelectorAll('[role="log"] article').length === 1);
    const again = await choose(page, EN.actions.practice);
    const options = await again.getByRole('radio').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).labels?.[0]?.innerText.trim() ?? ''));
    const choice = options.find((text) => text !== 'guiding principles')!;
    await again.getByRole('radio', { name: choice, exact: true }).check();
    await again.getByRole('button', { name: EN.check }).click();
    await again.getByText(new RegExp(`Not quite — you chose “${choice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}”`)).waitFor();
    assert.match(await again.innerText(), /Review “Guiding principles in practice” to reinforce it\./);
    assert.match(await again.innerText(), new RegExp(`\\(${EN.yourAnswer}\\)`));
    // Without choosing, the form asks for an answer instead of sending anything.
    const third = await choose(page, EN.actions.practice);
    await third.getByRole('button', { name: EN.check }).click();
    await third.getByText(EN.chooseOption).waitFor();
    await page.context().close();
  });

  it('9. an unsupported question gets the clear fallback, never an invented answer', async () => {
    const page = await open('student', `/courses/${courses.pmf}/tutor`);
    await ready(page);
    await page.getByLabel(EN.question).fill('What is the capital of France?');
    await page.getByRole('button', { name: EN.ask, exact: true }).click();
    const answer = turns(page).nth(1);
    await answer.waitFor();
    await answer.getByText(EN.notFound, { exact: true }).waitFor();
    assert.match(await answer.innerText(), /could not find that topic/);
    assert.equal(await answer.locator('blockquote').count(), 0);
    assert.equal(await page.getByLabel(EN.question).inputValue(), '', 'the question is cleared, not kept');
    // An empty question is refused in the browser.
    await page.getByRole('button', { name: EN.ask, exact: true }).click();
    await page.getByText(EN.empty, { exact: true }).waitFor();
    await page.context().close();
  });

  it('6. Spanish: interface and tutor wording in Spanish around the Spanish course material', async () => {
    const page = await open('student', `/courses/${courses.iai}/tutor?activity=${lessons.supervised}`, 'es');
    await ready(page);
    assert.equal(await page.locator('main h1').innerText(), ES.heading);
    await page.getByText(ES.badge, { exact: true }).waitFor();
    const explain = await choose(page, ES.actions.explain);
    assert.match(await explain.innerText(), /Así lo explica «Aprendizaje supervisado y no supervisado»/);
    assert.match(await explain.locator('blockquote').first().innerText(), /aprendizaje supervisado/i);
    // Free text in Spanish is recognised too.
    await page.getByLabel(ES.question).fill('¿Cómo me preparo para el cuestionario?');
    await page.getByRole('button', { name: ES.ask, exact: true }).click();
    const quiz = turns(page).nth(2);
    await quiz.waitFor();
    assert.match(await quiz.innerText(), /Cuestionarios de este curso/);
    assert.deepEqual(await leaks(page, 'es'), []);
    await page.context().close();
  });

  it('5, 7. switching language keeps the lesson and the conversation; new responses follow the new language', async () => {
    const page = await open('student', `/courses/${courses.itil}/tutor?activity=${lessons.principles}`);
    await ready(page);
    await choose(page, EN.actions.explain);
    await page.locator('button[lang="es"][aria-pressed="false"]:visible').first().click();
    await page.locator('main h1', { hasText: ES.heading }).waitFor();
    assert.equal(await page.locator('#tutor-lesson').inputValue(), lessons.principles, 'lesson context kept');
    assert.equal(await turns(page).count(), 2, 'conversation kept');
    await turns(page).nth(1).getByText('Respuesta dada en inglés').waitFor();
    const simpler = await choose(page, ES.actions.simpler);
    assert.match(await simpler.innerText(), /En menos palabras — la oración central:/);
    assert.match(await simpler.innerText(), /Menciona 7 partes:/);
    // English material is shown as written and labelled, not translated.
    assert.match(await simpler.innerText(), /El material del curso está en inglés; se muestra tal como fue escrito, sin traducir\./);
    assert.ok((await simpler.locator('ul[lang="en"] li').allInnerTexts()).includes('keep it simple and practical'));
    await page.context().close();
  });

  it('13–14. who may use it: the design team and administrators do not; draft courses and unapproved lessons stay hidden', async () => {
    for (const role of ['reviewer', 'admin'] as const) {
      const page = await open(role, `/courses/${courses.itil}/tutor`);
      await page.getByText(EN.unavailable).waitFor();
      assert.equal(await page.locator('[role="log"]').count(), 0, role);
      await page.context().close();
    }
    const draft = await open('student', `/courses/${courses.draft}/tutor`);
    await draft.getByText(EN.unavailable).waitFor();
    await draft.context().close();
    // A guessed id of submitted (unapproved) content falls back to the whole course with an explanation.
    const guessed = await open('student', `/courses/${courses.itil}/tutor?activity=${lessons.submitted}`);
    await guessed.getByText(EN.lessonUnavailable).waitFor();
    await ready(guessed);
    assert.equal(await guessed.locator('#tutor-lesson').inputValue(), '');
    assert.ok(!(await guessed.locator('main').innerText()).includes('Change enablement'));
    await guessed.context().close();
    // The non-editing instructor keeps tutor access.
    const ta = await open('ta', `/courses/${courses.itil}/tutor`);
    await ready(ta);
    await ta.context().close();
  });

  it('17, 19, 20. a 390 px phone with the keyboard only: no overflow, focus follows the answer, no external requests', async () => {
    const page = await open('student', `/courses/${courses.itil}/tutor?activity=${lessons.principles}`, 'en', 390);
    const hosts = new Set<string>();
    page.on('request', (request) => hosts.add(new URL(request.url()).host));
    await ready(page);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok((await overflow()) <= 0, 'no horizontal scrolling');
    // Keyboard: reach a suggestion with Tab and press Enter; focus moves to the new response.
    const target = chip(page, EN.actions.example);
    await target.focus();
    await page.keyboard.press('Enter');
    await turns(page).nth(1).waitFor();
    await page.waitForFunction(() => document.activeElement?.id.startsWith('tutor-turn-'));
    await page.keyboard.press('Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
    // Practice by keyboard: arrow keys choose, Enter on the button checks.
    await chip(page, EN.actions.practice).focus();
    await page.keyboard.press('Enter');
    const practice = turns(page).nth(2);
    await practice.getByRole('radio').first().waitFor();
    await practice.getByRole('radio').first().focus();
    await page.keyboard.press('Space');
    await practice.getByRole('button', { name: EN.check }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id.startsWith('tutor-feedback-'));
    assert.match(await practice.innerText(), /Correct!|Not quite/);
    assert.ok((await overflow()) <= 0, 'still no horizontal scrolling after answers');
    // Screen-reader structure: a named log, labelled controls, and a named group of suggestions.
    assert.equal(await page.getByRole('log', { name: EN.conversation }).count(), 1);
    assert.equal(await page.getByLabel(EN.lesson).count(), 1);
    assert.equal(await page.getByLabel(EN.question).count(), 1);
    assert.equal(await page.getByRole('group', { name: EN.suggestions }).count(), 1);
    assert.deepEqual([...hosts].filter((host) => host !== new URL(BASE).host), [], 'every request stays on the application');
    await page.context().close();
  });
});
