/**
 * The demonstration dataset seeds through the real API, is repeatable without duplicates, and keeps
 * every access rule: published-only courses, hidden drafts, private answer keys, server grading,
 * release before students see grades, approved-only tutor citations and extractive summaries.
 * Runs against a temporary PostgreSQL database (skipped unless TEST_DATABASE_URL is set).
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ACCOUNTS, COURSES, DEMO_TERM, type Persona } from '../../scripts/demo/content.js';
import { DemoApiError, signIn, type Actor } from '../../scripts/demo/api.js';
import { seedDemo, type DemoReport } from '../../scripts/seed-demo.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createTestDatabase, testServerUrl } from '../helpers/database.js';

const PASSWORD = randomBytes(18).toString('base64url');
const ORIGIN = 'http://localhost:3000';
const TABLES = [
  'users',
  'programs',
  'terms',
  'course_templates',
  'course_template_versions',
  'courses',
  'enrollments',
  'sections',
  'activities',
  'quiz_questions',
  'quiz_attempts',
  'assignment_submissions',
  'grades',
  'course_documents',
  'document_summaries',
];
const collapse = (value: string) => value.replace(/\s+/g, ' ');

describe('demo dataset seed (PostgreSQL)', { skip: testServerUrl ? false : 'TEST_DATABASE_URL not set' }, () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let env: NodeJS.ProcessEnv;
  let first: DemoReport;
  let second: DemoReport;
  let app: ReturnType<typeof buildApp>;
  const as = {} as Record<Persona, Actor>;
  const course = (code: string) => first.courses.find((c) => c.code === code)!.id;
  const countRows = async () => {
    const counts: Record<string, number> = {};
    for (const table of TABLES) counts[table] = Number((await database.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
    return counts;
  };
  const expectStatus = async (promise: Promise<unknown>, status: number) => {
    await assert.rejects(promise, (error: unknown) => error instanceof DemoApiError && error.status === status);
  };

  before(async () => {
    database = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'ap-demo-'));
    env = { NODE_ENV: 'test', APP_ORIGINS: ORIGIN, DOCUMENT_STORAGE_DIR: join(root, 'store') };
    first = await seedDemo(database.db, { password: PASSWORD, env, uploadFilesDir: join(root, 'upload-files') });
    app = buildApp({ config: { ...loadConfig(env), loginRateLimit: { max: 1000, windowMs: 60_000 } }, database: database.db });
    await app.ready();
    for (const persona of Object.keys(ACCOUNTS) as Persona[]) as[persona] = await signIn(app, ORIGIN, ACCOUNTS[persona], PASSWORD);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('seeds three published courses and one draft offering in term 2026-2', () => {
    assert.deepEqual(
      first.courses.map((c) => [c.code, c.status]),
      [
        ['ITIL4-F-2026-2-A', 'published'],
        ['PMF-2026-2-A', 'published'],
        ['IAI-2026-2-A', 'published'],
        ['ITIL4-F-2026-2-B', 'draft'],
      ],
    );
    assert.equal(first.counts.courses?.created, 4);
    assert.equal(first.counts.documents?.created, 3);
    assert.equal(first.counts['quiz attempts']?.created, 6);
  });

  it('is repeatable: a second run creates nothing and leaves every table unchanged', async () => {
    const beforeCounts = await countRows();
    second = await seedDemo(database.db, { password: PASSWORD, env, uploadFilesDir: join(root, 'upload-files') });
    for (const [kind, counter] of Object.entries(second.counts)) assert.equal(counter.created, 0, `${kind} created again`);
    assert.deepEqual(await countRows(), beforeCounts);
    assert.deepEqual(second.courses, first.courses);
  });

  it('builds the academic hierarchy: year 2026, terms, reusable programs and subjects with ordered sections', async () => {
    const terms = await as.admin.listAll<{ code: string; academicYear: number }>('/terms');
    assert.deepEqual(terms.filter((t) => t.academicYear === 2026).map((t) => t.code).sort(), ['2026-1', '2026-2']);
    const programs = (await as.admin.listAll<{ code: string }>('/programs')).map((p) => p.code).sort();
    assert.deepEqual(programs, ['CDIA', 'GTI']);
    const subjects = await as.admin.listAll<{ id: string; code: string }>('/course-templates');
    assert.deepEqual(subjects.map((s) => s.code).sort(), ['IAI', 'ITIL4-F', 'PMF']);
    for (const spec of COURSES.filter((c) => c.status === 'published')) {
      const sections = await as.admin.listAll<{ title: string; isVisible: boolean; position: number }>(`/courses/${course(spec.code)}/sections`);
      assert.ok(sections.filter((s) => s.isVisible).length >= 3, spec.code);
      assert.deepEqual(sections.map((s) => s.title), spec.sections.map((s) => s.title), 'sections keep their order');
    }
  });

  it('assigns course roles per course, including one person with different roles in different courses', async () => {
    const { rows } = await database.pool.query<{ code: string; email: string; role: string }>(
      `SELECT c.code, u.email, e.role FROM enrollments e JOIN users u ON u.id = e.user_id JOIN courses c ON c.id = e.course_id WHERE e.status = 'active'`,
    );
    const actual = new Set(rows.map((r) => `${r.code}|${r.email}|${r.role}`));
    const expected = new Set(COURSES.flatMap((c) => c.enrollments.map((e) => `${c.code}|${ACCOUNTS[e.persona]}|${e.role}`)));
    assert.deepEqual(actual, expected);
    assert.ok(actual.has(`ITIL4-F-2026-2-A|${ACCOUNTS.ta}|non_editing_instructor`) && actual.has(`IAI-2026-2-A|${ACCOUNTS.ta}|student`));
  });

  it('shows students only their published courses', async () => {
    const visible = (await as.student.listAll<{ code: string }>('/courses')).map((c) => c.code).sort();
    assert.deepEqual(visible, ['IAI-2026-2-A', 'ITIL4-F-2026-2-A', 'PMF-2026-2-A']);
    await expectStatus(as.student.call('GET', `/courses/${course('ITIL4-F-2026-2-B')}`), 404);
    await expectStatus(as.learnerA.call('GET', `/courses/${course('IAI-2026-2-A')}`), 404);
  });

  it('keeps draft, submitted and returned content and hidden sections away from students', async () => {
    for (const spec of COURSES.filter((c) => c.status === 'published')) {
      const id = course(spec.code);
      const sections = await as.admin.listAll<{ id: string; title: string }>(`/courses/${id}/sections`);
      for (const sectionSpec of spec.sections) {
        const section = sections.find((s) => s.title === sectionSpec.title)!;
        if (!sectionSpec.visible) {
          await expectStatus(as.student.call('GET', `/courses/${id}/sections/${section.id}/activities`), 404);
          continue;
        }
        const titles = (await as.student.listAll<{ title: string }>(`/courses/${id}/sections/${section.id}/activities`)).map((a) => a.title);
        assert.deepEqual(titles, sectionSpec.activities.filter((a) => a.state === 'approved').map((a) => a.title), `${spec.code} / ${sectionSpec.title}`);
        for (const hidden of sectionSpec.activities.filter((a) => a.state !== 'approved')) {
          const staffCopy = (await as.instructor.listAll<{ id: string; title: string }>(`/courses/${id}/sections/${section.id}/activities`)).find((a) => a.title === hidden.title)!;
          await expectStatus(as.student.call('GET', `/courses/${id}/activities/${staffCopy.id}`), 404);
        }
      }
    }
  });

  it('keeps quiz answer keys private and grades attempts on the server', async () => {
    const quizzes = new Map<string, string>();
    for (const code of ['ITIL4-F-2026-2-A', 'PMF-2026-2-A', 'IAI-2026-2-A']) {
      const book = await as.instructor.call<{ columns: Array<{ activityId: string; type: string }> }>('GET', `/courses/${course(code)}/gradebook?limit=100`);
      quizzes.set(code, book.columns.find((c) => c.type === 'quiz')!.activityId);
    }
    await expectStatus(as.student.call('GET', `/courses/${course('ITIL4-F-2026-2-A')}/activities/${quizzes.get('ITIL4-F-2026-2-A')}/questions`), 403);
    const scores = async (code: string) =>
      Object.fromEntries(
        (await as.instructor.listAll<{ student: { email: string }; score: number | null; maxScore: number }>(`/courses/${course(code)}/activities/${quizzes.get(code)}/results`)).map((r) => [
          r.student.email,
          `${r.score}/${r.maxScore}`,
        ]),
      );
    assert.deepEqual(await scores('ITIL4-F-2026-2-A'), { [ACCOUNTS.learnerA]: '4/4', [ACCOUNTS.learnerB]: '1/4' });
    assert.deepEqual(await scores('PMF-2026-2-A'), { [ACCOUNTS.student]: '3/4' });
    assert.deepEqual(await scores('IAI-2026-2-A'), { [ACCOUNTS.learnerB]: '4/4', [ACCOUNTS.student]: '2/4', [ACCOUNTS.ta]: '1/4' });
    const mine = await as.student.call<{ items: Array<{ id: string }> }>('GET', `/courses/${course('IAI-2026-2-A')}/activities/${quizzes.get('IAI-2026-2-A')}/attempts/mine`);
    const attempt = await as.student.call('GET', `/courses/${course('IAI-2026-2-A')}/attempts/${mine.items[0]!.id}`);
    assert.doesNotMatch(JSON.stringify(attempt), /isCorrect|correctAnswer|"score"/);
  });

  it('shows assignment and quiz grades to students only after release', async () => {
    type Grades = { items: Array<{ title: string; type: string; grade: { grade20: number } | null }> };
    const grades = async (who: Persona, code: string) =>
      Object.fromEntries((await as[who].call<Grades>('GET', `/courses/${course(code)}/grades/mine`)).items.map((i) => [i.type, i.grade?.grade20 ?? null]));
    assert.deepEqual(await grades('learnerA', 'ITIL4-F-2026-2-A'), { quiz: 20, assignment: 16 });
    assert.deepEqual(await grades('learnerB', 'ITIL4-F-2026-2-A'), { quiz: null, assignment: null }, 'attempt after the release and ungraded essay stay hidden');
    assert.deepEqual(await grades('student', 'PMF-2026-2-A'), { quiz: 15, assignment: 18 });
    assert.deepEqual(await grades('learnerA', 'PMF-2026-2-A'), { quiz: null, assignment: null }, 'graded after the release: not visible yet');
    assert.deepEqual(await grades('student', 'IAI-2026-2-A'), { quiz: null, assignment: null });
    assert.deepEqual(await grades('student', 'ITIL4-F-2026-2-A'), { quiz: null, assignment: null }, 'left for the live demo');
  });

  it('answers tutor questions only from approved lessons of the course', async () => {
    type Reply = { grounding: string; citations: Array<{ activityId: string; title: string }>; provider: { mode: string } };
    const ask = (code: string, question: string, language: 'en' | 'es') => as.student.call<Reply>('POST', `/courses/${course(code)}/tutor/messages`, { question, language });
    const approvedTitles = (code: string) =>
      new Set(COURSES.find((c) => c.code === code)!.sections.flatMap((s) => (s.visible ? s.activities.filter((a) => a.state === 'approved' && a.kind === 'page').map((a) => a.title) : [])));
    const itil = await ask('ITIL4-F-2026-2-A', 'What are the four dimensions of service management?', 'en');
    assert.equal(itil.grounding, 'grounded');
    assert.equal(itil.provider.mode, 'mock');
    assert.ok(itil.citations.some((c) => c.title === 'The four dimensions of service management'));
    const questions = [
      ['ITIL4-F-2026-2-A', 'How does problem management differ from incident management?', 'en'],
      ['PMF-2026-2-A', 'What is the critical path of a project schedule?', 'en'],
      ['IAI-2026-2-A', '¿Qué es el aprendizaje supervisado?', 'es'],
    ] as const;
    for (const [code, question, language] of questions) {
      const reply = await ask(code, question, language);
      assert.ok(reply.citations.length > 0, `${code}: no citations`);
      for (const citation of reply.citations) assert.ok(approvedTitles(code).has(citation.title), `${code}: cited ${citation.title}`);
    }
    const unreviewed = await ask('ITIL4-F-2026-2-A', 'What is a standard change and a change authority?', 'en');
    assert.ok(!unreviewed.citations.some((c) => c.title === 'Change enablement'), 'submitted lesson is never cited');
  });

  it('summarizes uploaded documents with sentences from their extracted text', async () => {
    const expected = { 'ITIL4-F-2026-2-A': 'pdf', 'PMF-2026-2-A': 'docx', 'IAI-2026-2-A': 'pdf' } as const;
    for (const [code, format] of Object.entries(expected)) {
      const id = course(code);
      const documents: Array<{ id: string }> = [];
      for (const section of await as.admin.listAll<{ id: string }>(`/courses/${id}/sections`)) {
        documents.push(...(await as.student.listAll<{ id: string; type: string }>(`/courses/${id}/sections/${section.id}/activities`).catch(() => [])).filter((a) => a.type === 'file'));
      }
      assert.equal(documents.length, 1, code);
      type Detail = { document: { format: string; extraction: { status: string }; segments: Array<{ text: string }> }; summary: { status: string; provider: { mode: string }; points: Array<{ evidence: { segmentIndex: number; quote: string } }> } };
      const detail = await as.student.call<Detail>('GET', `/courses/${id}/activities/${documents[0]!.id}/document`);
      assert.equal(detail.document.format, format);
      assert.equal(detail.document.extraction.status, 'extracted');
      assert.equal(detail.summary.status, 'ready');
      assert.equal(detail.summary.provider.mode, 'mock');
      assert.ok(detail.summary.points.length >= 2, `${code}: summary points`);
      for (const point of detail.summary.points) {
        assert.ok(collapse(detail.document.segments[point.evidence.segmentIndex]!.text).includes(point.evidence.quote), point.evidence.quote);
      }
    }
  });

  it('enforces course-specific permissions for the demo roles', async () => {
    assert.ok(await as.ta.call('GET', `/courses/${course('ITIL4-F-2026-2-A')}/gradebook?limit=10`));
    await expectStatus(as.ta.call('GET', `/courses/${course('IAI-2026-2-A')}/gradebook?limit=10`), 403);
    assert.ok(await as.ta.call('GET', `/courses/${course('IAI-2026-2-A')}/grades/mine`));
    const sections = await as.admin.listAll<{ id: string; title: string }>(`/courses/${course('ITIL4-F-2026-2-A')}/sections`);
    const module3 = sections.find((s) => s.title.startsWith('Module 3'))!;
    const pending = (await as.reviewer.listAll<{ id: string; title: string; review: { status: string } }>(`/courses/${course('ITIL4-F-2026-2-A')}/sections/${module3.id}/activities`)).find(
      (a) => a.title === 'Change enablement',
    )!;
    assert.equal(pending.review.status, 'submitted');
    await expectStatus(as.instructor.call('POST', `/courses/${course('ITIL4-F-2026-2-A')}/activities/${pending.id}/review`, { decision: 'approve' }), 403);
    await expectStatus(as.ta.call('POST', `/courses/${course('ITIL4-F-2026-2-A')}/sections/${module3.id}/activities`, { type: 'page', title: 'x', body: 'y' }), 403);
  });

  it('contains only synthetic accounts and records audited actions by the acting role', async () => {
    const { rows: people } = await database.pool.query<{ email: string; given_name: string }>('SELECT email, given_name FROM users');
    assert.ok(people.every((p) => p.email.endsWith('@academiapath.example') && p.given_name === 'Demo'), JSON.stringify(people));
    const { rows } = await database.pool.query<{ action: string; email: string }>(
      `SELECT a.action, u.email FROM audit_log a JOIN users u ON u.id = a.actor_user_id WHERE a.action IN ('activity.approved', 'document.uploaded', 'assignment.graded', 'grades.released', 'program.created')`,
    );
    const pairs = new Set(rows.map((r) => `${r.action}|${r.email}`));
    assert.ok(pairs.has(`activity.approved|${ACCOUNTS.reviewer}`));
    assert.ok(pairs.has(`document.uploaded|${ACCOUNTS.instructor}`));
    assert.ok(pairs.has(`program.created|${ACCOUNTS.admin}`));
    assert.ok(![...pairs].some((p) => p.startsWith('activity.approved|') && !p.endsWith(ACCOUNTS.reviewer)), 'only the design team approves');
    const term = await database.pool.query('SELECT code FROM terms WHERE code = $1', [DEMO_TERM]);
    assert.equal(term.rowCount, 1);
  });

  it('writes the files for the live upload step outside the repository', async () => {
    assert.equal(first.uploadFiles.length, 2);
    const pdf = await readFile(first.uploadFiles.find((f) => f.endsWith('.pdf'))!);
    const docx = await readFile(first.uploadFiles.find((f) => f.endsWith('.docx'))!);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.equal(docx.subarray(0, 2).toString(), 'PK');
  });
});
