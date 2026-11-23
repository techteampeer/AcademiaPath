/**
 * AP-QA-04 (TC-26): the student assignment submission flow in the browser (run through e2e/run.sh against the
 * production build and the demo seed). Assignments take one plain-text submission per student (no attachments).
 *
 * Fixtures: a dedicated course (isolatedCourse) with one approved assignment due in a week; the demo `student` and,
 * as a second student, the demo `ta` account are enrolled as students. AP-QA-04B adds a second course where `ta` is a
 * non-editing instructor, for the grading roles and release. Cleanup deactivates the enrollments, so no other suite
 * sees the courses, the assignments or the submissions.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { API, apiGet, apiWrite, BASE, context, EMAIL, isolatedCourse, launch, leaks, MESSAGES, session, sessionCookies, settle, type Locale, type Role } from './support.ts';

const EN = MESSAGES.en.assignments;
const ES = MESSAGES.es.assignments;
const TAG = Date.now().toString(36).toUpperCase();
const TITLE = `QA04 essay fixture ${TAG}`;
const INSTRUCTIONS = `Explain fixture QA04 in two sentences. ${TAG}`;
const ANSWERS = { student: `Learner answer QA04: the fixture is synthetic. ${TAG}`, ta: `Respuesta QA04: el fixture es sintético. ${TAG}` } as const;
let browser: Browser;
let course: Awaited<ReturnType<typeof isolatedCourse>>;
let assignmentId: string;
let dueAt: string;
/** AP-QA-04B: a second course where `ta` is a NON-EDITING instructor (grading roles and release). */
let graded: Awaited<ReturnType<typeof isolatedCourse>>;
let gradedAssignmentId: string;
const GRADED_TITLE = `QA04 graded fixture ${TAG}`;

type Mine = { acceptingSubmissions: boolean; submission: { id: string; body: string; submittedAt: string; isLate: boolean } | null };
const mine = (role: Role) => apiGet<Mine>(role, `/courses/${course.courseId}/activities/${assignmentId}/submissions/mine`);

/** The stored submissions of this assignment, read directly from the run's disposable PostgreSQL database. */
async function storedSubmissions(): Promise<Array<{ email: string; body: string; submitted_at: Date; is_late: boolean }>> {
  const pg = ((await import(process.env.PG_MODULE!)) as { default: typeof import('pg') }).default;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const sql = 'SELECT u.email, s.body, s.submitted_at, s.is_late FROM assignment_submissions s JOIN users u ON u.id = s.user_id WHERE s.activity_id = $1 ORDER BY u.email';
    return (await client.query(sql, [assignmentId])).rows;
  } finally {
    await client.end();
  }
}

/** A write as `role` that returns the status and problem code instead of throwing. */
async function writeStatus(role: Role, method: 'POST' | 'PUT', pathname: string, body: unknown): Promise<{ status: number; code: string | null }> {
  const { cookies, csrfToken } = await session(role);
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '), origin: BASE, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, code: res.ok ? null : ((JSON.parse(text) as { code?: string }).code ?? null) };
}

/** An assignment, created by the instructor and approved by the design team. */
async function approvedAssignment(target: { courseId: string; sectionId: string }, title: string): Promise<string> {
  const id = (
    await apiWrite<{ id: string }>('instructor', 'POST', `/courses/${target.courseId}/sections/${target.sectionId}/activities`, {
      type: 'assignment',
      title,
      instructions: INSTRUCTIONS,
      dueAt,
      rubric: [{ title: 'Fixture clarity', maxPoints: 5 }],
    })
  ).id;
  await apiWrite('instructor', 'POST', `/courses/${target.courseId}/activities/${id}/submit`, {});
  await apiWrite('reviewer', 'POST', `/courses/${target.courseId}/activities/${id}/review`, { decision: 'approve' });
  return id;
}

/** A GET as `role` that returns the status instead of throwing. */
async function statusOf(role: Role, pathname: string): Promise<number> {
  const cookie = (await sessionCookies(role)).map((c) => `${c.name}=${c.value}`).join('; ');
  return (await fetch(`${API}${pathname}`, { headers: { cookie } })).status;
}

async function open(role: Role, locale: Locale, target = { courseId: '', activityId: '', title: TITLE }): Promise<Page> {
  const courseId = target.courseId || course.courseId;
  const activityId = target.activityId || assignmentId;
  const page = await (await context(browser, locale, role)).newPage();
  await page.goto(`${BASE}/courses/${courseId}`);
  await settle(page);
  await page.getByRole('link', { name: target.title }).first().click();
  await page.waitForURL(new RegExp(`/courses/${courseId}/activities/${activityId}$`));
  await settle(page);
  return page;
}

/** Dates exactly as the page formats them (the browser's own locale data and time zone). */
const deadlineIn = (page: Page, locale: Locale, iso: string) =>
  page.evaluate(
    ([value, tag]) => new Date(value).toLocaleString(tag, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
    [iso, locale === 'es' ? 'es-PE' : 'en-US'] as const,
  );
const dateTimeIn = (page: Page, locale: Locale, iso: string) =>
  page.evaluate(([value, tag]) => new Date(value).toLocaleString(tag, { dateStyle: 'medium', timeStyle: 'short' }), [iso, locale === 'es' ? 'es-PE' : 'en-US'] as const);

async function submitInBrowser(page: Page, role: 'student' | 'ta', locale: Locale) {
  const s = MESSAGES[locale].assignments.student;
  await page.locator('#submission-body').fill(ANSWERS[role]);
  await page.getByRole('button', { name: s.submit, exact: true }).click();
  await page.getByText(s.confirm).waitFor();
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith(`/activities/${assignmentId}/submissions`)),
    page.getByRole('button', { name: s.confirmSubmit, exact: true }).click(),
  ]);
  assert.equal(response.status(), 201, `${role}: the API recorded the submission`);
  await page.getByText(s.recorded).waitFor();
}

before(async () => {
  browser = await launch();
  course = await isolatedCourse(`ZZ-QA04-ASG-${TAG}`, `Assignment fixture course ${TAG}`, [
    ['instructor', 'instructor'],
    ['reviewer', 'design_team'],
    ['student', 'student'],
    ['ta', 'student'],
  ]);
  dueAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  assignmentId = await approvedAssignment(course, TITLE);
  graded = await isolatedCourse(`ZZ-QA04-GRD-${TAG}`, `Grading fixture course ${TAG}`, [
    ['instructor', 'instructor'],
    ['reviewer', 'design_team'],
    ['ta', 'non_editing_instructor'],
    ['student', 'student'],
  ]);
  gradedAssignmentId = await approvedAssignment(graded, GRADED_TITLE);
});

after(async () => {
  await browser?.close();
  await course?.cleanup();
  await graded?.cleanup();
});

describe('TC-26 student assignment submission (AP-QA-04)', () => {
  it('EN: a student opens the assignment, sees instructions and due date, submits text and gets a confirmation; it is stored with its time', async () => {
    const page = await open('student', 'en');
    await page.getByText(INSTRUCTIONS).waitFor();
    const due = page.locator('dt', { hasText: EN.summary.due }).locator('xpath=following-sibling::dd');
    assert.equal(await due.innerText(), await deadlineIn(page, 'en', dueAt));
    await page.getByText(EN.student.once).waitFor();

    const started = Date.now();
    await submitInBrowser(page, 'student', 'en');
    const recorded = await mine('student');
    assert.ok(recorded.submission, 'the API returns the submission');
    assert.equal(recorded.submission.body, ANSWERS.student);
    assert.equal(recorded.acceptingSubmissions, false, 'one submission per student');
    await page.getByText(EN.student.submittedAt(await dateTimeIn(page, 'en', recorded.submission.submittedAt), false)).waitFor();
    await page.getByText(EN.student.pending).waitFor();

    const [row] = (await storedSubmissions()).filter((stored) => stored.email === EMAIL.student);
    assert.ok(row, 'a row in assignment_submissions');
    assert.equal(row.body, ANSWERS.student);
    assert.equal(row.is_late, false);
    assert.ok(Math.abs(row.submitted_at.getTime() - started) < 60_000, 'the server recorded the submission time');
    assert.equal(row.submitted_at.toISOString(), new Date(recorded.submission.submittedAt).toISOString());
    assert.deepEqual(await leaks(page, 'en'), []);
    await page.context().close();
  });

  it('EN: returning to the assignment shows the recorded submission and no way to submit again', async () => {
    const page = await open('student', 'en');
    await page.getByText(ANSWERS.student).waitFor();
    assert.equal(await page.locator('#submission-body').count(), 0);
    assert.equal(await page.getByRole('button', { name: EN.student.submit, exact: true }).count(), 0);
    await page.reload();
    await settle(page);
    await page.getByText(ANSWERS.student).waitFor();
    await page.context().close();
  });

  it('ES: a second student submits in Spanish and sees the Spanish confirmation and due date', async () => {
    const page = await open('ta', 'es');
    const due = page.locator('dt', { hasText: ES.summary.due }).locator('xpath=following-sibling::dd');
    assert.equal(await due.innerText(), await deadlineIn(page, 'es', dueAt));
    await submitInBrowser(page, 'ta', 'es');
    const recorded = (await mine('ta')).submission!;
    await page.getByText(ES.student.submittedAt(await dateTimeIn(page, 'es', recorded.submittedAt), false)).waitFor();
    assert.deepEqual(await leaks(page, 'es'), []);
    await page.context().close();
    assert.deepEqual((await storedSubmissions()).map((row) => row.email).sort(), [EMAIL.student, EMAIL.ta].sort());
  });

  it('the instructor sees both submissions and can open the submitted text', async () => {
    const page = await open('instructor', 'en');
    await page.getByRole('heading', { name: EN.grading.heading }).waitFor();
    for (const role of ['student', 'ta'] as const) {
      await page.getByText(EMAIL[role], { exact: true }).waitFor();
      // Instructors see "Grade" (graders) and others "View"; the button's accessible name always names the student.
      await page.getByRole('button', { name: EN.grading.submissionOf(EMAIL[role]) }).click();
      await page.getByText(ANSWERS[role]).waitFor();
    }
    await page.context().close();
  });

  it("a student cannot see another student's submission", async () => {
    const other = (await mine('ta')).submission!;
    const base = `/courses/${course.courseId}/activities/${assignmentId}/submissions`;
    assert.equal(await statusOf('student', base), 403, 'no list of submissions');
    assert.equal(await statusOf('student', `${base}/${other.id}`), 403, "no other student's submission");
    assert.equal((await mine('student')).submission!.body, ANSWERS.student, '"mine" is only the own submission');
    const page = await open('student', 'en');
    await page.getByText(ANSWERS.student).waitFor();
    assert.equal(await page.getByText(ANSWERS.ta).count(), 0);
    assert.equal(await page.getByRole('heading', { name: EN.grading.heading }).count(), 0, 'no staff submissions panel');
    await page.context().close();
  });

  it('a duplicate or invalid submission is refused and changes nothing; staff cannot submit; there are no attachments', async () => {
    const url = `/courses/${course.courseId}/activities/${assignmentId}/submissions`;
    const before = await storedSubmissions();
    // One final submission per student: a second one is refused (the application's rule, not a resubmission).
    assert.deepEqual(await writeStatus('student', 'POST', url, { body: `A second attempt ${TAG}` }), { status: 409, code: 'SUBMISSION_EXISTS' });
    // Plain text only: empty, blank, too long, unknown fields (for example an attachment) and no body are invalid.
    for (const body of [{ body: '' }, { body: ' \n\t ' }, { body: 'x'.repeat(50_001) }, { body: 'With a file', attachments: ['work.pdf'] }, {}]) {
      assert.deepEqual(await writeStatus('student', 'POST', url, body), { status: 400, code: 'VALIDATION_ERROR' }, JSON.stringify(body).slice(0, 60));
    }
    // Only enrolled students submit.
    for (const role of ['instructor', 'reviewer'] as const) {
      assert.deepEqual(await writeStatus(role, 'POST', url, { body: `Staff text ${TAG}` }), { status: 403, code: 'FORBIDDEN' }, role);
    }
    assert.deepEqual(await storedSubmissions(), before, 'the stored submissions are unchanged');
    const page = await open('student', 'en');
    await page.getByText(ANSWERS.student).waitFor();
    assert.equal(await page.locator('input[type="file"]').count(), 0, 'no file upload on the assignment page');
    await page.context().close();
  });

  it('a non-editing instructor reads and grades submissions but cannot release grades; the student sees the grade only after release', async () => {
    const target = { courseId: graded.courseId, activityId: gradedAssignmentId, title: GRADED_TITLE };
    const base = `/courses/${graded.courseId}/activities/${gradedAssignmentId}`;
    const submission = await apiWrite<{ id: string }>('student', 'POST', `${base}/submissions`, { body: ANSWERS.student });

    // The non-editing instructor sees the submissions and the text, and is offered no release action.
    const page = await open('ta', 'en', target);
    await page.getByRole('heading', { name: EN.grading.heading }).waitFor();
    await page.getByRole('button', { name: EN.grading.submissionOf(EMAIL.student) }).click();
    await page.getByText(ANSWERS.student).waitFor();
    assert.equal(await page.getByRole('button', { name: EN.grading.release }).count(), 0, 'no release button for a non-editing instructor');
    await page.context().close();

    // Their API permissions: read and grade, never release; the design team does not see student work.
    const detail = await apiGet<{ rubric: Array<{ id: string }> }>('ta', `${base}/submissions/${submission.id}`);
    assert.equal((await writeStatus('ta', 'PUT', `${base}/submissions/${submission.id}/grade`, { scores: [{ criterionId: detail.rubric[0]!.id, points: 4 }], feedback: 'Clear.' })).status, 200);
    assert.deepEqual(await writeStatus('ta', 'POST', `${base}/grades/release`, {}), { status: 403, code: 'FORBIDDEN' });
    assert.equal(await statusOf('reviewer', `${base}/submissions`), 403, 'the design team cannot list submissions');
    assert.deepEqual(await writeStatus('ta', 'POST', `${base}/submissions`, { body: `TA text ${TAG}` }), { status: 403, code: 'FORBIDDEN' });

    // Graded but not released: the student still sees "pending". The instructor releases; then the student sees it.
    const pending = (await apiGet<Mine & { submission: { gradeStatus: string; grade: unknown } }>('student', `${base}/submissions/mine`)).submission!;
    assert.deepEqual([pending.gradeStatus, pending.grade], ['pending', null]);
    await apiWrite('instructor', 'POST', `${base}/grades/release`, {});
    const released = (await apiGet<{ submission: { gradeStatus: string; grade: { points: number; maxPoints: number } } }>('student', `${base}/submissions/mine`)).submission;
    assert.deepEqual([released.gradeStatus, released.grade.points, released.grade.maxPoints], ['released', 4, 5]);
    const studentPage = await open('student', 'es', target);
    await studentPage.getByText(ANSWERS.student).waitFor();
    assert.equal(await studentPage.getByText(ES.student.pending).count(), 0, 'no longer pending once released');
    assert.deepEqual(await leaks(studentPage, 'es'), []);
    await studentPage.context().close();
  });
});
