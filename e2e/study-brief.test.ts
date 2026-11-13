/**
 * AP-031D document study briefs in the browser (run through e2e/run.sh against the production build and the demo seed,
 * which uploads real PDF and DOCX documents): the "Create study brief" action, the brief and its quoted, located
 * content, links back to the document, English, Spanish and switching language, documents without text, markup in a
 * document, who may open a brief, a 390 px phone with the keyboard, accessibility structure and no external requests.
 * Edge-case documents are uploaded through the API as the instructor (they stay unapproved drafts).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { makeDocx, makePdf, makePptx } from '../apps/api/test/helpers/documents.ts';
import { API, apiGet, BASE, context, launch, leaks, MESSAGES, session, settle, type Locale, type Role } from './support.ts';

const EN = MESSAGES.en.documents.brief;
const ES = MESSAGES.es.documents.brief;
let browser: Browser;
const courses = {} as Record<'itil' | 'pmf' | 'iai', string>;
const docs = {} as Record<'itil' | 'pmf' | 'iai' | 'scanned' | 'markup' | 'long' | 'deck', string>;

async function open(role: Role, path: string, locale: Locale = 'en', width = 1440): Promise<Page> {
  const ctx = await context(browser, locale, role, { width });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  await page.goto(`${BASE}${path}`);
  await settle(page);
  return page;
}
const briefPath = (course: string, activity: string) => `/courses/${course}/activities/${activity}/brief`;
const article = (page: Page) => page.locator('article[aria-labelledby="brief-main-heading"]');

async function upload(course: string, section: string, fileName: string, data: Buffer, title: string): Promise<string> {
  const { cookies, csrfToken } = await session('instructor');
  const form = new FormData();
  form.append('title', title);
  form.append('file', new Blob([new Uint8Array(data)]), fileName);
  const res = await fetch(`${API}/courses/${course}/sections/${section}/documents`, {
    method: 'POST',
    headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '), origin: BASE, 'x-csrf-token': csrfToken },
    body: form,
  });
  if (res.status !== 201) throw new Error(`upload ${fileName}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { activityId: string }).activityId;
}

before(async () => {
  browser = await launch();
  const list = (await apiGet<{ items: Array<{ id: string; code: string }> }>('instructor', '/courses?limit=100')).items;
  courses.itil = list.find((c) => c.code === 'ITIL4-F-2026-2-A')!.id;
  courses.pmf = list.find((c) => c.code === 'PMF-2026-2-A')!.id;
  courses.iai = (await apiGet<{ items: Array<{ id: string; code: string }> }>('student', '/courses?limit=100')).items.find((c) => c.code === 'IAI-2026-2-A')!.id;
  const find = async (course: string, title: string, role: Role = 'instructor') => {
    for (const section of (await apiGet<{ items: Array<{ id: string }> }>(role, `/courses/${course}/sections?limit=100`)).items) {
      const match = (await apiGet<{ items: Array<{ id: string; title: string }> }>(role, `/courses/${course}/sections/${section.id}/activities?limit=100`)).items.find((a) => a.title === title);
      if (match) return match.id;
    }
    throw new Error(`activity not found: ${title}`);
  };
  docs.itil = await find(courses.itil, 'Service value chain overview');
  docs.pmf = await find(courses.pmf, 'Project charter guide');
  docs.iai = await find(courses.iai, 'Guía de evaluación de modelos', 'student');
  const section = (await apiGet<{ items: Array<{ id: string }> }>('instructor', `/courses/${courses.itil}/sections?limit=100`)).items[0]!.id;
  docs.scanned = await upload(courses.itil, section, 'scanned-handout.pdf', makePdf([[], []]), 'Scanned handout (draft)');
  docs.markup = await upload(
    courses.itil,
    section,
    'markup.docx',
    makeDocx([
      'The service desk is the single point of contact <img src=x onerror="window.__xss=1"> between the provider and its users.',
      'Service requests are formal user requests for something to be provided, such as a new laptop or access to a system.',
      'The service desk records every request and routes it to the responsible team as quickly as possible.',
    ]),
    'Markup check (draft)',
  );
  // Longer than the brief's 120,000-character limit, so the brief is partial.
  docs.long = await upload(
    courses.itil,
    section,
    'long-handout.docx',
    makeDocx(Array.from({ length: 1_500 }, (_, n) => `Paragraph ${n} explains how the service desk records request ${n} and routes it to the right team.`)),
    'Long handout (draft)',
  );
  // 30 slides of short bullets: shown as text excerpts, of which only the first 8 fit in the brief.
  docs.deck = await upload(
    courses.itil,
    section,
    'bullet-deck.pptx',
    makePptx(Array.from({ length: 30 }, (_, n) => [`Topic ${n + 1}`, `Short bullet ${n + 1}`, `Another item ${n + 1}`])),
    'Bullet deck (draft)',
  );
});
after(() => browser?.close());

describe('document study briefs (AP-031D)', () => {
  it('1, 3, 4. from the document, a student creates a study brief: quoted, located, clearly not AI-written', async () => {
    const page = await open('student', `/courses/${courses.itil}/activities/${docs.itil}`);
    const requests: string[] = [];
    page.on('request', (request) => request.url().includes('/document/brief') && requests.push(request.url()));
    await page.getByRole('link', { name: EN.create }).click();
    await page.waitForURL(/\/brief$/);
    await settle(page);
    assert.equal(await page.locator('main h1').innerText(), `${EN.heading}: Service value chain overview`);
    await page.getByText(EN.badge, { exact: true }).waitFor();
    const overview = page.locator('section[aria-labelledby="brief-overview"] blockquote');
    assert.match(await overview.first().innerText(), /^The service value chain is an operating model/);
    assert.equal(await overview.first().getAttribute('lang'), 'en');
    assert.equal(await page.locator('section[aria-labelledby="brief-concepts"] dt').first().innerText(), 'service value chain');
    await page.getByRole('link', { name: EN.openLocation('page 1') }).first().waitFor();
    const review = page.locator('section[aria-labelledby="brief-review"]');
    assert.match(await review.innerText(), /Explain “service value chain” in your own words/);
    await review.getByText(EN.showItems).click();
    assert.ok((await review.locator('details li').allInnerTexts()).includes('deliver and support'));
    await page.getByRole('heading', { name: EN.tips }).waitFor();
    await page.getByText(EN.tipsNote).waitFor();
    assert.equal(requests.length, 1, 'one request builds the brief');
    assert.deepEqual(await leaks(page, 'en'), []);
    await page.context().close();
  });

  it('2, 4. the location links return to the original document at that page', async () => {
    const page = await open('student', briefPath(courses.itil, docs.itil));
    await page.getByRole('link', { name: EN.backToDocument }).waitFor();
    await page.getByRole('link', { name: EN.openLocation('page 1') }).first().click();
    await page.waitForURL(new RegExp(`/activities/${docs.itil}#segment-0$`));
    await page.waitForFunction(() => document.activeElement?.id === 'segment-0');
    assert.match(await page.locator('#segment-0').innerText(), /The service value chain is an operating model/);
    await page.context().close();
  });

  it('2. a Word document: headings become the main topics', async () => {
    const page = await open('student', briefPath(courses.pmf, docs.pmf));
    const topics = page.locator('section[aria-labelledby="brief-topics"]');
    assert.deepEqual(await topics.locator('ol li a').allInnerTexts(), ['What to include', 'Common mistakes']);
    assert.match(await topics.innerText(), /Paragraph 3/);
    await page.context().close();
  });

  it('13, 14. Spanish: the interface in Spanish, the Spanish document as written; switching language keeps the brief', async () => {
    const es = await open('student', briefPath(courses.iai, docs.iai), 'es');
    assert.equal(await es.locator('main h1').innerText(), `${ES.heading}: Guía de evaluación de modelos`);
    assert.match(await es.locator('section[aria-labelledby="brief-overview"] blockquote').first().innerText(), /^Esta guía resume los pasos básicos/);
    assert.deepEqual(await leaks(es, 'es'), []);
    await es.context().close();
    // English interface, Spanish document: labelled, not translated; switching language does not refetch or change it.
    const page = await open('student', briefPath(courses.iai, docs.iai), 'en');
    const requests: string[] = [];
    page.on('request', (request) => request.url().includes('/document/brief') && requests.push(request.url()));
    await page.getByText(EN.sourceLanguage('Spanish')).waitFor();
    const before = await article(page).locator('blockquote').allInnerTexts();
    assert.equal(await article(page).locator('blockquote').first().getAttribute('lang'), 'es');
    await page.locator('button[lang="es"][aria-pressed="false"]:visible').first().click();
    await page.getByRole('heading', { name: ES.overview }).waitFor();
    assert.deepEqual(await article(page).locator('blockquote').allInnerTexts(), before);
    assert.equal(requests.length, 0, 'the brief is kept, not rebuilt');
    await page.getByText(ES.badge, { exact: true }).waitFor();
    await page.context().close();
  });

  it('6, 8. a document without selectable text explains why there is no brief and how to read it', async () => {
    const page = await open('instructor', briefPath(courses.itil, docs.scanned));
    await page.getByText(EN.limitations.no_text).waitFor();
    await page.getByText(EN.noTextRecovery).waitFor();
    await page.getByRole('link', { name: MESSAGES.en.documents.panel.download }).waitFor();
    assert.equal(await article(page).count(), 0);
    assert.equal(await page.getByRole('button', { name: EN.copy }).count(), 0);
    await page.context().close();
  });

  it('20. markup inside a document is shown as text, never run', async () => {
    const page = await open('instructor', briefPath(courses.itil, docs.markup));
    await page.getByText(EN.versionWorking).first().waitFor();
    assert.ok((await article(page).innerText()).includes('<img src=x onerror="window.__xss=1">'));
    assert.equal(await article(page).locator('img').count(), 0);
    assert.equal(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss ?? 0), 0);
    await page.context().close();
  });

  it('15–17. students cannot open briefs of unapproved documents; the design team and non-editing instructors can', async () => {
    const student = await open('student', briefPath(courses.itil, docs.markup));
    await student.getByText(EN.notAvailable).waitFor();
    assert.ok(!(await student.locator('main').innerText()).includes('service desk'));
    await student.context().close();
    for (const role of ['reviewer', 'ta'] as const) {
      const page = await open(role, briefPath(courses.itil, docs.markup));
      await page.getByText(EN.versionWorking).first().waitFor();
      await page.context().close();
    }
  });

  it('19, 23, 24. a 390 px phone with the keyboard: no overflow, copy works, structure is labelled, nothing leaves the app', async () => {
    const page = await open('student', briefPath(courses.itil, docs.itil), 'en', 390);
    const hosts = new Set<string>();
    page.on('request', (request) => hosts.add(new URL(request.url()).host));
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'no horizontal scrolling');
    // Keyboard: reach the copy button with Tab and press Enter.
    await page.getByRole('link', { name: EN.backToDocument }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), EN.copy);
    await page.keyboard.press('Enter');
    await page.getByRole('status').filter({ hasText: EN.copied }).waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /^Study brief: Service value chain overview\nSelected from the document — not written by AI/);
    assert.match(copied, /“The service value chain is an operating model[^”]+” \(Page 1\)/);
    for (const id of ['brief-overview', 'brief-concepts', 'brief-excerpts', 'brief-review', 'brief-topics', 'brief-tips', 'brief-about']) {
      assert.equal(await page.locator(`section[aria-labelledby="${id}"] h2#${id}`).count(), 1, id);
    }
    assert.equal(await page.locator('main h1').count(), 1);
    assert.deepEqual([...hosts].filter((host) => host !== new URL(BASE).host), []);
    await page.context().close();
  });

  type BriefData = {
    brief: { limitations: Array<{ code: string; processed: number | null; total: number | null }>; coverage: { processedSegments: number; totalSegments: number; processedCharacters: number } };
  };
  const number = (value: number, locale: Locale) => value.toLocaleString(locale === 'es' ? 'es-PE' : 'en-US');
  async function copyBrief(page: Page, locale: Locale): Promise<string> {
    const M = MESSAGES[locale].documents.brief;
    await page.getByRole('button', { name: M.copy }).click();
    await page.getByRole('status').filter({ hasText: M.copied }).waitFor();
    return page.evaluate(() => navigator.clipboard.readText());
  }

  it('copying keeps the coverage: a partial brief says partial, lists its limits and what was inspected (EN and ES)', async () => {
    const data = await apiGet<BriefData>('instructor', `/courses/${courses.itil}/activities/${docs.long}/document/brief`);
    const limit = data.brief.limitations.find((item) => item.code === 'brief_limit')!;
    assert.ok(limit, JSON.stringify(data.brief.limitations));
    for (const locale of ['en', 'es'] as const) {
      const M = MESSAGES[locale].documents.brief;
      const page = await open('instructor', briefPath(courses.itil, docs.long), locale);
      const limitText = M.limitations.brief_limit(number(limit.processed!, locale), number(limit.total!, locale));
      await page.getByText(M.partial, { exact: true }).waitFor();
      await page.getByText(limitText).waitFor();
      const { coverage: c } = data.brief;
      const coverage = M.coverage(c.processedSegments, MESSAGES[locale].documents.segments.paragraph(c.totalSegments), number(c.processedCharacters, locale));
      assert.ok(c.processedSegments < c.totalSegments, 'only part of the paragraphs fit in the brief');
      assert.ok((await page.locator('section[aria-labelledby="brief-about"]').innerText()).includes(coverage));
      const copied = await copyBrief(page, locale);
      // The copied header states exactly what the page states: partial, why, and what was inspected.
      assert.deepEqual(copied.split('\n\n')[0]!.split('\n'), [`${M.heading}: Long handout (draft)`, M.badge, M.statusLine.partial, M.partialIntro, `- ${limitText}`, coverage]);
      assert.ok(!copied.includes(M.statusLine.complete) && !copied.includes(M.complete));
      assert.deepEqual(await leaks(page, locale), []);
      await page.context().close();
    }
    // A complete brief says so when copied, with what was inspected and no partial notice.
    const page = await open('student', briefPath(courses.itil, docs.itil));
    const copied = await copyBrief(page, 'en');
    const head = copied.split('\n\n')[0]!.split('\n');
    assert.equal(head[2], EN.statusLine.complete);
    assert.match(head[3]!, /^Inspected 2 of 2 pages, [\d,]+ characters of extracted text\.$/);
    assert.ok(!copied.includes(EN.partialIntro));
    await page.context().close();
  });

  it('text excerpts of 30 slides: the page and the copied text say 8 of the 30 are shown, and what was inspected', async () => {
    const data = await apiGet<BriefData>('instructor', `/courses/${courses.itil}/activities/${docs.deck}/document/brief`);
    for (const locale of ['en', 'es'] as const) {
      const M = MESSAGES[locale].documents.brief;
      const inspected = M.coverage(30, MESSAGES[locale].documents.segments.slide(30), number(data.brief.coverage.processedCharacters, locale));
      const page = await open('instructor', briefPath(courses.itil, docs.deck), locale);
      const section = page.locator('section[aria-labelledby="brief-excerpts-only"]');
      await section.waitFor();
      assert.equal(await section.locator('blockquote').count(), 8);
      assert.equal(await page.locator('#brief-excerpts-shown').innerText(), M.excerptsShown(8, 30));
      const about = await page.locator('section[aria-labelledby="brief-about"]').innerText();
      assert.ok(about.includes(inspected) && about.includes(M.excerptsShown(8, 30)), about);
      assert.equal(await page.getByText(M.complete).count(), 0);
      const copied = await copyBrief(page, locale);
      assert.deepEqual(copied.split('\n\n')[0]!.split('\n'), [`${M.heading}: Bullet deck (draft)`, M.badge, M.statusLine.excerpts_only, M.excerptsShown(8, 30), inspected]);
      assert.equal(copied.match(/^“.+” \(.+ \d+\)$/gm)?.length, 8);
      assert.deepEqual(await leaks(page, locale), []);
      await page.context().close();
    }
  });
});
