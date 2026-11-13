/**
 * AP-030D guided demo tutor. Unit tests of the deterministic text rules, then API tests on the synthetic demo
 * dataset against a temporary PostgreSQL database (skipped unless TEST_DATABASE_URL is set): course-aware
 * suggestions, guided learning in the three seeded courses, English and Spanish, lesson context, fallbacks,
 * practice questions and feedback, real references, access rules, answer-key privacy, no stored data, no network.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { ACCOUNTS, type Persona } from '../../scripts/demo/content.js';
import { seedDemo, type DemoReport } from '../../scripts/seed-demo.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { GUIDE_TEXT } from '../../src/tutor/guide-text.js';
import { definitionOf, enumeration, isExample, resolveQuestion } from '../../src/tutor/guide.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const ITIL = 'ITIL4-F-2026-2-A';
const PMF = 'PMF-2026-2-A';
const IAI = 'IAI-2026-2-A';
const DRAFT = 'ITIL4-F-2026-2-B';

type App = ReturnType<typeof buildApp>;
type Session = { token: string; csrf: string; userId: string };
type Block = { kind: string; text: string | null; items: string[]; ref: number | null; sourceLanguage: string | null };
type Reference = { ref: number; activityId: string; title: string; type: string; sourceLanguage: string | null; matchesRequestedLanguage: boolean };
type Guide = {
  provider: { mode: string; label: string };
  language: string;
  action: string;
  intent: string | null;
  grounding: string;
  variant: number;
  context: { courseId: string; courseTitle: string; lesson: { activityId: string; title: string; type: string } | null };
  focus: { activityId: string; title: string } | null;
  blocks: Block[];
  references: Reference[];
  practice: { questionId: string; kind: string; prompt: string; statement: string; options: Array<{ id: string; text: string }>; ref: number } | null;
  followUps: string[];
  materials: Array<{ activityId: string; title: string; type: string }>;
};
type Check = { status: string; correctOptionId: string | null; blocks: Block[]; references: Reference[]; followUps: string[] };

const quotes = (response: Guide | Check) => response.blocks.filter((b) => b.kind === 'quote').map((b) => b.text!);
const texts = (response: Guide | Check) => response.blocks.filter((b) => b.kind === 'text').map((b) => b.text!);

describe('guided tutor text rules (unit)', () => {
  it('recognises definitions, examples and lists in the seeded lesson style', () => {
    assert.equal(definitionOf('Value is the perceived benefit, usefulness and importance of something.')?.subject, 'Value');
    assert.equal(definitionOf('The critical path is the longest sequence of dependent activities through the network.')?.subject, 'critical path');
    assert.equal(definitionOf('Start where you are means assessing what already exists before building something new.')?.subject, 'Start where you are');
    assert.equal(definitionOf('La inteligencia artificial es el campo que estudia cómo construir sistemas.')?.subject, 'inteligencia artificial');
    for (const sentence of ['It is always co-created.', 'Running the weekly payroll is an operation.', '"Registration form tested" is a better work package.', 'Operations, by contrast, are ongoing.']) {
      assert.equal(definitionOf(sentence), null, sentence);
    }
    assert.ok(isExample('A new portal, for instance, needs trained staff.') && isExample('Por ejemplo, correos etiquetados.'));
    assert.deepEqual(enumeration('The four parts are people, technology, suppliers, and processes.'), ['people', 'technology', 'suppliers', 'processes']);
    assert.equal(enumeration('Value is the perceived benefit, usefulness and importance of something.'), null);
  });

  it('maps English and Spanish requests to actions with fixed keyword rules', () => {
    assert.deepEqual(resolveQuestion('Give me an example'), { intent: 'example', topicTerms: [] });
    assert.deepEqual(resolveQuestion('Explain the critical path'), { intent: 'explain', topicTerms: ['critical', 'path'] });
    assert.deepEqual(resolveQuestion('¿Qué es el aprendizaje supervisado?'), { intent: 'explain', topicTerms: ['aprendizaje', 'supervisado'] });
    assert.equal(resolveQuestion('Resume esta lección').intent, 'summarize');
    assert.equal(resolveQuestion('Help me prepare for the quiz').intent, 'quiz_prep');
    assert.equal(resolveQuestion('quiz me on risks').intent, 'practice');
    assert.equal(resolveQuestion('What should I study next?').intent, 'next');
    assert.deepEqual(resolveQuestion('Tell me about photosynthesis'), { intent: null, topicTerms: ['photosynthesis'] });
  });

  it('English and Spanish tutor wording has the same shape and states that no generative AI is used (AP-042)', () => {
    assert.deepEqual(Object.keys(GUIDE_TEXT.es).sort(), Object.keys(GUIDE_TEXT.en).sort());
    for (const key of Object.keys(GUIDE_TEXT.en) as Array<keyof typeof GUIDE_TEXT.en>) {
      assert.equal(typeof GUIDE_TEXT.es[key], typeof GUIDE_TEXT.en[key], key);
    }
    assert.match(GUIDE_TEXT.en.label, /rule-based, no generative AI/);
    assert.match(GUIDE_TEXT.es.label, /basado en reglas, sin IA generativa/);
    assert.match(GUIDE_TEXT.en.greeting('X'), /no generative AI model is used/);
    assert.match(GUIDE_TEXT.es.greeting('X'), /no se usa ningún modelo de IA generativa/);
    // Production wording: an honest capability statement, without development or demonstration branding.
    for (const lang of ['en', 'es'] as const) {
      const wording = [GUIDE_TEXT[lang].label, GUIDE_TEXT[lang].greeting('X'), GUIDE_TEXT[lang].unsupported].join(' ');
      assert.doesNotMatch(wording, /demo|demostraci|mock|simulad|live AI|IA en vivo/i, lang);
    }
    assert.match(GUIDE_TEXT.en.exampleTip, /not from the course/);
    assert.match(GUIDE_TEXT.es.quizTip, /no proviene del curso/);
  });

  it('the guided tutor code makes no network or model calls', async () => {
    const dir = join(import.meta.dirname, '../../src/tutor');
    for (const file of await readdir(dir)) {
      const source = await readFile(join(dir, file), 'utf8');
      assert.doesNotMatch(source, /\bfetch\(|node:https?|from 'undici'|axios|vertex|openai|gemini|anthropic/i, file);
    }
  });
});

describe('guided demo tutor (PostgreSQL, demo dataset)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let report: DemoReport;
  let app: App;
  const as = {} as Record<Persona, Session>;
  const lesson = {} as Record<string, string>;

  const courseId = (code: string) => report.courses.find((c) => c.code === code)!.id;
  const post = (who: Persona | null, url: string, body: unknown, options: { csrf?: string | null } = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      cookies: who ? { ap_session: as[who].token } : {},
      headers: { origin: ORIGIN, ...(who && options.csrf !== null ? { 'x-csrf-token': options.csrf ?? as[who].csrf } : {}) },
      payload: body as object,
    });
  const guideRaw = (who: Persona, code: string, body: Record<string, unknown>) => post(who, `/courses/${courseId(code)}/tutor/guide`, body);
  const guide = async (who: Persona, code: string, body: Record<string, unknown>): Promise<Guide> => {
    const res = await guideRaw(who, code, { language: 'en', ...body });
    assert.equal(res.statusCode, 200, `${JSON.stringify(body)}: ${res.body}`);
    return res.json() as Guide;
  };
  const check = async (who: Persona, code: string, body: Record<string, unknown>): Promise<Check> => {
    const res = await post(who, `/courses/${courseId(code)}/tutor/practice/check`, { language: 'en', ...body });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as Check;
  };
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };
  const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[];
  const activityId = async (code: string, title: string) =>
    (await query<{ id: string }>('SELECT a.id FROM activities a JOIN sections s ON s.id = a.section_id WHERE s.course_id = $1 AND a.title = $2', [courseId(code), title]))[0]!.id;
  /** Everything a guided request could conceivably write. */
  const fingerprint = async () =>
    (
      await query<{ f: string }>(
        `SELECT md5(concat_ws('|',
           (SELECT count(*) FROM tutor_usage), (SELECT count(*) FROM audit_log), (SELECT count(*) FROM activity_completions),
           (SELECT count(*) FROM quiz_attempts), (SELECT coalesce(max(updated_at)::text, '') FROM activities),
           (SELECT coalesce(max(updated_at)::text, '') FROM enrollments), (SELECT count(*) FROM notifications))) AS f`,
      )
    )[0]!.f;

  before(async () => {
    database = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'ap-tutor-guide-'));
    const env = { NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: join(root, 'store') };
    // Real demo documents (PDF/DOCX) so documents are part of the material, as in the cloud demo.
    report = await seedDemo(database.db, { password: PASSWORD, env, uploadFilesDir: join(root, 'files') });
    app = buildApp({ config: { ...loadConfig(env), loginRateLimit: { max: 1000, windowMs: 60_000 } }, database: database.db });
    await app.ready();
    for (const persona of Object.keys(ACCOUNTS) as Persona[]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email: ACCOUNTS[persona], password: PASSWORD } });
      assert.equal(res.statusCode, 200, res.body);
      as[persona] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken, userId: res.json().user.id };
    }
    lesson.principles = await activityId(ITIL, 'Guiding principles in practice');
    lesson.dimensions = await activityId(ITIL, 'The four dimensions of service management');
    lesson.valueChain = await activityId(ITIL, 'Service value chain overview');
    lesson.wbs = await activityId(PMF, 'Defining scope with a work breakdown structure');
    lesson.supervised = await activityId(IAI, 'Aprendizaje supervisado y no supervisado');
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('1. course-aware start: greeting with the course, the lesson context, suggestions and the readable materials only', async () => {
    const course = await guide('student', ITIL, { action: 'start' });
    assert.equal(course.provider.mode, 'guided_demo');
    assert.match(texts(course)[0]!, /guided study assistant for ITIL 4 Foundation\b.*no generative AI model is used/);
    assert.deepEqual(course.followUps, ['review', 'summarize', 'practice', 'next', 'material', 'quiz_prep']);
    const titles = course.materials.map((m) => m.title);
    assert.deepEqual(titles, ['Value, outcomes, costs and risks', 'The four dimensions of service management', 'Guiding principles in practice', 'Service value chain overview', 'Incident and problem management']);
    // Submitted (not yet approved) content and instructor notes are not material.
    assert.ok(!titles.includes('Change enablement') && !titles.includes('Facilitator notes for module 2'));
    const inLesson = await guide('student', ITIL, { action: 'start', activityId: lesson.principles });
    assert.equal(inLesson.context.lesson?.title, 'Guiding principles in practice');
    assert.match(texts(inLesson)[1]!, /You are studying “Guiding principles in practice”/);
    assert.deepEqual(inLesson.followUps, ['explain', 'summarize', 'simpler', 'example', 'practice', 'review', 'material', 'next', 'quiz_prep']);
    // Choosing another lesson mid-conversation states the new context without greeting again.
    const switched = await guide('student', ITIL, { action: 'start', activityId: lesson.dimensions, variant: 1 });
    assert.deepEqual(texts(switched), ['You are studying “The four dimensions of service management”. Choose what you would like to do:']);
  });

  it('2. ITIL: explain, simpler (the listed parts), example from a related lesson, review, practice, material', async () => {
    const explain = await guide('student', ITIL, { action: 'explain', activityId: lesson.principles });
    assert.equal(explain.grounding, 'grounded');
    assert.match(quotes(explain)[0]!, /^The guiding principles are recommendations that can guide an organization in all circumstances/);
    assert.deepEqual(explain.references.map((r) => [r.title, r.type]), [['Guiding principles in practice', 'page']]);
    assert.deepEqual(explain.followUps, ['simpler', 'example', 'detail', 'practice', 'again']);
    const again = await guide('student', ITIL, { action: 'again', activityId: lesson.principles, variant: 1 });
    assert.match(quotes(again)[0]!, /^Start where you are means/);
    const simpler = await guide('student', ITIL, { action: 'simpler', activityId: lesson.principles });
    const parts = simpler.blocks.find((b) => b.kind === 'list')!.items;
    assert.deepEqual(parts, ['focus on value', 'start where you are', 'progress iteratively with feedback', 'collaborate and promote visibility', 'think and work holistically', 'keep it simple and practical', 'optimize and automate']);
    const example = await guide('student', ITIL, { action: 'example', activityId: lesson.principles });
    assert.match(texts(example)[0]!, /“The four dimensions of service management” has a related one/);
    assert.match(quotes(example)[0]!, /self-service portal for library loans, for instance/);
    // A document is material too: the value chain PDF is explained from its approved extracted text.
    const chain = await guide('student', ITIL, { action: 'explain', activityId: lesson.valueChain });
    assert.match(quotes(chain)[0]!, /The service value chain is an operating model/);
    assert.equal(chain.references[0]!.type, 'file');
  });

  it('3. Project Management: explain, review without formal definitions, example from the charter guide, practice', async () => {
    const explain = await guide('student', PMF, { action: 'explain', activityId: lesson.wbs });
    assert.match(quotes(explain)[0]!, /^A work breakdown structure \(WBS\) decomposes the total scope/);
    const review = await guide('student', PMF, { action: 'review', activityId: lesson.wbs });
    assert.equal(texts(review)[0], GUIDE_TEXT.en.reviewNone);
    const example = await guide('student', PMF, { action: 'example', activityId: lesson.wbs });
    assert.match(quotes(example)[0]!, /for example reducing the average enrolment processing time/);
    assert.equal(example.references[0]!.title, 'Project charter guide');
    const course = await guide('student', PMF, { action: 'review' });
    assert.ok(course.blocks.some((b) => b.kind === 'list' && b.items.some((item) => item.startsWith('What makes work a project: A project is a temporary endeavour'))));
  });

  it('4, 6. Introduction to AI in Spanish: Spanish wording around the Spanish material, nothing translated', async () => {
    const explain = await guide('student', IAI, { action: 'explain', activityId: lesson.supervised, language: 'es' });
    assert.equal(texts(explain)[0], 'Así lo explica «Aprendizaje supervisado y no supervisado»:');
    assert.match(quotes(explain)[0]!, /^En el aprendizaje supervisado el modelo aprende a partir de ejemplos etiquetados/);
    assert.equal(explain.provider.label, 'Asistente de estudio guiado — basado en reglas, sin IA generativa');
    assert.ok(explain.references.every((r) => r.matchesRequestedLanguage));
    const asked = await guide('student', IAI, { action: 'ask', question: '¿Qué es el aprendizaje supervisado?', language: 'es' });
    assert.deepEqual([asked.intent, asked.grounding, asked.focus?.title], ['explain', 'grounded', 'Aprendizaje supervisado y no supervisado']);
    // Requests about the course itself are answered even with extra words in the question.
    const prep = await guide('student', IAI, { action: 'ask', question: '¿Cómo me preparo para el cuestionario de este curso?', language: 'es', activityId: lesson.supervised });
    assert.deepEqual([prep.intent, prep.grounding], ['quiz_prep', 'grounded']);
    assert.match(texts(prep)[0]!, /^Cuestionarios de este curso/);
  });

  it('5–7. English and Spanish: the same material and references, the tutor wording in the selected language, with a note when they differ', async () => {
    const en = await guide('student', ITIL, { action: 'summarize', activityId: lesson.dimensions, language: 'en' });
    const es = await guide('student', ITIL, { action: 'summarize', activityId: lesson.dimensions, language: 'es' });
    assert.deepEqual(es.blocks.filter((b) => b.kind === 'list'), en.blocks.filter((b) => b.kind === 'list'));
    assert.deepEqual(es.references, en.references.map((r) => ({ ...r, matchesRequestedLanguage: false })));
    assert.match(texts(en)[0]!, /^The key sentences of “The four dimensions of service management”/);
    assert.match(texts(es)[0]!, /^Las oraciones clave de «The four dimensions of service management»/);
    // The English material is labelled as such in Spanish, and never translated.
    assert.equal(texts(es).at(-1), GUIDE_TEXT.es.sourceLanguage('en'));
    assert.ok(!texts(en).includes(GUIDE_TEXT.en.sourceLanguage('en')));
  });

  it('8. the lesson context drives the response; changing lessons changes the focus', async () => {
    const a = await guide('student', ITIL, { action: 'explain', activityId: lesson.principles });
    const b = await guide('student', ITIL, { action: 'explain', activityId: lesson.dimensions });
    assert.deepEqual([a.focus?.title, b.focus?.title], ['Guiding principles in practice', 'The four dimensions of service management']);
    assert.notEqual(quotes(a)[0], quotes(b)[0]);
    // Deterministic: the same request gives the same response.
    assert.deepEqual(await guide('student', ITIL, { action: 'explain', activityId: lesson.principles }), a);
  });

  it('9. unsupported questions get a clear limitation and what the tutor can do, never an invented answer', async () => {
    for (const question of ['What is the capital of France?', 'Write my essay about photosynthesis']) {
      const response = await guide('student', ITIL, { action: 'ask', question });
      assert.equal(response.grounding, 'insufficient_material', question);
      assert.equal(response.blocks.filter((b) => b.kind !== 'text').length, 0, 'no quoted or listed content');
      assert.ok(response.followUps.length >= 4 && response.references.length >= 1);
      assert.ok(response.references.every((r) => r.type === 'page' || r.type === 'file'));
    }
    const spanish = await guide('student', ITIL, { action: 'ask', question: '¿Cuál es la capital de Francia?', language: 'es' });
    assert.match(texts(spanish)[0]!, /^No encontré ese tema|^Soy un asistente de estudio basado en reglas/);
  });

  it('10–11. practice: a question from a lesson sentence; correct and incorrect answers get feedback with the source', async () => {
    const practice = await guide('student', ITIL, { action: 'practice', activityId: lesson.principles });
    const question = practice.practice!;
    assert.equal(question.kind, 'term');
    assert.match(question.statement, /^The _____ are recommendations that can guide an organization/);
    assert.ok(question.options.length >= 3 && question.options.some((o) => o.text === 'guiding principles'));
    const right = question.options.find((o) => o.text === 'guiding principles')!;
    const wrong = question.options.find((o) => o.text !== 'guiding principles')!;
    const correct = await check('student', ITIL, { questionId: question.questionId, optionId: right.id });
    assert.deepEqual([correct.status, correct.correctOptionId], ['correct', right.id]);
    assert.match(quotes(correct)[0]!, /^The guiding principles are recommendations/);
    const incorrect = await check('student', ITIL, { questionId: question.questionId, optionId: wrong.id });
    assert.deepEqual([incorrect.status, incorrect.correctOptionId], ['incorrect', right.id]);
    assert.match(texts(incorrect)[0]!, new RegExp(`you chose “${wrong.text}”`));
    assert.match(texts(incorrect).at(-1)!, /Review “Guiding principles in practice”/);
    assert.deepEqual(incorrect.followUps, ['explain', 'simpler', 'practice']);
    // The next variant is another question; Spanish feedback is in Spanish.
    const another = await guide('student', ITIL, { action: 'practice', activityId: lesson.principles, variant: 1 });
    assert.notEqual(another.practice!.statement, question.statement);
    const es = await check('student', ITIL, { questionId: question.questionId, optionId: wrong.id, language: 'es' });
    assert.match(texts(es)[0]!, /^No exactamente: elegiste/);
    // A tampered or stale question is unavailable, never an error page or another course's content.
    const fingerprint = question.questionId.split('~')[2]!;
    for (const questionId of [`${lesson.wbs}~0~${fingerprint}`, `${lesson.principles}~999~${fingerprint}`, question.questionId.replace(/~[0-9a-f]{8}$/, '~00000000')]) {
      assert.equal((await check('student', ITIL, { questionId, optionId: 'a' })).status, 'unavailable', questionId);
    }
    // The question changed (its lesson was revised and approved again): the old answer is not checked against it.
    const original = (await query<{ approved_config: { body: string } }>('SELECT approved_config FROM activities WHERE id = $1', [lesson.principles]))[0]!.approved_config;
    await query('UPDATE activities SET approved_config = $2 WHERE id = $1', [lesson.principles, { ...original, body: original.body.replace('can guide an organization', 'can steer an organization') }]);
    assert.equal((await check('student', ITIL, { questionId: question.questionId, optionId: right.id })).status, 'unavailable');
    await query('UPDATE activities SET approved_config = $2 WHERE id = $1', [lesson.principles, original]);
    assert.equal((await check('student', ITIL, { questionId: question.questionId, optionId: right.id })).status, 'correct');
    assert.equal((await post('student', `/courses/${courseId(ITIL)}/tutor/practice/check`, { questionId: 'x', optionId: 'a', language: 'en' })).statusCode, 400);
  });

  it('12. every reference is real, approved material the student may open in that course', async () => {
    const readable = new Set(
      (
        await query<{ id: string }>(
          `SELECT a.id FROM activities a JOIN sections s ON s.id = a.section_id
           WHERE s.course_id = $1 AND a.approved_config IS NOT NULL AND a.is_visible AND s.is_visible`,
          [courseId(ITIL)],
        )
      ).map((row) => row.id),
    );
    for (const action of ['start', 'explain', 'summarize', 'simpler', 'example', 'detail', 'review', 'material', 'next', 'quiz_prep', 'practice']) {
      for (const context of [{}, { activityId: lesson.principles }]) {
        const response = await guide('student', ITIL, { action, ...context });
        for (const reference of response.references) assert.ok(readable.has(reference.activityId), `${action}: ${reference.title}`);
        for (const block of response.blocks) if (block.ref !== null) assert.ok(response.references.some((r) => r.ref === block.ref));
      }
    }
  });

  it('13–14. access: enrolled students and teaching staff only; draft courses, unapproved, hidden and locked lessons stay hidden', async () => {
    // Non-editing instructors keep the existing tutor access; the design team and administrators still have none.
    assert.equal((await guideRaw('ta', ITIL, { action: 'start', language: 'en' })).statusCode, 200);
    problem(await guideRaw('reviewer', ITIL, { action: 'start', language: 'en' }), 403, 'FORBIDDEN');
    problem(await guideRaw('admin', ITIL, { action: 'start', language: 'en' }), 403, 'FORBIDDEN');
    problem(await guideRaw('learnerB', PMF, { action: 'start', language: 'en' }), 404, 'NOT_FOUND');
    problem(await guideRaw('student', DRAFT, { action: 'start', language: 'en' }), 404, 'NOT_FOUND');
    problem(await post(null, `/courses/${courseId(ITIL)}/tutor/guide`, { action: 'start', language: 'en' }), 401, 'UNAUTHENTICATED');
    problem(await post('student', `/courses/${courseId(ITIL)}/tutor/guide`, { action: 'start', language: 'en' }, { csrf: null }), 403, 'CSRF_TOKEN_INVALID');
    // Guessed ids: an unapproved lesson, a lesson of another course, a random id.
    const submitted = await activityId(ITIL, 'Change enablement');
    for (const id of [submitted, lesson.wbs, randomUUID()]) problem(await guideRaw('student', ITIL, { action: 'explain', activityId: id, language: 'en' }), 404, 'NOT_FOUND');
    // A hidden lesson is hidden from students (staff may still study it).
    await query('UPDATE activities SET is_visible = false WHERE id = $1', [lesson.dimensions]);
    problem(await guideRaw('student', ITIL, { action: 'explain', activityId: lesson.dimensions, language: 'en' }), 404, 'NOT_FOUND');
    assert.ok(!(await guide('student', ITIL, { action: 'start' })).materials.some((m) => m.activityId === lesson.dimensions));
    assert.equal((await guideRaw('instructor', ITIL, { action: 'explain', activityId: lesson.dimensions, language: 'en' })).statusCode, 200);
    await query('UPDATE activities SET is_visible = true WHERE id = $1', [lesson.dimensions]);
    // A section locked by a prerequisite is not used for the student.
    const [module1, module2] = await query<{ id: string }>('SELECT id FROM sections WHERE course_id = $1 ORDER BY position LIMIT 2', [courseId(ITIL)]);
    await query('INSERT INTO section_prerequisites (course_id, section_id, required_section_id) VALUES ($1, $2, $3)', [courseId(ITIL), module2!.id, module1!.id]);
    problem(await guideRaw('student', ITIL, { action: 'explain', activityId: lesson.principles, language: 'en' }), 404, 'NOT_FOUND');
    const locked = await guide('student', ITIL, { action: 'review' });
    assert.ok(locked.references.every((r) => r.title !== 'Guiding principles in practice'));
    await query('DELETE FROM section_prerequisites WHERE course_id = $1', [courseId(ITIL)]);
    // Input is validated: unknown actions, missing or overlong questions, out-of-range variants.
    for (const body of [{ action: 'hack', language: 'en' }, { action: 'ask', language: 'en' }, { action: 'ask', language: 'en', question: 'x'.repeat(501) }, { action: 'explain', language: 'en', variant: 5000 }, { action: 'start', language: 'fr' }]) {
      assert.equal((await guideRaw('student', ITIL, body)).statusCode, 400, JSON.stringify(body).slice(0, 60));
    }
  });

  it('15. quiz help never exposes quiz questions, options or answer keys; practice never comes from quizzes', async () => {
    const quizOnly = [
      'Which ITIL 4 component describes how all components',
      'The configuration ma',
      'What is the main purpose of a work breakdown structure?',
      'To record the salaries of team members',
      '¿Qué tipo de aprendizaje usa ejemplos etiquetados',
    ];
    for (const code of [ITIL, PMF, IAI]) {
      const prep = await guide('student', code, { action: 'quiz_prep' });
      assert.ok(prep.references.some((r) => r.type === 'quiz'));
      const responses = [prep];
      for (let variant = 0; variant < 12; variant += 1) responses.push(await guide('student', code, { action: 'practice', variant }));
      const raw = JSON.stringify(responses);
      for (const text of quizOnly) assert.ok(!raw.includes(text), `${code}: ${text}`);
      assert.ok(!raw.includes('correctAnswer') && !raw.includes('isCorrect'));
    }
    assert.match((await guide('student', ITIL, { action: 'quiz_prep' })).blocks[1]!.items[0]!, /“Module check: ITIL 4 foundations”: 3 questions, 2 attempts, 30 minutes\./);
  });

  it('16. study next follows each student’s own progress; nothing personal is shared between students', async () => {
    const first = await activityId(ITIL, 'Value, outcomes, costs and risks');
    const before = await guide('student', ITIL, { action: 'next' });
    const otherBefore = await guide('learnerA', ITIL, { action: 'next' });
    const res = await app.inject({ method: 'PUT', url: `/api/v1/courses/${courseId(ITIL)}/activities/${first}/completion`, cookies: { ap_session: as.student.token }, headers: { origin: ORIGIN, 'x-csrf-token': as.student.csrf } });
    assert.equal(res.statusCode, 200, res.body);
    const after = await guide('student', ITIL, { action: 'next' });
    const otherAfter = await guide('learnerA', ITIL, { action: 'next' });
    assert.notDeepEqual(after.references, before.references, 'the student’s next step moved on');
    assert.deepEqual(otherAfter, otherBefore, 'another student is unaffected');
    const raw = JSON.stringify([after, otherAfter]);
    for (const persona of ['student', 'learnerA'] as const) assert.ok(!raw.includes(ACCOUNTS[persona]) && !raw.includes(as[persona].userId));
  });

  it('17–18. guided requests make no network calls and change nothing in the database', async () => {
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      throw new Error('network access is not allowed');
    }) as typeof fetch;
    try {
      const before = await fingerprint();
      for (const action of ['start', 'explain', 'summarize', 'simpler', 'example', 'detail', 'review', 'material', 'next', 'quiz_prep', 'practice']) {
        await guide('student', ITIL, { action, activityId: lesson.principles });
      }
      await guide('student', ITIL, { action: 'ask', question: 'What are the guiding principles?' });
      const practice = await guide('student', ITIL, { action: 'practice' });
      await check('student', ITIL, { questionId: practice.practice!.questionId, optionId: 'a' });
      assert.equal(await fingerprint(), before);
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(calls, []);
  });

  it('the existing tutor endpoints keep working, and guided requests are limited per person', async () => {
    const message = await post('student', `/courses/${courseId(ITIL)}/tutor/messages`, { question: 'guiding principles', language: 'en' });
    assert.equal(message.statusCode, 200, message.body);
    assert.equal(message.json().provider.mode, 'mock');
    const statuses: number[] = [];
    for (let i = 0; i < 125; i += 1) statuses.push((await guideRaw('learnerA', ITIL, { action: 'start', language: 'en' })).statusCode);
    assert.ok(statuses.includes(429) && statuses.indexOf(429) >= 100, `first 429 at ${statuses.indexOf(429)}`);
  });
});
