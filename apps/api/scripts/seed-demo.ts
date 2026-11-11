/**
 * DEVELOPMENT ONLY: seeds the AcademiaPath demonstration dataset (three published courses and one draft
 * offering in term 2026-2) through the real API, signed in as the synthetic role accounts.
 *
 *   DEV_SEED_PASSWORD=... pnpm db:seed:demo
 *
 * - Refuses to run when NODE_ENV=production or when DATABASE_URL points at a non-local host.
 * - Repeatable: every step first looks for existing records (by code, title or the student's own
 *   attempt/submission/grade state) and only creates what is missing; nothing is deleted or reset.
 * - Uses the normal API code paths (authentication, CSRF, Origin, course authorization, review and
 *   approval, server-side grading, document validation and audit records). No demo-only routes.
 * - Uploaded documents are generated in memory and stored in the configured private document
 *   storage (DOCUMENT_STORAGE_DIR). Files for the live upload step are written to DEMO_FILES_DIR.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { signIn, type Actor } from './demo/api.js';
import { DEMO_COMMUNICATIONS, seedCommunications } from './demo/communications.js';
import { DEMO_MESSAGING, seedMessaging } from './demo/messaging.js';
import { DEMO_FORUMS, seedForums } from './demo/forums.js';
import { DEMO_GROUPS, seedGroups } from './demo/groups.js';
import {
  ACCOUNTS,
  COURSES,
  DEMO_LEARNERS,
  DEMO_TERM,
  DEMO_UPLOAD_FILES,
  PROGRAMS,
  TERMS,
  type ActivitySpec,
  type CourseSpec,
  type Persona,
  type QuestionSpec,
  type StudentAction,
} from './demo/content.js';
import { assertDevSeedAllowed, DEV_USERS, upsertSyntheticUsers } from './seed-dev-users.js';

type Ref = { id: string; code: string };
type Template = Ref & { latestVersion: { version: number } | null };
type Course = Ref & { termId: string; status: string };
type Section = { id: string; title: string };
type Activity = {
  id: string;
  title: string;
  type: string;
  review: { status: 'draft' | 'submitted' | 'approved' | 'returned' } | null;
  liveVersion: unknown;
  content: { rubric?: Array<{ id: string }> };
};
type Counter = { created: number; existing: number };

export type DemoReport = {
  counts: Record<string, Counter>;
  courses: Array<{ code: string; id: string; status: string }>;
  uploadFiles: string[];
};

export type SeedDemoOptions = {
  /** The DEV_SEED_PASSWORD shared by the synthetic accounts. */
  password: string;
  env?: NodeJS.ProcessEnv;
  /** Where to write the files for the live upload step (outside the repository); null to skip. */
  uploadFilesDir?: string | null;
};

/** How the dataset steps act as each persona: signed-in API clients over the private in-process API. */
export type DemoActors = (app: FastifyInstance, origin: string, config: AppConfig) => Promise<{ actors: Record<Persona, Actor>; close: () => Promise<void> }>;

export type SeedDatasetOptions = {
  env: NodeJS.ProcessEnv;
  uploadFilesDir?: string | null;
  actors: DemoActors;
};

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function assertOutsideRepository(dir: string): string {
  if (!isAbsolute(dir)) throw new Error('DEMO_FILES_DIR must be an absolute path.');
  const fromRepo = relative(REPOSITORY_ROOT, resolve(dir));
  if (fromRepo === '' || (!fromRepo.startsWith('..') && !isAbsolute(fromRepo))) throw new Error('DEMO_FILES_DIR must be outside the repository.');
  return resolve(dir);
}

/** Local development: every synthetic account shares DEV_SEED_PASSWORD and the seed signs in with it. */
export async function seedDemo(db: Database, options: SeedDemoOptions): Promise<DemoReport> {
  const env = options.env ?? process.env;
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data: NODE_ENV is production.');

  // Accounts: the dev-seed role accounts plus two synthetic learners (password: DEV_SEED_PASSWORD).
  await upsertSyntheticUsers(db, options.password, [...DEV_USERS, ...DEMO_LEARNERS]);
  return seedDemoDataset(db, {
    env,
    uploadFilesDir: options.uploadFilesDir ?? null,
    actors: async (app, origin) => {
      const actors = {} as Record<Persona, Actor>;
      for (const persona of Object.keys(ACCOUNTS) as Persona[]) actors[persona] = await signIn(app, origin, ACCOUNTS[persona], options.password);
      return { actors, close: async () => {} };
    },
  });
}

/**
 * The demonstration dataset (structure, content, review, student work, grades, announcements and calendar)
 * for accounts that already exist. Idempotent; never checks NODE_ENV itself: callers decide where it may run
 * (`seedDemo` for local development, `scripts/seed-cloud-demo.ts` for the approved cloud demo).
 */
export async function seedDemoDataset(db: Database, options: SeedDatasetOptions): Promise<DemoReport> {
  const counts: Record<string, Counter> = {};
  const tally = (kind: string, created: boolean) => {
    counts[kind] ??= { created: 0, existing: 0 };
    counts[kind][created ? 'created' : 'existing'] += 1;
  };

  // A private in-process API instance; only its sign-in rate limit is raised so repeated runs can sign in.
  const base = loadConfig(options.env);
  const config = { ...base, loginRateLimit: { max: 1000, windowMs: base.loginRateLimit.windowMs } };
  const app = buildApp({ config, database: db });
  await app.ready();
  let closeActors = async () => {};
  try {
    const origin = config.allowedOrigins[0] ?? 'http://localhost:3000';
    const opened = await options.actors(app, origin, config);
    closeActors = opened.close;
    const actors = opened.actors;
    const { admin, instructor, reviewer } = actors;

    // ---------------------------------------------------------------- Academic structure (administrator)
    const programs = new Map((await admin.listAll<Ref>('/programs')).map((p) => [p.code, p.id]));
    for (const program of PROGRAMS) {
      if (programs.has(program.code)) tally('programs', false);
      else {
        programs.set(program.code, (await admin.call<Ref>('POST', '/programs', program)).id);
        tally('programs', true);
      }
    }
    const terms = new Map((await admin.listAll<Ref>('/terms')).map((t) => [t.code, t.id]));
    for (const term of TERMS) {
      if (terms.has(term.code)) tally('terms', false);
      else {
        terms.set(term.code, (await admin.call<Ref>('POST', '/terms', term)).id);
        tally('terms', true);
      }
    }
    const termId = terms.get(DEMO_TERM)!;
    const templates = new Map((await admin.listAll<Template>('/course-templates')).map((t) => [t.code, t.id]));
    for (const course of COURSES) {
      if (templates.has(course.subject.code)) {
        if (course.sections.length) tally('subjects', false);
        continue;
      }
      const created = await admin.call<{ templateId: string }>('POST', '/course-templates', {
        code: course.subject.code,
        programId: programs.get(course.program),
        title: course.subject.title,
        description: course.subject.description,
        sections: course.sections.map((section) => ({ title: section.title, isVisible: section.visible })),
      });
      templates.set(course.subject.code, created.templateId);
      tally('subjects', true);
    }
    const existingCourses = (await admin.listAll<Course>('/courses')).filter((c) => c.termId === termId);
    const courseIds = new Map(existingCourses.map((c) => [c.code, c.id]));
    for (const course of COURSES) {
      if (courseIds.has(course.code)) tally('courses', false);
      else {
        const created = await admin.call<Course>('POST', '/courses', {
          programId: programs.get(course.program),
          termId,
          templateId: templates.get(course.subject.code),
          code: course.code,
          title: course.title,
          status: course.status,
        });
        courseIds.set(course.code, created.id);
        tally('courses', true);
      }
      for (const { persona, role } of course.enrollments) {
        const enrolled = await admin.callAllowing(['ENROLLMENT_EXISTS'], 'POST', `/courses/${courseIds.get(course.code)}/enrollments`, { email: ACCOUNTS[persona], role });
        tally('enrollments', enrolled !== null);
      }
    }

    // ---------------------------------------------------------------- Content and review (instructor, design team)
    for (const course of COURSES) {
      const courseId = courseIds.get(course.code)!;
      if (!course.sections.length) continue;
      const sections = await admin.listAll<Section>(`/courses/${courseId}/sections`);
      for (const sectionSpec of course.sections) {
        const section = sections.find((s) => s.title === sectionSpec.title);
        if (!section) throw new Error(`Course ${course.code} has no section "${sectionSpec.title}" (an existing subject ${course.subject.code} has different sections).`);
        for (const spec of sectionSpec.activities) {
          const activity = await ensureActivity(instructor, courseId, section.id, spec, tally);
          await applyReviewTarget(instructor, reviewer, courseId, activity, spec, tally);
        }
      }
    }

    // ---------------------------------------------------------------- Student work, grading and release
    for (const course of COURSES) {
      const courseId = courseIds.get(course.code)!;
      if (!course.actions.length) continue;
      const activities = new Map<string, Activity>();
      for (const section of await admin.listAll<Section>(`/courses/${courseId}/sections`)) {
        for (const activity of await instructor.listAll<Activity>(`/courses/${courseId}/sections/${section.id}/activities`)) activities.set(activity.title, activity);
      }
      for (const action of course.actions) await runAction(actors, courseId, activities, action, tally);
    }

    // ---------------------------------------------------------------- Announcements and calendar (AP-025)
    await seedCommunications({ instructor, admin }, courseIds.get(DEMO_COMMUNICATIONS.courseCode)!, tally);

    // ---------------------------------------------------------------- Messages (AP-026)
    await seedMessaging(actors, courseIds.get(DEMO_MESSAGING.courseCode)!, tally);

    // ---------------------------------------------------------------- Course forum (AP-027)
    await seedForums(actors, courseIds.get(DEMO_FORUMS.courseCode)!, tally);

    // ---------------------------------------------------------------- Student groups (AP-028)
    await seedGroups(actors, courseIds.get(DEMO_GROUPS.courseCode)!, tally);

    // ---------------------------------------------------------------- Files for the live upload step
    const uploadFiles: string[] = [];
    if (options.uploadFilesDir) {
      const dir = assertOutsideRepository(options.uploadFilesDir);
      await mkdir(dir, { recursive: true });
      for (const file of DEMO_UPLOAD_FILES) {
        const path = join(dir, file.name);
        await writeFile(path, file.build());
        uploadFiles.push(path);
      }
    }

    const all = await admin.listAll<Course>('/courses');
    return {
      counts,
      courses: COURSES.map((c) => ({ code: c.code, id: courseIds.get(c.code)!, status: all.find((x) => x.code === c.code && x.termId === termId)?.status ?? c.status })),
      uploadFiles,
    };
  } finally {
    await closeActors();
    await app.close();
  }
}

async function ensureActivity(instructor: Actor, courseId: string, sectionId: string, spec: ActivitySpec, tally: (kind: string, created: boolean) => void): Promise<Activity> {
  const list = `/courses/${courseId}/sections/${sectionId}/activities`;
  let activity = (await instructor.listAll<Activity>(list)).find((a) => a.title === spec.title);
  const kind = { page: 'pages', link: 'links', quiz: 'quizzes', assignment: 'assignments', document: 'documents' }[spec.kind];
  if (activity) tally(kind, false);
  else {
    if (spec.kind === 'document') {
      const uploaded = await instructor.upload<{ activityId: string }>(`/courses/${courseId}/sections/${sectionId}/documents`, { name: spec.fileName, bytes: spec.build(), title: spec.title });
      activity = await instructor.call<Activity>('GET', `/courses/${courseId}/activities/${uploaded.activityId}`);
    } else {
      const body =
        spec.kind === 'page'
          ? { type: 'page', title: spec.title, body: spec.body }
          : spec.kind === 'link'
            ? { type: 'link', title: spec.title, url: spec.url, description: spec.description }
            : spec.kind === 'quiz'
              ? { type: 'quiz', title: spec.title, instructions: spec.instructions, attemptLimit: spec.attemptLimit, timeLimitMinutes: spec.timeLimitMinutes, shuffleQuestions: false, shuffleOptions: false }
              : { type: 'assignment', title: spec.title, instructions: spec.instructions, dueAt: spec.dueAt, lateUntil: null, rubric: spec.rubric };
      activity = await instructor.call<Activity>('POST', list, body);
    }
    tally(kind, true);
  }
  // Quiz questions (also completes a quiz left without questions by an interrupted run).
  if (spec.kind === 'quiz') {
    const questions = await instructor.call<{ items: unknown[] }>('GET', `/courses/${courseId}/activities/${activity.id}/questions`);
    if (questions.items.length === 0 && activity.review?.status !== 'approved') {
      for (const question of spec.questions) {
        await instructor.call('POST', `/courses/${courseId}/activities/${activity.id}/questions`, questionInput(question));
        tally('quiz questions', true);
      }
    } else tally('quiz questions', false);
  }
  return activity;
}

function questionInput(question: QuestionSpec) {
  if (question.type === 'true_false') return { type: 'true_false', prompt: question.prompt, points: question.points, correctAnswer: question.answer };
  return { type: question.type, prompt: question.prompt, points: question.points, options: question.options.map((o) => ({ text: o.text, isCorrect: o.correct === true })) };
}

/**
 * Moves seeded content to its demo review state through the normal workflow: the instructor submits and
 * the design team decides. Only unfinished seed states are advanced (a never-approved draft, or a
 * submission waiting for its seeded decision); anything a person returned, approved or edited after
 * approval is left exactly as it is.
 */
async function applyReviewTarget(instructor: Actor, reviewer: Actor, courseId: string, activity: Activity, spec: ActivitySpec, tally: (kind: string, created: boolean) => void) {
  const path = `/courses/${courseId}/activities/${activity.id}`;
  let status = activity.review?.status ?? 'draft';
  const before = status;
  if (spec.state === 'draft') return;
  const freshDraft = status === 'draft' && activity.liveVersion === null;
  if (freshDraft) status = (await instructor.call<Activity>('POST', `${path}/submit`)).review!.status;
  if (status === 'submitted' && spec.state === 'approved') status = (await reviewer.call<Activity>('POST', `${path}/review`, { decision: 'approve' })).review!.status;
  if (status === 'submitted' && spec.state === 'returned') {
    status = (await reviewer.call<Activity>('POST', `${path}/review`, { decision: 'return', comment: spec.returnComment ?? 'Please revise before resubmitting.' })).review!.status;
  }
  tally('review transitions', status !== before);
}

async function runAction(actors: Record<Persona, Actor>, courseId: string, activities: Map<string, Activity>, action: StudentAction, tally: (kind: string, created: boolean) => void) {
  const title = action.kind === 'quiz' ? action.quiz : action.kind === 'release' ? action.activity : action.assignment;
  const activity = activities.get(title);
  if (!activity) throw new Error(`Activity "${title}" not found in course ${courseId}.`);
  const path = `/courses/${courseId}/activities/${activity.id}`;

  if (action.kind === 'quiz') {
    const student = actors[action.student];
    const mine = await student.call<{ attemptsUsed: number; activeAttemptId: string | null }>('GET', `${path}/attempts/mine`);
    if (mine.attemptsUsed > 0 && !mine.activeAttemptId) return tally('quiz attempts', false);
    type Attempt = { id: string; questions: Array<{ questionId: string; prompt: string; options: Array<{ id: string; text: string }> }> };
    const attempt = mine.activeAttemptId
      ? await student.call<Attempt>('GET', `/courses/${courseId}/attempts/${mine.activeAttemptId}`)
      : await student.call<Attempt>('POST', `${path}/attempts`);
    const answers = attempt.questions.map((question) => {
      const chosen = action.answers[question.prompt];
      if (!chosen) throw new Error(`No demo answer for "${question.prompt}".`);
      const selected = question.options.filter((option) => chosen.includes(option.text)).map((option) => option.id);
      if (selected.length !== chosen.length) throw new Error(`Demo answer does not match the options of "${question.prompt}".`);
      return { questionId: question.questionId, selectedOptionIds: selected };
    });
    await student.call('POST', `/courses/${courseId}/attempts/${attempt.id}/submit`, { answers });
    return tally('quiz attempts', true);
  }

  if (action.kind === 'submit') {
    const student = actors[action.student];
    const mine = await student.call<{ submission: unknown }>('GET', `${path}/submissions/mine`);
    if (mine.submission) return tally('assignment submissions', false);
    await student.call('POST', `${path}/submissions`, { body: action.body });
    return tally('assignment submissions', true);
  }

  const grader = actors[action.grader];
  if (action.kind === 'grade') {
    type Row = { id: string; status: string; student: { email: string } };
    const row = (await grader.listAll<Row>(`${path}/submissions`)).find((r) => r.student.email === ACCOUNTS[action.student]);
    if (!row) throw new Error(`No submission from ${ACCOUNTS[action.student]} for "${title}".`);
    if (row.status !== 'needs_grading') return tally('grades', false);
    const detail = await grader.call<{ rubric: Array<{ id: string }> }>('GET', `${path}/submissions/${row.id}`);
    await grader.call('PUT', `${path}/submissions/${row.id}/grade`, {
      scores: detail.rubric.map((criterion, index) => ({ criterionId: criterion.id, points: action.scores[index] ?? 0 })),
      feedback: action.feedback,
    });
    return tally('grades', true);
  }

  // Release: skipped once the reference student's grade is released, so later grading stays unreleased on re-runs.
  type Book = { items: Array<{ student: { email: string }; cells: Array<{ activityId: string; status: string }> }> };
  const book = await grader.call<Book>('GET', `/courses/${courseId}/gradebook?limit=100`);
  const cell = book.items.find((r) => r.student.email === ACCOUNTS[action.whenNotReleasedFor])?.cells.find((c) => c.activityId === activity.id);
  if (cell?.status === 'released') return tally('grade releases', false);
  await grader.call('POST', `${path}/grades/release`);
  tally('grade releases', true);
}

async function main() {
  const { databaseUrl, password } = assertDevSeedAllowed(process.env);
  const { db, pool } = createDatabase(databaseUrl);
  try {
    const report = await seedDemo(db, {
      password,
      env: process.env,
      uploadFilesDir: process.env.DEMO_FILES_DIR?.trim() || resolve(homedir(), '.academiapath', 'demo-files'),
    });
    console.log('AcademiaPath demo dataset (synthetic). Sign in with the dev seed accounts; password = DEV_SEED_PASSWORD.');
    for (const course of report.courses) console.log(`  ${course.code.padEnd(18)} ${course.status.padEnd(10)} /courses/${course.id}`);
    console.log('Records (created / already present):');
    for (const [kind, { created, existing }] of Object.entries(report.counts)) console.log(`  ${kind.padEnd(24)} ${String(created).padStart(3)} / ${existing}`);
    if (report.uploadFiles.length) console.log(`Files for the live upload step:\n${report.uploadFiles.map((f) => `  ${f}`).join('\n')}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Demo seeding failed.');
    process.exitCode = 1;
  });
}
