/**
 * AP-031D document study briefs. Unit tests of the deterministic, extractive brief engine on handcrafted extractions,
 * then API tests against a temporary PostgreSQL database with real PDF, DOCX and PPTX uploads (skipped unless
 * TEST_DATABASE_URL is set): grounding and references, failure and partial states, limits, languages, access by role,
 * no cross-user data, no network, no writes, and compatibility with the existing summary and the guided tutor.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { DEV_USERS, seedDevUsers } from '../../scripts/seed-dev-users.js';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { loadConfig } from '../../src/config.js';
import type { DocumentSegment } from '../../src/db/schema/index.js';
import { userCredentials, users } from '../../src/db/schema/index.js';
import { BRIEF_LIMITS, buildStudyBrief, headingLike, type BriefInput, type StudyBrief } from '../../src/documents/brief.js';
import { mockSummaryProvider } from '../../src/documents/summary.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';
import { makeDocx, makePdf, makePptx, multipartBody } from '../helpers/documents.js';

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();
const seg = (index: number, kind: DocumentSegment['kind'], text: string): DocumentSegment => ({
  index,
  kind,
  label: `${kind === 'page' ? 'Page' : kind === 'slide' ? 'Slide' : 'Paragraph'} ${index + 1}`,
  text,
});
const brief = (format: BriefInput['format'], segments: DocumentSegment[], extra: Partial<BriefInput> = {}) =>
  buildStudyBrief({ title: 'Course handout', fileName: `handout.${format}`, format, extractionStatus: segments.length ? 'extracted' : 'no_text', extractionDetail: null, truncated: false, segments, ...extra });

/** Every text in a brief is the document's own wording, located in the segment its reference names. */
function assertGrounded(result: StudyBrief, segments: DocumentSegment[]) {
  const source = (ref: { segmentIndex: number; label: string; kind: string }) => {
    const segment = segments.find((item) => item.index === ref.segmentIndex);
    assert.ok(segment, `reference to a block that does not exist: ${JSON.stringify(ref)}`);
    assert.equal(ref.label, segment.label, 'labels are the extraction’s own');
    assert.equal(ref.kind, segment.kind);
    return collapse(segment.text);
  };
  // "…" marks only an omission (a shortened block, or one a removed line interrupted); the rest is contiguous source text.
  for (const item of [...result.overview, ...result.excerpts]) assert.ok(source(item.ref).includes(collapse(item.text.replace(/^…|…$/g, ''))), item.text);
  for (const concept of result.concepts) {
    assert.ok(source(concept.ref).includes(collapse(concept.text)), concept.text);
    assert.ok(concept.text.includes(concept.term));
  }
  for (const heading of result.outline) assert.ok(source(heading.ref).includes(heading.text), heading.text);
  for (const point of result.reviewPoints) {
    const text = source(point.ref);
    if (point.term) assert.ok(text.includes(point.term), point.term);
    for (const item of point.items) assert.ok(text.includes(item), item);
  }
  const all = collapse(segments.map((segment) => segment.text).join(' ')).toLowerCase();
  for (const keyword of result.keywords) assert.ok(all.includes(keyword.toLowerCase()), keyword);
}

const ITIL_PAGES = [
  'Service value chain overview\nThe service value chain is an operating model that describes the key activities\nrequired to respond to demand and facilitate value realization.\nIt has six value chain activities: plan, improve, engage, design and transition,\nobtain or build, and deliver and support.\nPlan ensures a shared understanding of the vision, current status and improvement\ndirection for all four dimensions and all products and services.',
  'Value streams\nValue streams combine value chain activities in a specific order to respond to a\nparticular type of demand.\nA value stream for restoring a failed online enrolment service would start with\nengage, move through deliver and support, and use improve to prevent recurrence.\nImprovement should be continual: every value stream should be reviewed with the\npeople who operate it.',
];

describe('study brief engine (unit)', () => {
  it('1, 3, 4, 5, 12. a short English PDF: overview, concept, list, excerpts — all quoted with the right page', () => {
    const segments = ITIL_PAGES.map((text, index) => seg(index, 'page', text));
    const result = brief('pdf', segments, { title: 'Service value chain overview' });
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.language, { primary: 'en', mixed: false });
    assert.equal(result.overview[0]!.text, 'The service value chain is an operating model that describes the key activities required to respond to demand and facilitate value realization.');
    assert.deepEqual(result.concepts.map((c) => [c.term, c.ref.label]), [['service value chain', 'Page 1']]);
    const list = result.reviewPoints.find((point) => point.kind === 'list')!;
    assert.deepEqual(list.items, ['plan', 'improve', 'engage', 'design and transition', 'obtain or build', 'deliver and support']);
    // The document title is recognised, not listed as a section; "Value streams" heads page 2.
    assert.deepEqual(result.outline.map((h) => [h.text, h.ref.label]), [['Value streams', 'Page 2']]);
    assert.ok(result.excerpts.length >= 2 && result.excerpts.length <= BRIEF_LIMITS.excerpts);
    assertGrounded(result, segments);
    assert.deepEqual(result.coverage, { processedSegments: 2, totalSegments: 2, processedCharacters: ITIL_PAGES.join('').length, totalCharacters: ITIL_PAGES.join('').length });
    // Deterministic.
    assert.deepEqual(brief('pdf', segments, { title: 'Service value chain overview' }), result);
  });

  it('2. sections: DOCX title-like paragraphs, slide titles and PDF title lines; never page numbers or sentences', () => {
    const docx = ['Project charter guide', 'A project charter formally authorizes a project and gives the project manager authority to use organizational resources.', 'What to include', 'A good charter states the business need, measurable objectives, high-level scope, key stakeholders, major milestones, summary budget and known risks.', 'Common mistakes', 'Charters that list tasks instead of outcomes, or that omit who approves the project, make later decisions difficult.'].map((text, index) => seg(index, 'paragraph', text));
    const fromDocx = brief('docx', docx, { title: 'Project charter guide' });
    assert.deepEqual(fromDocx.outline.map((h) => [h.text, h.ref.label]), [['What to include', 'Paragraph 3'], ['Common mistakes', 'Paragraph 5']]);
    assert.deepEqual(fromDocx.reviewPoints.filter((p) => p.kind === 'section').map((p) => p.term), ['What to include', 'Common mistakes']);
    assertGrounded(fromDocx, docx);
    const slides = [
      'Incident management\nIncident management restores normal service operation as quickly as possible after an interruption.',
      'Problem management\nProblem management reduces the likelihood and impact of incidents by identifying their actual causes.',
      'Change enablement\nChange enablement maximizes the number of successful service and product changes by assessing risk.',
    ].map((text, index) => seg(index, 'slide', text));
    const fromSlides = brief('pptx', slides);
    assert.deepEqual(fromSlides.outline.map((h) => h.text), ['Incident management', 'Problem management', 'Change enablement']);
    assertGrounded(fromSlides, slides);
    for (const line of ['Page 3', '12', 'Página 2 de 9', 'The service desk is the single point of contact.', 'and deliver and support', 'x']) assert.equal(headingLike(line), false, line);
    for (const line of ['What to include', '2.1 Scope and objectives', 'Evaluación del modelo']) assert.equal(headingLike(line), true, line);
  });

  it('6. an empty document or one without selectable text has no brief, and says so', () => {
    for (const result of [brief('pdf', []), brief('pdf', [], { extractionStatus: 'no_text', extractionDetail: 'No selectable text was found.' })]) {
      assert.equal(result.status, 'no_text');
      assert.deepEqual(result.limitations, [{ code: 'no_text', processed: null, total: null }]);
      assert.equal(result.overview.length + result.excerpts.length + result.concepts.length + result.outline.length, 0);
    }
  });

  it('9. partial extraction is labelled: truncated text, and PDF pages without selectable text', () => {
    const segments = ITIL_PAGES.map((text, index) => seg(index, 'page', text));
    const truncated = brief('pdf', segments, { truncated: true });
    assert.equal(truncated.status, 'partial');
    assert.deepEqual(truncated.limitations, [{ code: 'extraction_truncated', processed: null, total: null }]);
    const scanned = brief('pdf', segments, { extractionDetail: '2 of 5 pages contain selectable text; the others may be scanned images (OCR is not available).' });
    assert.equal(scanned.status, 'partial');
    assert.deepEqual(scanned.limitations, [{ code: 'pages_without_text', processed: 2, total: 5 }]);
  });

  it('10. very large documents: only the first 120,000 characters are used, the brief is partial and stays small and fast', () => {
    const pages = Array.from({ length: 240 }, (_, page) =>
      seg(page, 'page', Array.from({ length: 16 }, (_, n) => `Topic ${page * 16 + n} describes how team ${n} handles requests for service ${page}, for example by logging and resolving them.`).join('\n')),
    );
    const total = pages.reduce((sum, page) => sum + page.text.length, 0);
    const started = performance.now();
    const result = brief('pdf', pages);
    const elapsed = performance.now() - started;
    assert.ok(total > 400_000);
    assert.equal(result.status, 'partial');
    const limit = result.limitations.find((l) => l.code === 'brief_limit')!;
    assert.ok(limit.processed! <= BRIEF_LIMITS.characters && limit.total === total);
    assert.ok(result.coverage.processedSegments < result.coverage.totalSegments);
    assert.ok(JSON.stringify(result).length < 20_000, `${JSON.stringify(result).length} bytes`);
    assert.ok(elapsed < 1_500, `${elapsed} ms`);
    assertGrounded(result, pages);
    // One huge block is cut at a sentence end, never mid-sentence.
    const huge = brief('docx', [seg(0, 'paragraph', Array.from({ length: 3_000 }, (_, n) => `Sentence ${n} of this very long paragraph describes service management practice ${n}.`).join(' '))]);
    assert.equal(huge.status, 'partial');
    assert.ok(huge.coverage.processedCharacters <= BRIEF_LIMITS.characters);
  });

  it('11. duplicated paragraphs, repeated slides, running headers and page numbers are left out', () => {
    const paragraph = 'Incident management restores normal service operation as quickly as possible after an interruption.';
    const docx = [paragraph, 'The service desk captures demand for incident resolution and service requests from all users.', paragraph, paragraph].map((text, index) => seg(index, 'paragraph', text));
    const repeated = brief('docx', docx);
    assert.equal(repeated.cleanup.duplicateSentencesRemoved, 2);
    const texts = [...repeated.overview, ...repeated.excerpts].map((item) => item.text);
    assert.equal(new Set(texts).size, texts.length);
    const pdf = ITIL_PAGES.concat(ITIL_PAGES[1]!.replace('Value streams', 'Value streams again'), ITIL_PAGES[0]!).map((text, index, all) =>
      seg(index, 'page', `ITIL Foundation course handout\n${text}\nPage ${index + 1} of ${all.length}`),
    );
    const cleaned = brief('pdf', pdf);
    assert.ok(cleaned.cleanup.repeatedLinesRemoved >= 8, JSON.stringify(cleaned.cleanup));
    const shown = JSON.stringify([cleaned.outline, cleaned.overview, cleaned.excerpts]);
    assert.ok(!shown.includes('ITIL Foundation course handout') && !/Page \d of 4/.test(shown));
    assert.ok(cleaned.cleanup.duplicateSentencesRemoved > 0);
    assertGrounded(cleaned, pdf);
  });

  it('13. Spanish documents stay in Spanish; definitions with "es" are recognised', () => {
    const docx = [
      'La inteligencia artificial es el campo que estudia cómo construir sistemas que aprenden de los datos.',
      'El aprendizaje supervisado usa ejemplos etiquetados para entrenar modelos de clasificación.',
      'La matriz de confusión muestra cuántos casos se clasificaron correctamente y qué errores se cometieron.',
      'Además de la exactitud, se deben revisar la precisión y la exhaustividad para cada grupo de usuarios.',
    ].map((text, index) => seg(index, 'paragraph', text));
    const result = brief('docx', docx);
    assert.deepEqual(result.language, { primary: 'es', mixed: false });
    assert.deepEqual(result.concepts.map((c) => c.term), ['inteligencia artificial']);
    assert.ok([...result.overview, ...result.excerpts].every((item) => item.language === 'es'));
    assertGrounded(result, docx);
  });

  it('documents mixing English and Spanish are recognised as mixed, each excerpt with its own language', () => {
    const docx = [
      'Incident management restores normal service operation as quickly as possible after an interruption.',
      'The service desk captures demand for incident resolution and service requests from all users.',
      'La gestión de incidentes restablece el servicio normal lo antes posible después de una interrupción.',
      'La mesa de servicio registra las solicitudes de los usuarios y las deriva al equipo responsable.',
    ].map((text, index) => seg(index, 'paragraph', text));
    const result = brief('docx', docx);
    assert.equal(result.language.mixed, true);
    const languages = [...result.overview, ...result.excerpts].map((item) => [item.ref.label, item.language]);
    assert.ok(languages.some(([, language]) => language === 'en') && languages.some(([, language]) => language === 'es'), JSON.stringify(languages));
  });

  it('poorly structured text gives clearly marked excerpts instead of an invented summary', () => {
    const slides = [
      'Change enablement\nAssess risk\nAuthorize changes',
      'Change schedule\nPlan\nCommunicate',
      'Lessons\nReview often',
    ].map((text, index) => seg(index, 'slide', text));
    const result = brief('pptx', slides);
    assert.equal(result.status, 'excerpts_only');
    assert.equal(result.limitations.at(-1)!.code, 'few_sentences');
    assert.deepEqual(result.overview, []);
    assert.deepEqual(result.outline.map((h) => h.text), ['Change enablement', 'Change schedule', 'Lessons']);
    assert.ok(result.excerpts.length > 0 && result.excerpts.length <= BRIEF_LIMITS.fallbackBlocks);
    assertGrounded(result, slides);
  });

  it('linear time: 60,000 short lines in one page or slide (the most the brief limit allows) build a correct brief', () => {
    // Neighbouring lines used to be found by copying the line list for every line: about 14 s for this input. The
    // bound below is ~30 times the linear engine's local time, to stay meaningful without depending on machine speed.
    const shapes = [(n: number) => String.fromCharCode(97 + (n % 26)), (n: number) => `item${n}`, (n: number) => `Item ${n}`];
    for (const [format, kind] of [['pdf', 'page'], ['pptx', 'slide']] as const) {
      for (const shape of shapes) {
        const segments = [seg(0, kind, Array.from({ length: 60_000 }, (_, n) => shape(n)).join('\n'))];
        const started = performance.now();
        const result = brief(format, segments);
        const elapsed = performance.now() - started;
        assert.ok(elapsed < 1_500, `${format} ${shape(1)}: ${elapsed.toFixed(0)} ms`);
        assert.equal(result.status, 'excerpts_only');
        assert.ok(result.coverage.processedCharacters <= BRIEF_LIMITS.characters);
        // Beyond the character limit the brief says so; within it, nothing is claimed to be left out.
        const overLimit = segments[0]!.text.length > BRIEF_LIMITS.characters;
        assert.equal(result.limitations.some((l) => l.code === 'brief_limit'), overLimit);
        assertGrounded(result, segments);
      }
    }
  });

  it('a running header or page number inside a sentence never joins its two parts into one quote', () => {
    const header = 'ACME University Confidential';
    const pages = [
      'The incident management practice\nrestores normal service operation as quickly as possible after any disruption.',
      'Problem management reduces the likelihood and impact of incidents by identifying actual causes.',
      'Change enablement maximizes the number of successful service and product changes for customers.',
      'Service level management sets clear business based targets for service levels and measures them.',
    ].map((text, index) => seg(index, 'page', `${header}\n${text.replace('\n', `\n${header}\n`)}\n${index + 1}`));
    const result = brief('pdf', pages);
    const quoted = [...result.overview, ...result.excerpts, ...result.concepts].map((item) => item.text);
    assert.ok(quoted.length >= 3, JSON.stringify(quoted));
    // Neither the joined sentence nor either of its parts is quoted; every quote is contiguous on its page.
    assert.ok(!quoted.some((text) => /incident management practice|^restores normal/.test(text)), JSON.stringify(quoted));
    assert.equal(result.cleanup.repeatedLinesRemoved, 9); // 5 headers (two on page 1, inside the sentence) and 4 page numbers
    assertGrounded(result, pages);

    // A bare number on its own line is removed like a page number: "has 6 activities" must never become "has activities".
    const docx = [
      seg(0, 'paragraph', 'The service value chain has\n6\nactivities that work together to create value for customers.'),
      seg(1, 'paragraph', 'Each activity transforms specific inputs into outputs for the organization and its consumers.'),
      seg(2, 'paragraph', 'Value streams combine these activities in a specific order to respond to a particular demand.'),
    ];
    const numbers = brief('docx', docx);
    const texts = [...numbers.overview, ...numbers.excerpts, ...numbers.concepts].map((item) => item.text);
    assert.ok(texts.length >= 2 && !texts.some((text) => /has activities|^activities that/.test(text)), JSON.stringify(texts));
    assertGrounded(numbers, docx);

    // Text excerpts (little sentence structure): the two parts stay separate, each marked "…" where the line was removed.
    const slides = ['Change enablement\nassess the risk of\nInternal training only\neach change', 'Change schedule\nplan and\nInternal training only\ncommunicate', 'Lessons\nreview often\nInternal training only'].map((text, index) =>
      seg(index, 'slide', text),
    );
    const deck = brief('pptx', slides);
    assert.equal(deck.status, 'excerpts_only');
    assert.deepEqual(
      deck.excerpts.map((item) => [item.ref.label, item.text, item.shortened]),
      [
        ['Slide 1', 'assess the risk of…', true],
        ['Slide 1', '…each change', true],
        ['Slide 2', 'plan and…', true],
        ['Slide 2', '…communicate', true],
        ['Slide 3', 'review often', false],
      ],
    );
    assertGrounded(deck, slides);
  });

  it('text excerpts state how many blocks exist: 8 of 30 slides are shown, never implying every slide is in the brief', () => {
    const slides = Array.from({ length: 30 }, (_, n) => seg(n, 'slide', `Topic ${n + 1}\nShort bullet ${n + 1}\nAnother item ${n + 1}`));
    const result = brief('pptx', slides);
    assert.equal(result.status, 'excerpts_only');
    assert.equal(result.excerpts.length, BRIEF_LIMITS.fallbackBlocks);
    assert.equal(result.excerptsAvailable, 30);
    assert.equal(result.coverage.processedSegments, 30);
    assert.deepEqual(
      result.excerpts.map((item) => item.ref.label),
      Array.from({ length: 8 }, (_, n) => `Slide ${n + 1}`),
    );
    assertGrounded(result, slides);
    // A selection of sentences says how many distinct sentences it was chosen from.
    const selected = brief('pdf', ITIL_PAGES.map((text, index) => seg(index, 'page', text)));
    assert.equal(selected.status, 'complete');
    assert.ok(selected.excerptsAvailable >= selected.overview.length + selected.excerpts.length, `${selected.excerptsAvailable}`);
    assert.equal(brief('pdf', []).excerptsAvailable, 0);
  });

  it('20. markup in the document is returned as plain text, never interpreted or rewritten', () => {
    const text = 'The service desk is the <b>single point</b> of contact <script>alert("x")</script> between the provider and its users.';
    const segments = [seg(0, 'paragraph', text), seg(1, 'paragraph', 'Service requests are formal user requests for something to be provided by the service desk team.')];
    const result = brief('docx', segments);
    assert.ok(JSON.stringify(result).includes('<script>alert(\\"x\\")</script>'));
    assertGrounded(result, segments);
  });

  it('19. the brief code makes no network or model calls', async () => {
    for (const file of ['brief.ts', 'summary.ts']) {
      const source = await readFile(new URL(`../../src/documents/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /\bfetch\(|node:https?|from 'undici'|axios|vertex|openai|gemini|anthropic/i, file);
    }
  });

  it('22. the stored mock summary is unchanged by the shared sentence code', async () => {
    const segments = ITIL_PAGES.map((text, index) => seg(index, 'page', text));
    const first = await mockSummaryProvider.summarize({ segments, revision: 1 });
    const second = await mockSummaryProvider.summarize({ segments, revision: 2 });
    assert.equal(first.status, 'ready');
    assert.deepEqual([first.strategy, second.strategy], ['key_sentences', 'section_coverage']);
    for (const point of [...first.points, ...second.points]) assert.ok(collapse(segments[point.evidence.segmentIndex]!.text).includes(collapse(point.evidence.quote)));
  });
});

// ------------------------------------------------------------------------------------------------ API

const PASSWORD = randomBytes(18).toString('base64url');
const COOKIE = 'ap_session';
const WEB_ORIGIN = 'http://localhost:3000';
const EMAILS = {
  admin: DEV_USERS[0]!.email,
  instructor: DEV_USERS[1]!.email,
  student: DEV_USERS[2]!.email,
  reviewer: DEV_USERS[3]!.email,
  assistant: DEV_USERS[4]!.email,
  student2: 'student2@academiapath.example',
  otherInstructor: 'instructor2@academiapath.example',
} as const;
type Person = keyof typeof EMAILS;
type Brief = { activityId: string; courseId: string; title: string; version: string; generator: { id: string; mode: string }; document: { id: string; fileName: string; format: string }; brief: StudyBrief };

describe('study brief API (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof buildApp>;
  let storageDir: string;
  const sessions = new Map<Person, { token: string; csrf: string; userId: string }>();
  type Key = 'courseA' | 'courseB' | 'courseC' | 'introA' | 'hiddenA' | 'module2A' | 'introB' | 'introC' | 'pdf' | 'docxEs' | 'slides' | 'scanned' | 'partial' | 'draft' | 'hidden' | 'module2' | 'draftCourseDoc' | 'long';
  const ids = {} as Record<Key, string>;
  const outbound: string[] = [];

  const call = (who: Person | null, method: 'GET' | 'POST', url: string, options: { payload?: object; cookies?: Record<string, string> } = {}) => {
    const current = who ? sessions.get(who)! : null;
    return app.inject({
      method,
      url: `/api/v1${url}`,
      ...(options.payload ? { payload: options.payload } : {}),
      cookies: { ...(current ? { [COOKIE]: current.token } : {}), ...options.cookies },
      headers: method === 'POST' && current ? { 'x-csrf-token': current.csrf, origin: WEB_ORIGIN } : {},
    });
  };
  const ok = (res: LightMyRequestResponse, status = 200) => {
    assert.equal(res.statusCode, status, res.body);
    return res.json();
  };
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code);
  };
  const briefUrl = (course: string, activity: string) => `/courses/${course}/activities/${activity}/document/brief`;
  const getBrief = async (who: Person, course: string, activity: string) => ok(await call(who, 'GET', briefUrl(course, activity))) as Brief;
  const upload = async (course: string, section: string, filename: string, data: Buffer, title?: string) => {
    const current = sessions.get('instructor')!;
    const { payload, contentType } = multipartBody([...(title ? [{ name: 'title', value: title }] : []), { name: 'file', filename, data }]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/${course}/sections/${section}/documents`,
      payload,
      cookies: { [COOKIE]: current.token },
      headers: { 'content-type': contentType, 'x-csrf-token': current.csrf, origin: WEB_ORIGIN },
    });
    return ok(res, 201).activityId as string;
  };
  const approve = async (course: string, activity: string) => {
    ok(await call('instructor', 'POST', `/courses/${course}/activities/${activity}/submit`));
    ok(await call('reviewer', 'POST', `/courses/${course}/activities/${activity}/review`, { payload: { decision: 'approve' } }));
  };
  const fingerprint = async () =>
    (
      await database.pool.query(
        `SELECT concat_ws('|', (SELECT count(*) FROM audit_log), (SELECT count(*) FROM document_summaries), (SELECT count(*) FROM course_documents),
           (SELECT max(updated_at)::text FROM activities), (SELECT count(*) FROM activity_completions), (SELECT count(*) FROM tutor_usage)) AS f`,
      )
    ).rows[0].f as string;

  before(async () => {
    mock.method(globalThis, 'fetch', async (input: unknown) => {
      outbound.push(String(input));
      throw new Error('Outbound requests are not allowed in tests');
    });
    for (const module of [http, https]) {
      mock.method(module, 'request', (...args: unknown[]) => {
        outbound.push(String(args[0]));
        throw new Error('Outbound requests are not allowed in tests');
      });
    }
    storageDir = join(await mkdtemp(join(tmpdir(), 'ap-brief-test-')), 'store');
    database = await createTestDatabase();
    await seedDevUsers(database.db, PASSWORD);
    const passwordHash = await hashPassword(PASSWORD);
    for (const person of ['student2', 'otherInstructor'] as const) {
      const [user] = await database.db.insert(users).values({ email: EMAILS[person], givenName: 'Test', familyName: person }).returning();
      await database.db.insert(userCredentials).values({ userId: user!.id, passwordHash });
    }
    app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', APP_ORIGINS: WEB_ORIGIN, LOGIN_RATE_LIMIT_MAX: '1000', DOCUMENT_STORAGE_DIR: storageDir, DOCUMENT_MAX_UPLOAD_MB: '5' }),
      database: database.db,
    });
    await app.ready();
    for (const person of Object.keys(EMAILS) as Person[]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: EMAILS[person], password: PASSWORD }, headers: { origin: WEB_ORIGIN } });
      const body = ok(res);
      sessions.set(person, { token: res.cookies.find((c) => c.name === COOKIE)!.value, csrf: body.csrfToken, userId: body.user.id });
    }
    const program = ok(await call('admin', 'POST', '/programs', { payload: { code: 'ING-SIS', name: 'Ingeniería de Sistemas' } }), 201);
    const term = ok(await call('admin', 'POST', '/terms', { payload: { code: '2026-2', name: '2026-II', startsOn: '2026-08-17', endsOn: '2026-12-11' } }), 201);
    const template = ok(
      await call('admin', 'POST', '/course-templates', {
        payload: { code: 'ITIL-F', programId: program.id, title: 'ITIL Fundamentals', sections: [{ title: 'Introduction' }, { title: 'Instructor notes', isVisible: false }, { title: 'Module 2' }] },
      }),
      201,
    );
    const course = async (code: string, status: string) =>
      ok(await call('admin', 'POST', '/courses', { payload: { programId: program.id, termId: term.id, templateId: template.templateId, code, status } }), 201).id as string;
    ids.courseA = await course('ITIL-A', 'published');
    ids.courseB = await course('ITIL-B', 'published');
    ids.courseC = await course('ITIL-C', 'draft');
    const enroll = async (courseId: string, person: Person, role: string) => ok(await call('admin', 'POST', `/courses/${courseId}/enrollments`, { payload: { email: EMAILS[person], role } }), 201);
    for (const [person, role] of [['instructor', 'instructor'], ['reviewer', 'design_team'], ['assistant', 'non_editing_instructor'], ['student', 'student'], ['student2', 'student']] as const) {
      await enroll(ids.courseA, person, role);
    }
    await enroll(ids.courseB, 'otherInstructor', 'instructor');
    await enroll(ids.courseB, 'reviewer', 'design_team');
    await enroll(ids.courseC, 'instructor', 'instructor');
    await enroll(ids.courseC, 'reviewer', 'design_team');
    await enroll(ids.courseC, 'student', 'student');
    const sections = async (courseId: string) => ok(await call('admin', 'GET', `/courses/${courseId}/sections`)).items.map((s: { id: string }) => s.id) as string[];
    [ids.introA, ids.hiddenA, ids.module2A] = (await sections(ids.courseA)) as [string, string, string];
    [ids.introB] = (await sections(ids.courseB)) as [string];
    [ids.introC] = (await sections(ids.courseC)) as [string];

    ids.pdf = await upload(ids.courseA, ids.introA, 'service-value-chain.pdf', makePdf(ITIL_PAGES.map((page) => page.split('\n'))), 'Service value chain overview');
    await approve(ids.courseA, ids.pdf);
    ids.docxEs = await upload(
      ids.courseA,
      ids.introA,
      'guia.docx',
      makeDocx([
        'Guía de evaluación',
        'La inteligencia artificial es el campo que estudia cómo construir sistemas que aprenden de los datos.',
        'Métricas',
        'La matriz de confusión muestra cuántos casos se clasificaron correctamente y qué errores se cometieron.',
        'Además de la exactitud, se deben revisar la precisión y la exhaustividad para cada grupo de usuarios.',
      ]),
      'Guía de evaluación',
    );
    await approve(ids.courseA, ids.docxEs);
    ids.slides = await upload(ids.courseA, ids.introA, 'change.pptx', makePptx([['Change enablement', 'Change enablement maximizes the number of successful service and product changes.'], ['Change authority', 'Each change is assessed for risk and authorized by an appropriate change authority.']]));
    await approve(ids.courseA, ids.slides);
    ids.scanned = await upload(ids.courseA, ids.introA, 'scan.pdf', makePdf([[], []]), 'Scanned handout');
    await approve(ids.courseA, ids.scanned);
    ids.partial = await upload(ids.courseA, ids.introA, 'partial.pdf', makePdf([ITIL_PAGES[0]!.split('\n'), []]), 'Partly scanned handout');
    await approve(ids.courseA, ids.partial);
    ids.draft = await upload(ids.courseA, ids.introA, 'draft.docx', makeDocx(['Draft notes about the next module that students must not read before approval.', 'They describe an unannounced assessment in detail for the teaching team only.']), 'Draft notes');
    ids.hidden = await upload(ids.courseA, ids.hiddenA, 'facilitator.docx', makeDocx(['Facilitator notes describe how to run the workshop for the teaching team only.', 'Groups report back in five minutes with one example each from their own service.', 'The facilitator then compares the examples with the four dimensions of service management.']), 'Facilitator notes');
    await approve(ids.courseA, ids.hidden);
    ids.module2 = await upload(ids.courseA, ids.module2A, 'module2.docx', makeDocx(['Module two introduces continual improvement for every service the university provides.', 'Improvement is planned with measurable objectives and regular reviews by the people who run the service.', 'Each review records what changed and what the team will try next.']), 'Module 2 reading');
    await approve(ids.courseA, ids.module2);
    ids.draftCourseDoc = await upload(ids.courseC, ids.introC, 'c.docx', makeDocx(['A draft course document that enrolled students cannot open yet.', 'It becomes visible only when the course is published.']));
    await approve(ids.courseC, ids.draftCourseDoc);
    // A long document: more than the 400,000 characters extraction keeps, so it is truncated and the brief is partial.
    const long = Array.from({ length: 4_000 }, (_, n) => `Paragraph ${n} explains how the service desk records request ${n} and routes it to the responsible team quickly.`);
    ids.long = await upload(ids.courseA, ids.introA, 'long.docx', makeDocx(long), 'Very long handout');
    await approve(ids.courseA, ids.long);
  });

  after(async () => {
    mock.restoreAll();
    await app?.close();
    await database?.drop();
    if (storageDir) await rm(join(storageDir, '..'), { recursive: true, force: true });
  });

  it('1, 4, 12. a student gets the brief of an approved PDF: quoted, located, labelled extractive, never cached', async () => {
    const res = await call('student', 'GET', briefUrl(ids.courseA, ids.pdf));
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = ok(res) as Brief;
    assert.deepEqual([body.title, body.version, body.generator], ['Service value chain overview', 'approved', { id: 'study-brief-v1', mode: 'extractive' }]);
    assert.equal(body.brief.status, 'complete');
    assert.equal(body.brief.language.primary, 'en');
    const segments = (ok(await call('student', 'GET', `/courses/${ids.courseA}/activities/${ids.pdf}/document`)) as { document: { segments: DocumentSegment[] } }).document.segments;
    assertGrounded(body.brief, segments);
    assert.deepEqual(body.brief.concepts.map((c) => [c.term, c.ref.label]), [['service value chain', 'Page 1']]);
    assert.deepEqual(Object.keys(body.document).sort(), ['extraction', 'fileName', 'format', 'id']);
  });

  it('2, 13. DOCX headings and slide titles become sections; a Spanish document stays in Spanish', async () => {
    const es = await getBrief('student', ids.courseA, ids.docxEs);
    assert.deepEqual(es.brief.outline.map((h) => [h.text, h.ref.label]), [['Métricas', 'Paragraph 3']]);
    assert.deepEqual(es.brief.concepts.map((c) => c.term), ['inteligencia artificial']);
    assert.deepEqual(es.brief.language, { primary: 'es', mixed: false });
    const slides = await getBrief('student', ids.courseA, ids.slides);
    assert.deepEqual(slides.brief.outline.map((h) => [h.text, h.ref.label]), [['Change enablement', 'Slide 1'], ['Change authority', 'Slide 2']]);
  });

  it('5. no invented citations: DOCX references are paragraphs, PDF references only pages that have text', async () => {
    const docx = await getBrief('student', ids.courseA, ids.docxEs);
    const refs = [...docx.brief.overview, ...docx.brief.excerpts, ...docx.brief.concepts, ...docx.brief.outline].map((item) => item.ref);
    assert.ok(refs.length && refs.every((ref) => ref.kind === 'paragraph' && /^Paragraph \d+$/.test(ref.label)));
    const partial = await getBrief('student', ids.courseA, ids.partial);
    const pages = new Set([...partial.brief.overview, ...partial.brief.excerpts].map((item) => item.ref.label));
    assert.deepEqual([...pages], ['Page 1']);
  });

  it('6, 8. a document without selectable text (scanned) has no brief and says why; failed extractions are never stored', async () => {
    const scanned = await getBrief('student', ids.courseA, ids.scanned);
    assert.equal(scanned.brief.status, 'no_text');
    assert.deepEqual(scanned.brief.limitations, [{ code: 'no_text', processed: null, total: null }]);
    const before = await fingerprint();
    const current = sessions.get('instructor')!;
    const { payload, contentType } = multipartBody([{ name: 'file', filename: 'broken.pdf', data: Buffer.from('%PDF-1.4\nthis is not a real pdf') }]);
    const res = await app.inject({ method: 'POST', url: `/api/v1/courses/${ids.courseA}/sections/${ids.introA}/documents`, payload, cookies: { [COOKIE]: current.token }, headers: { 'content-type': contentType, 'x-csrf-token': current.csrf, origin: WEB_ORIGIN } });
    problem(res, 422, 'DOCUMENT_MALFORMED');
    assert.notEqual(await fingerprint(), before, 'the rejection is audited');
  });

  it('7. unsupported uploads are refused, and only documents have briefs', async () => {
    const current = sessions.get('instructor')!;
    const { payload, contentType } = multipartBody([{ name: 'file', filename: 'notes.txt', data: Buffer.from('plain text') }]);
    const res = await app.inject({ method: 'POST', url: `/api/v1/courses/${ids.courseA}/sections/${ids.introA}/documents`, payload, cookies: { [COOKIE]: current.token }, headers: { 'content-type': contentType, 'x-csrf-token': current.csrf, origin: WEB_ORIGIN } });
    problem(res, 415, 'UNSUPPORTED_FILE_TYPE');
    const page = ok(await call('instructor', 'POST', `/courses/${ids.courseA}/sections/${ids.introA}/activities`, { payload: { type: 'page', title: 'A lesson', body: 'Lesson text that is not a document.' } }), 201);
    problem(await call('instructor', 'GET', briefUrl(ids.courseA, page.id)), 404, 'NOT_FOUND');
  });

  it('9. partially extracted documents are labelled partial with what is missing', async () => {
    const partial = await getBrief('student', ids.courseA, ids.partial);
    assert.equal(partial.brief.status, 'partial');
    assert.deepEqual(partial.brief.limitations, [{ code: 'pages_without_text', processed: 1, total: 2 }]);
  });

  it('10. a document longer than the limits: partial, with the coverage stated, and a small response', async () => {
    const res = await call('student', 'GET', briefUrl(ids.courseA, ids.long));
    const long = ok(res) as Brief;
    assert.equal(long.brief.status, 'partial');
    assert.deepEqual(long.brief.limitations.map((l) => l.code), ['extraction_truncated', 'brief_limit']);
    const limit = long.brief.limitations[1]!;
    assert.ok(limit.processed! <= BRIEF_LIMITS.characters && limit.total! > limit.processed!);
    assert.ok(res.body.length < 20_000, `${res.body.length} bytes`);
  });

  it('14. the brief carries no interface wording: it is identical whatever the interface language', async () => {
    const en = await call('student', 'GET', briefUrl(ids.courseA, ids.docxEs), { cookies: { ap_locale: 'en' } });
    const es = await call('student', 'GET', briefUrl(ids.courseA, ids.docxEs), { cookies: { ap_locale: 'es' } });
    assert.equal(en.body, es.body);
  });

  it('15, 16. students: only approved, visible documents of their published courses in open sections', async () => {
    problem(await call('student', 'GET', briefUrl(ids.courseA, ids.draft)), 404, 'NOT_FOUND');
    problem(await call('student', 'GET', briefUrl(ids.courseA, ids.hidden)), 404, 'NOT_FOUND');
    problem(await call('student', 'GET', briefUrl(ids.courseC, ids.draftCourseDoc)), 404, 'NOT_FOUND');
    problem(await call('student', 'GET', briefUrl(ids.courseA, ids.draftCourseDoc)), 404, 'NOT_FOUND'); // guessed id, wrong course
    problem(await call('student', 'GET', briefUrl(ids.courseB, ids.pdf)), 404, 'NOT_FOUND'); // not enrolled
    problem(await call(null, 'GET', briefUrl(ids.courseA, ids.pdf)), 401, 'UNAUTHENTICATED');
    problem(await call('student', 'GET', `/courses/${ids.courseA}/activities/not-a-uuid/document/brief`), 400, 'VALIDATION_ERROR');
    // A section locked by a prerequisite.
    await database.pool.query('INSERT INTO section_prerequisites (course_id, section_id, required_section_id) VALUES ($1, $2, $3)', [ids.courseA, ids.module2A, ids.introA]);
    problem(await call('student', 'GET', briefUrl(ids.courseA, ids.module2)), 403, 'SECTION_LOCKED');
    await database.pool.query('DELETE FROM section_prerequisites WHERE course_id = $1', [ids.courseA]);
    assert.equal((await getBrief('student', ids.courseA, ids.module2)).brief.status, 'complete');
    // A refreshed working revision is the staff's; students keep the approved version.
    ok(await call('instructor', 'POST', `/courses/${ids.courseA}/activities/${ids.pdf}/document/summaries`), 201);
    assert.equal((await getBrief('student', ids.courseA, ids.pdf)).version, 'approved');
    assert.equal((await getBrief('instructor', ids.courseA, ids.pdf)).version, 'working');
  });

  it('17. instructors, the design team, non-editing instructors and administrators keep their existing document access', async () => {
    for (const person of ['instructor', 'reviewer', 'assistant', 'admin'] as const) {
      const draft = await getBrief(person, ids.courseA, ids.draft);
      assert.equal(draft.version, 'working', person);
      assert.equal((await getBrief(person, ids.courseA, ids.hidden)).brief.status, 'complete', person);
    }
    problem(await call('otherInstructor', 'GET', briefUrl(ids.courseA, ids.pdf)), 404, 'NOT_FOUND');
    problem(await call('instructor', 'GET', briefUrl(ids.courseB, ids.pdf)), 404, 'NOT_FOUND');
    // Non-editing instructors gain no editing: refreshing the summary stays forbidden.
    problem(await call('assistant', 'POST', `/courses/${ids.courseA}/activities/${ids.pdf}/document/summaries`), 403, 'FORBIDDEN');
  });

  it('18. no cross-user data: two students get the same brief, with no personal data, storage paths or hashes', async () => {
    const a = await call('student', 'GET', briefUrl(ids.courseA, ids.pdf));
    const b = await call('student2', 'GET', briefUrl(ids.courseA, ids.pdf));
    assert.equal(a.body, b.body);
    const stored = (await database.pool.query('SELECT storage_key, sha256 FROM course_documents WHERE activity_id = $1', [ids.pdf])).rows[0];
    for (const secret of [stored.storage_key, stored.sha256, sessions.get('student')!.userId, sessions.get('instructor')!.userId, EMAILS.instructor, storageDir]) {
      assert.ok(!a.body.includes(secret), 'nothing personal or internal is exposed');
    }
  });

  it('19, 21. briefs make no outbound requests and change nothing in the database', async () => {
    const before = await fingerprint();
    for (const activity of [ids.pdf, ids.docxEs, ids.slides, ids.scanned, ids.partial, ids.long]) await getBrief('instructor', ids.courseA, activity);
    for (const activity of [ids.pdf, ids.docxEs, ids.long]) await getBrief('student', ids.courseA, activity);
    assert.equal(await fingerprint(), before);
    assert.deepEqual(outbound, []);
  });

  it('22. the guided tutor and the document summary keep working with the same documents', async () => {
    const detail = ok(await call('student', 'GET', `/courses/${ids.courseA}/activities/${ids.pdf}/document`));
    assert.equal(detail.summary.status, 'ready');
    const tutor = ok(await call('student', 'POST', `/courses/${ids.courseA}/tutor/guide`, { payload: { action: 'explain', language: 'en', activityId: ids.pdf } }));
    assert.equal(tutor.grounding, 'grounded');
    assert.match(tutor.blocks.find((b: { kind: string }) => b.kind === 'quote').text, /service value chain/i);
  });

  it('a document deleted after its brief was opened is simply not found', async () => {
    assert.equal((await getBrief('student', ids.courseA, ids.slides)).brief.status, 'complete');
    await database.pool.query('DELETE FROM activities WHERE id = $1', [ids.slides]);
    problem(await call('student', 'GET', briefUrl(ids.courseA, ids.slides)), 404, 'NOT_FOUND');
  });

  // The uploads below stay unapproved drafts: staff read their briefs, students never can.

  it('a slide of 60,000 short lines (an abnormal upload) gets its brief quickly through the real extraction', async () => {
    const lines = Array.from({ length: 60_000 }, (_, n) => String.fromCharCode(97 + (n % 26)));
    const dense = await upload(ids.courseA, ids.introA, 'dense.pptx', makePptx([lines]), 'Dense slide');
    const started = performance.now();
    const result = await getBrief('instructor', ids.courseA, dense);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 3_000, `${elapsed.toFixed(0)} ms`); // was about 14 s; the linear engine takes well under 100 ms
    assert.equal(result.brief.status, 'excerpts_only');
    assert.equal(result.brief.coverage.totalCharacters, lines.join('\n').length);
    problem(await call('student', 'GET', briefUrl(ids.courseA, dense)), 404, 'NOT_FOUND');
  });

  it('a running header inside a sentence of a real PDF is never joined into one quote', async () => {
    const header = 'ACME University Confidential';
    const pages = [
      ['The incident management practice', header, 'restores normal service operation as quickly as possible after any disruption.'],
      ['Problem management reduces the likelihood and impact of incidents by identifying actual causes.'],
      ['Change enablement maximizes the number of successful service and product changes for customers.'],
      ['Service level management sets clear business based targets for service levels and measures them.'],
    ].map((lines, index) => [header, ...lines, String(index + 1)]);
    const handout = await upload(ids.courseA, ids.introA, 'headers.pdf', makePdf(pages), 'Handout with running headers');
    const segments = (ok(await call('instructor', 'GET', `/courses/${ids.courseA}/activities/${handout}/document`)) as { document: { segments: DocumentSegment[] } }).document.segments;
    assert.ok(segments[0]!.text.includes(`practice\n${header}\nrestores`), 'the extraction keeps the header inside the sentence');
    const result = (await getBrief('instructor', ids.courseA, handout)).brief;
    const quoted = [...result.overview, ...result.excerpts, ...result.concepts].map((item) => item.text);
    assert.ok(quoted.length >= 3 && !quoted.some((text) => /incident management practice|^restores normal/.test(text)), JSON.stringify(quoted));
    assertGrounded(result, segments);
    problem(await call('student', 'GET', briefUrl(ids.courseA, handout)), 404, 'NOT_FOUND');
  });

  it('text excerpts of a 30-slide deck: the response says 8 of the 30 are shown, and what was inspected', async () => {
    const deck = await upload(ids.courseA, ids.introA, 'bullets.pptx', makePptx(Array.from({ length: 30 }, (_, n) => [`Topic ${n + 1}`, `Short bullet ${n + 1}`, `Another item ${n + 1}`])), 'Bullet deck');
    const result = (await getBrief('instructor', ids.courseA, deck)).brief;
    assert.equal(result.status, 'excerpts_only');
    assert.equal(result.excerpts.length, BRIEF_LIMITS.fallbackBlocks);
    assert.equal(result.excerptsAvailable, 30);
    assert.deepEqual([result.coverage.processedSegments, result.coverage.totalSegments], [30, 30]);
    problem(await call('student', 'GET', briefUrl(ids.courseA, deck)), 404, 'NOT_FOUND');
  });
});
