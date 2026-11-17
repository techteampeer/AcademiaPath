/**
 * AP-QA-02 (QA case TC-22): academic-integrity regressions for the guided tutor, on the synthetic demo dataset in a
 * temporary PostgreSQL database of its own (skipped unless TEST_DATABASE_URL is set).
 *
 * The tutor is an open-book study aid: it quotes the course's approved, visible learning materials. These tests prove
 * that it never reads or returns a quiz's protected answer key, unpublished or hidden content, or another course's
 * content, and that legitimate explanations keep working. They do not (and cannot) stop a student from finding an
 * answer that a published lesson itself states; quiz questions written from lesson text can be answered from that
 * lesson, with or without the tutor. Disabling the tutor during quizzes would be a separate product decision.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { ACCOUNTS, type Persona } from '../../scripts/demo/content.js';
import { seedDemo, type DemoReport } from '../../scripts/seed-demo.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const ITIL = 'ITIL4-F-2026-2-A';
const PMF = 'PMF-2026-2-A';
const IAI = 'IAI-2026-2-A';
const COURSES = [
  [ITIL, 'en'],
  [PMF, 'en'],
  [IAI, 'es'],
] as const;
/** Field names of the stored answer key; none may ever appear in a tutor response. */
const KEY_FIELDS = ['isCorrect', 'correctAnswer', 'optionIds', 'answerKey', 'correctOptionIds'];

type Block = { kind: string; text: string | null; items: string[]; ref: number | null };
type Reference = { ref: number; activityId: string; type: string };
type Guide = { grounding: string; blocks: Block[]; references: Reference[]; practice: { questionId: string; options: Array<{ id: string }> } | null };
type QuizRow = { id: string; questions: Array<{ id: string; prompt: string; options: Array<{ id: string; text: string }> }> };

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('guided tutor academic integrity (TC-22; PostgreSQL, demo dataset)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let report: DemoReport;
  let app: ReturnType<typeof buildApp>;
  const as = {} as Record<Persona, { token: string; csrf: string }>;
  const courseId = (code: string) => report.courses.find((c) => c.code === code)!.id;
  const call = (who: Persona, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: { ap_session: as[who].token },
      headers: method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': as[who].csrf },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const ok = <T>(res: LightMyRequestResponse, status = 200): T => {
    assert.equal(res.statusCode, status, res.body);
    return res.json() as T;
  };
  const problem = (res: LightMyRequestResponse, status: number, code: string) => {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().code, code, res.body);
  };
  const guide = async (who: Persona, code: string, body: Record<string, unknown>) =>
    ok<Guide>(await call(who, 'POST', `/courses/${courseId(code)}/tutor/guide`, { language: 'en', ...body }));
  const query = async <T>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[];

  /** The approved text a student may read in a course: approved lessons and documents in visible sections. */
  async function readableText(code: string): Promise<Map<string, string>> {
    const rows = await query<{ id: string; type: string; body: string | null; segments: Array<{ text: string }> | null }>(
      `SELECT a.id, a.type, a.approved_config->>'body' AS body, d.segments
         FROM activities a JOIN sections s ON s.id = a.section_id
         LEFT JOIN course_documents d ON d.id::text = a.approved_config->>'documentId' AND d.activity_id = a.id
        WHERE s.course_id = $1 AND a.type IN ('page', 'file') AND a.approved_config IS NOT NULL AND a.approved_at IS NOT NULL
          AND a.is_visible AND s.is_visible`,
      [courseId(code)],
    );
    return new Map(rows.map((row) => [row.id, squash(row.type === 'page' ? (row.body ?? '') : (row.segments ?? []).map((s) => s.text).join('\n\n'))]));
  }
  async function quizzesOf(code: string): Promise<QuizRow[]> {
    return query<QuizRow>(
      `SELECT a.id, a.approved_config->'questions' AS questions FROM activities a JOIN sections s ON s.id = a.section_id
        WHERE s.course_id = $1 AND a.type = 'quiz' AND a.approved_config IS NOT NULL`,
      [courseId(code)],
    );
  }
  /** Every quote is verbatim from an approved, visible material of the same course, cited by its reference. */
  function assertGroundedInApproved(response: Guide, readable: Map<string, string>, where: string) {
    const byRef = new Map(response.references.map((reference) => [reference.ref, reference]));
    for (const block of response.blocks.filter((b) => b.kind === 'quote')) {
      const reference = byRef.get(block.ref!);
      assert.ok(reference && readable.has(reference.activityId), `${where}: a quote cites an approved, visible material`);
      assert.ok(readable.get(reference.activityId)!.includes(squash(block.text ?? '')), `${where}: the quote is the material's approved text`);
    }
  }
  function assertNoAnswerKey(raw: string, quizzes: QuizRow[], where: string) {
    for (const field of KEY_FIELDS) assert.ok(!raw.includes(`"${field}"`), `${where}: no ${field}`);
    for (const quiz of quizzes) {
      for (const question of quiz.questions ?? []) {
        assert.ok(!raw.includes(question.id), `${where}: no quiz question id`);
        for (const option of question.options) if (option.id.length > 8) assert.ok(!raw.includes(option.id), `${where}: no quiz option id`);
      }
    }
  }

  before(async () => {
    database = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'ap-tutor-integrity-'));
    const env = { NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: join(root, 'store') };
    report = await seedDemo(database.db, { password: PASSWORD, env, uploadFilesDir: join(root, 'files') });
    app = buildApp({ config: { ...loadConfig(env), loginRateLimit: { max: 1000, windowMs: 60_000 } }, database: database.db });
    await app.ready();
    for (const persona of Object.keys(ACCOUNTS) as Persona[]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email: ACCOUNTS[persona], password: PASSWORD } });
      assert.equal(res.statusCode, 200, res.body);
      as[persona] = { token: res.cookies.find((c) => c.name === 'ap_session')!.value, csrf: res.json().csrfToken };
    }
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('1, 2, 5. asking the seeded quiz questions returns only approved lesson text, never the answer key', async () => {
    for (const [code, language] of COURSES) {
      const readable = await readableText(code);
      const quizzes = await quizzesOf(code);
      assert.ok(quizzes.length && readable.size, code);
      for (const question of quizzes.flatMap((quiz) => quiz.questions)) {
        for (const lang of [language, language === 'en' ? 'es' : 'en']) {
          const response = await guide('student', code, { action: 'ask', question: question.prompt, language: lang });
          const where = `${code} ${lang} "${question.prompt.slice(0, 40)}"`;
          assert.ok(response.references.every((reference) => reference.type !== 'quiz'), `${where}: never cites a quiz`);
          assertGroundedInApproved(response, readable, where);
          assertNoAnswerKey(JSON.stringify(response), quizzes, where);
        }
      }
    }
  });

  it('1, 2, 5. quiz preparation and practice expose no answer key; practice questions come from approved lessons only', async () => {
    for (const [code, language] of COURSES) {
      const readable = await readableText(code);
      const quizzes = await quizzesOf(code);
      const prep = await guide('student', code, { action: 'quiz_prep', language });
      assert.ok(prep.references.some((reference) => reference.type === 'quiz'), `${code}: quiz preparation names the quiz`);
      assertNoAnswerKey(JSON.stringify(prep), quizzes, `${code} quiz_prep`);
      for (let variant = 0; variant < 6; variant += 1) {
        const practice = await guide('student', code, { action: 'practice', variant, language });
        if (!practice.practice) continue;
        const where = `${code} practice ${variant}`;
        const cited = practice.references.map((reference) => reference.activityId);
        assert.ok(cited.every((id) => readable.has(id)), `${where}: practice cites approved, visible lessons`);
        assertNoAnswerKey(JSON.stringify(practice), quizzes, where);
        const check = ok<Guide & { status: string }>(
          await call('student', 'POST', `/courses/${courseId(code)}/tutor/practice/check`, { questionId: practice.practice.questionId, optionId: practice.practice.options[0]!.id, language }),
        );
        assertGroundedInApproved(check, readable, `${where} check`);
        assertNoAnswerKey(JSON.stringify(check), quizzes, `${where} check`);
      }
    }
  });

  it('5. a quiz cannot be used as study material or as a practice question', async () => {
    const itil = courseId(ITIL);
    const quiz = (await quizzesOf(ITIL))[0]!;
    for (const action of ['explain', 'summarize', 'detail', 'practice']) problem(await call('student', 'POST', `/courses/${itil}/tutor/guide`, { action, activityId: quiz.id, language: 'en' }), 404, 'NOT_FOUND');
    const forged = ok<{ status: string; correctOptionId: string | null }>(
      await call('student', 'POST', `/courses/${itil}/tutor/practice/check`, { questionId: `${quiz.id}~0~00000000`, optionId: 'a', language: 'en' }),
    );
    assert.deepEqual([forged.status, forged.correctOptionId], ['unavailable', null]);
  });

  it('3, 6. draft, submitted, hidden and unapproved revisions stay unreadable; approved, visible lessons are explained', async () => {
    const itil = courseId(ITIL);
    const section = ok<{ items: Array<{ id: string }> }>(await call('instructor', 'GET', `/courses/${itil}/sections?limit=100`)).items[0]!.id;
    const marker = (word: string) => `The ${word} principle states that ${word} reviews happen every week.`;
    const ask = (who: Persona, word: string) => guide(who, ITIL, { action: 'ask', question: `What is the ${word} principle?` });
    const cites = (response: Guide, word: string) => JSON.stringify(response.blocks).includes(word);
    const create = async (word: string, inSection = section) =>
      ok<{ id: string }>(await call('instructor', 'POST', `/courses/${itil}/sections/${inSection}/activities`, { type: 'page', title: `Integrity ${word}`, body: marker(word) }), 201).id;
    const approve = async (id: string) => {
      ok(await call('instructor', 'POST', `/courses/${itil}/activities/${id}/submit`, {}));
      ok(await call('reviewer', 'POST', `/courses/${itil}/activities/${id}/review`, { decision: 'approve' }));
    };

    const draft = await create('quillfeather');
    const submitted = await create('marrowstone');
    ok(await call('instructor', 'POST', `/courses/${itil}/activities/${submitted}/submit`, {}));
    const hiddenSection = ok<{ id: string }>(await call('admin', 'POST', `/courses/${itil}/sections`, { title: 'Integrity hidden unit', isVisible: false }), 201).id;
    const inHidden = await create('vexmoor', hiddenSection);
    await approve(inHidden);
    const hiddenLesson = await create('thornwick');
    await approve(hiddenLesson);
    ok(await call('instructor', 'PUT', `/courses/${itil}/activities/${hiddenLesson}/organization`, { isVisible: false }));
    const revised = await create('glimmerdale');
    await approve(revised);
    ok(await call('instructor', 'PUT', `/courses/${itil}/activities/${revised}`, { title: 'Integrity glimmerdale', body: marker('brackenfold') }));

    for (const word of ['quillfeather', 'marrowstone', 'vexmoor', 'thornwick', 'brackenfold']) {
      const response = await ask('student', word);
      assert.ok(!cites(response, word), `${word}: not readable by students`);
    }
    for (const id of [draft, submitted, inHidden, hiddenLesson]) problem(await call('student', 'POST', `/courses/${itil}/tutor/guide`, { action: 'explain', activityId: id, language: 'en' }), 404, 'NOT_FOUND');

    // Legitimate explanations keep working: the approved version of the revised lesson, and a seeded lesson.
    const approvedVersion = await ask('student', 'glimmerdale');
    assert.equal(approvedVersion.grounding, 'grounded');
    assert.ok(cites(approvedVersion, 'glimmerdale') && !cites(approvedVersion, 'brackenfold'), 'the approved version, not the working copy');
    assertGroundedInApproved(approvedVersion, await readableText(ITIL), 'approved revision');
    const seeded = await guide('student', ITIL, { action: 'ask', question: 'What is value?' });
    assert.equal(seeded.grounding, 'grounded');
    assert.ok(seeded.blocks.some((block) => block.kind === 'quote'));
    assertGroundedInApproved(seeded, await readableText(ITIL), 'seeded lesson');
    const spanish = await guide('student', IAI, { action: 'ask', question: '¿Qué es el aprendizaje supervisado?', language: 'es' });
    assert.equal(spanish.grounding, 'grounded');
    assertGroundedInApproved(spanish, await readableText(IAI), 'Spanish lesson');

    // Course staff read what the course's staff may see (the hidden section's lesson); students never do.
    assert.ok(cites(await ask('instructor', 'vexmoor'), 'vexmoor'));
  });

  it('4. another course’s content stays private', async () => {
    const pmf = courseId(PMF);
    const section = ok<{ items: Array<{ id: string }> }>(await call('instructor', 'GET', `/courses/${pmf}/sections?limit=100`)).items[0]!.id;
    const lesson = ok<{ id: string }>(await call('instructor', 'POST', `/courses/${pmf}/sections/${section}/activities`, { type: 'page', title: 'Integrity saltmarsh', body: 'The saltmarsh baseline is reviewed by the sponsor.' }), 201).id;
    ok(await call('instructor', 'POST', `/courses/${pmf}/activities/${lesson}/submit`, {}));
    ok(await call('reviewer', 'POST', `/courses/${pmf}/activities/${lesson}/review`, { decision: 'approve' }));

    // Readable in its own course, but never through another course's tutor, even for a student enrolled in both.
    assert.ok(JSON.stringify((await guide('student', PMF, { action: 'ask', question: 'What is the saltmarsh baseline?' })).blocks).includes('saltmarsh'));
    assert.ok(!JSON.stringify(await guide('student', ITIL, { action: 'ask', question: 'What is the saltmarsh baseline?' })).includes('saltmarsh'));
    problem(await call('student', 'POST', `/courses/${courseId(ITIL)}/tutor/guide`, { action: 'explain', activityId: lesson, language: 'en' }), 404, 'NOT_FOUND');
    // A learner not enrolled in the course (learnerB: ITIL and IAI only) cannot reach it, nor read it from their courses.
    problem(await call('learnerB', 'POST', `/courses/${pmf}/tutor/guide`, { action: 'start', language: 'en' }), 404, 'NOT_FOUND');
    for (const code of [ITIL, IAI]) assert.ok(!JSON.stringify(await guide('learnerB', code, { action: 'ask', question: 'What is the saltmarsh baseline?' })).includes('saltmarsh'), code);
    // A draft course and an unknown course are refused too.
    problem(await call('student', 'POST', `/courses/${courseId('ITIL4-F-2026-2-B')}/tutor/guide`, { action: 'start', language: 'en' }), 404, 'NOT_FOUND');
    problem(await call('student', 'POST', `/courses/${randomUUID()}/tutor/guide`, { action: 'start', language: 'en' }), 404, 'NOT_FOUND');
  });
});
