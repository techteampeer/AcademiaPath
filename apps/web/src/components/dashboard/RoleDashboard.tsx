'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { LocalizedCourseStatusBadge as CourseStatusBadge } from '@/components/courses/LocalizedCourseStatusBadge';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { useWorkspace } from '@/components/session/WorkspaceProvider';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingCards, Skeleton } from '@/components/ui/Skeleton';
import { ProgressBar } from '@/components/progress/ProgressDisplay';
import { DashboardCommunications } from '@/components/communications/DashboardCommunications';
import { CourseEmblem, HeritageBanner, Icon, type IconName } from '@/components/layout/Heritage';
import { DashboardCommunity, DashboardRecentActivity } from './DashboardCommunity';
import { isApiError } from '@/lib/api/client';
import { api, loadAll } from '@/lib/api/endpoints';
import type { Activity, Course, CourseRole, CurrentUser, GradeStatus } from '@/lib/api/types';
import { formatDateTime, type Messages } from '@/lib/i18n/messages';

/** Detailed figures are loaded for at most this many courses per role (bounded requests). */
const DETAIL_LIMIT = 8;
const SECTION_LIMIT = 20;
const ROLE_ORDER: CourseRole[] = ['student', 'instructor', 'non_editing_instructor', 'design_team'];

export function RoleDashboard() {
  return <RequireAuth>{(user) => <DashboardContent user={user} />}</RequireAuth>;
}

type PartOfDay = 'morning' | 'afternoon' | 'evening';
const partOfDay = (hour: number): PartOfDay => (hour < 12 ? 'morning' : hour < 19 ? 'afternoon' : 'evening');

/**
 * The collegiate welcome banner: today's date, the dashboard title and a greeting with the person's real name,
 * and a sentence matching the role they hold. The level-1 heading keeps the dashboard title first.
 */
function DashboardBanner({ user, primary, multipleRoles }: { user: CurrentUser; primary: CourseRole | 'administrator' | null; multipleRoles: boolean }) {
  const { t, locale } = useLocale();
  const d = t.dashboard;
  const [now] = useState(() => new Date());
  const today = now.toLocaleDateString(locale === 'es' ? 'es-PE' : 'en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <HeritageBanner>
      <div className="max-w-xl">
        <p className="text-sm font-medium text-gold-200 first-letter:uppercase">{today}</p>
        <h1 className="mt-3">
          <span className="block font-sans text-xs font-semibold tracking-[0.16em] text-gold-200 uppercase">{d.title}</span>
          <span className="mt-1.5 block text-[2rem] leading-tight font-semibold break-words text-ivory sm:text-[2.6rem]">{d.greeting(partOfDay(now.getHours()), user.givenName)}</span>
        </h1>
        <div aria-hidden="true" className="heritage-rule mt-4 w-32" />
        <p className="mt-4 text-ivory/90">{primary ? d.subtitle[primary] : d.welcome(user.givenName)}</p>
        {multipleRoles || !primary ? <p className="mt-1 text-sm text-ivory/80">{d.rolesIntro}</p> : null}
      </div>
    </HeritageBanner>
  );
}

function DashboardContent({ user }: { user: CurrentUser }) {
  const { t } = useLocale();
  const workspace = useWorkspace();
  const ready = workspace.status === 'ready';
  const courseRoles = ready ? ROLE_ORDER.filter((role) => workspace.courses.some((course) => course.viewerRole === role)) : [];
  const primary = courseRoles[0] ?? (user.systemRole === 'administrator' ? 'administrator' : null);
  const header = <DashboardBanner user={user} primary={ready ? primary : null} multipleRoles={courseRoles.length > 1} />;

  if (workspace.status === 'loading' || workspace.status === 'idle') {
    return (
      <div className="space-y-6">
        {header}
        <LoadingCards label={t.common.loading} />
      </div>
    );
  }
  if (workspace.status === 'error') {
    return (
      <div className="space-y-6">
        {header}
        <Alert tone="error">
          {t.common.loadError}{' '}
          <button type="button" className="font-medium underline" onClick={() => void workspace.reload()}>
            {t.common.retry}
          </button>
        </Alert>
      </div>
    );
  }

  const byRole = (role: CourseRole) => workspace.courses.filter((course) => course.viewerRole === role);
  const roles = courseRoles;
  return (
    <div className="space-y-8">
      {header}
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 space-y-10">
          {roles.length === 0 ? (
            user.systemRole === 'administrator' ? (
              <Card className="flex flex-wrap items-center justify-between gap-4">
                <p className="text-sm text-slate-700">{t.dashboard.adminNoCourses}</p>
                <Link href="/admin" className={buttonClasses()}>
                  {t.dashboard.goToAdmin}
                </Link>
              </Card>
            ) : (
              <EmptyState title={t.dashboard.noCourses} description={t.dashboard.noCoursesHelp} />
            )
          ) : null}
          {roles.map((role) => (
            <RoleSection key={role} role={role} courses={byRole(role)} />
          ))}
          <DashboardCommunications user={user} />
        </div>
        <div className="min-w-0 space-y-6">
          <DashboardCommunity courses={workspace.courses} isStudent={roles.includes('student')} />
          <DashboardRecentActivity />
        </div>
      </div>
    </div>
  );
}

const SECTION_ICON: Record<CourseRole, IconName> = { student: 'book', instructor: 'columns', non_editing_instructor: 'chart', design_team: 'layers' };

const SECTION_TEXT: Record<CourseRole, (t: Messages) => { title: string; intro: string }> = {
  student: (t) => ({ title: t.dashboard.learningTitle, intro: t.dashboard.learningIntro }),
  instructor: (t) => ({ title: t.dashboard.teachingTitle, intro: t.dashboard.teachingIntro }),
  non_editing_instructor: (t) => ({ title: t.dashboard.gradingTitle, intro: t.dashboard.gradingIntro }),
  design_team: (t) => ({ title: t.dashboard.reviewTitle, intro: t.dashboard.reviewIntro }),
};

function RoleSection({ role, courses }: { role: CourseRole; courses: Course[] }) {
  const { t } = useLocale();
  const text = SECTION_TEXT[role](t);
  const detailed = courses.slice(0, DETAIL_LIMIT);
  const headingId = `section-${role}`;
  return (
    <section aria-labelledby={headingId} className="space-y-4" data-role-section={role}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id={headingId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[1.4rem] font-semibold text-brand-600">
            <Icon name={SECTION_ICON[role]} className="h-6 w-6 shrink-0 text-gold-600" />
            {text.title} <Badge tone="gold" className="ml-1 align-middle font-sans">{t.roles[role]}</Badge>
          </h2>
          <p className="mt-1 text-sm text-slate-600">{text.intro}</p>
        </div>
      </div>
      <div aria-hidden="true" className="heritage-rule w-24" />
      {courses.length > DETAIL_LIMIT ? <p className="text-xs text-slate-500">{t.dashboard.partial(DETAIL_LIMIT, courses.length)}</p> : null}
      <ul className="grid gap-5 lg:grid-cols-2">
        {detailed.map((course) => (
          <li key={course.id}>
            <RoleCourseCard role={role} course={course} />
          </li>
        ))}
      </ul>
      {courses.length > DETAIL_LIMIT ? (
        <ul className="flex flex-wrap gap-2 text-sm">
          {courses.slice(DETAIL_LIMIT).map((course) => (
            <li key={course.id}>
              <Link href={`/courses/${course.id}`} className="text-brand-700 hover:underline">
                {course.code}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- per-course data (existing endpoints)

type Load<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T };

function useLoad<T>(loader: () => Promise<T>, deps: unknown[]): Load<T> {
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loader()
      .then((data) => !cancelled && setState({ status: 'ready', data }))
      .catch((error: unknown) => {
        if (isApiError(error, 401)) handleUnauthorized();
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/**
 * Sections and activities the caller may see (students: approved, visible only — enforced by the API).
 * Sections a prerequisite still locks are skipped: the API refuses them with 403 SECTION_LOCKED.
 */
async function loadActivities(courseId: string, locked: ReadonlySet<string> = new Set()): Promise<Activity[]> {
  const sections = (await loadAll((page) => api.listSections(courseId, page), 2)).slice(0, SECTION_LIMIT).filter((section) => !locked.has(section.id));
  const lists = await Promise.all(
    sections.map((section) =>
      loadAll((page) => api.listActivities(courseId, section.id, page), 2).catch((error: unknown) => {
        if (isApiError(error, 403) && error.code === 'SECTION_LOCKED') return [] as Activity[];
        throw error;
      }),
    ),
  );
  return lists.flat();
}

/** Progress of the course's students (staff overview, read-only, calculated by the API). */
async function loadStudentProgressCounts(courseId: string) {
  const page = await api.studentProgress(courseId, { limit: 100 });
  return {
    students: page.items.length,
    finished: page.items.filter((row) => row.state === 'completed').length,
    notStarted: page.items.filter((row) => row.state === 'not_started').length,
    partial: page.nextCursor !== null,
  };
}

/** Grading status counts from the course gradebook (server-calculated). */
async function loadGradingCounts(courseId: string) {
  const book = await api.getGradebook(courseId, { limit: 100 });
  const counts: Partial<Record<GradeStatus, number>> = {};
  const needsGrading: Array<{ student: string; activity: string; activityId: string }> = [];
  for (const row of book.items) {
    row.cells.forEach((cell, index) => {
      counts[cell.status] = (counts[cell.status] ?? 0) + 1;
      const column = book.columns[index];
      if (cell.status === 'needs_grading' && column) {
        needsGrading.push({ student: `${row.student.givenName} ${row.student.familyName}`, activity: column.title, activityId: column.activityId });
      }
    });
  }
  return { counts, needsGrading, partial: book.nextCursor !== null };
}

/** Student to-do items (open assignments not yet submitted, quizzes not yet attempted) and learning progress. */
/**
 * A student's card: progress, released grades and what is still to do. `grades/mine` already lists the approved,
 * visible quizzes and assignments of unlocked sections in course order with the student's work status, so the to-do
 * list comes from it in one parallel round (no section → activity → per-activity walk): a quiz is to do when it
 * has no attempt (`not_submitted`), and only assignments without a submission need their window checked.
 */
async function loadStudentData(courseId: string) {
  const [progress, grades] = await Promise.all([api.courseProgress(courseId), api.myGrades(courseId)]);
  const open = grades.items.filter((item) => item.workStatus === 'not_submitted');
  const assignments = open.filter((item) => item.type === 'assignment').slice(0, 10);
  const quizzes = open.filter((item) => item.type === 'quiz').slice(0, 10);
  const assignmentStates = await Promise.all(
    assignments.map((item) => api.myAssignmentStatus(courseId, item.activityId).then((status) => ({ item, status }))),
  );
  const todo = [
    ...assignmentStates
      .filter(({ status }) => status.acceptingSubmissions && !status.submission)
      .map(({ item, status }) => ({ id: item.activityId, title: item.title, kind: 'assignment' as const, due: status.dueAt })),
    ...quizzes.map((item) => ({ id: item.activityId, title: item.title, kind: 'quiz' as const, due: null as string | null })),
  ].sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  return { grades, todo, progress };
}

// ---------------------------------------------------------------- cards

function CardShell({ course, role, children, actions }: { course: Course; role: CourseRole; children: ReactNode; actions: ReactNode }) {
  const { t } = useLocale();
  return (
    <Card as="article" padding="none" className="flex h-full flex-col overflow-hidden" aria-labelledby={`card-${role}-${course.id}`}>
      <div className="flex items-start gap-4 border-b border-slate-200 bg-parchment/60 p-5">
        <CourseEmblem code={course.code} className="h-16 w-14 sm:h-[4.5rem] sm:w-16" />
        <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            <h3 id={`card-${role}-${course.id}`} className="text-lg leading-snug font-semibold break-words text-brand-600">
              <Link href={`/courses/${course.id}`} className="hover:text-brand-700 hover:underline">
                {course.title}
              </Link>
            </h3>
            <p className="mt-0.5 text-xs text-slate-600">
              {course.code} · {t.roles[role]}
            </p>
          </div>
          <CourseStatusBadge status={course.status} />
        </div>
      </div>
      <div className="flex-1 space-y-4 p-5 text-sm">{children}</div>
      <div className="flex flex-wrap gap-2 border-t border-slate-200 bg-slate-50/70 px-5 py-3">{actions}</div>
    </Card>
  );
}

/**
 * Column count follows the number of figures so rows stay even, on phones as well (literal classes for Tailwind):
 * three or five figures use three compact columns instead of leaving half-empty rows.
 */
const FIGURE_COLUMNS: Record<number, string> = { 3: 'grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4', 5: 'grid-cols-3' };

function Figures({ items }: { items: Array<{ label: string; value: number; tone?: 'warn' }> }) {
  return (
    <dl className={`grid gap-1.5 sm:gap-2 ${FIGURE_COLUMNS[items.length] ?? 'grid-cols-2 sm:grid-cols-4'}`}>
      {items.map((item) => (
        <div key={item.label} className={`rounded-md border px-2 py-1.5 sm:px-3 sm:py-2 ${item.tone === 'warn' && item.value > 0 ? 'border-amber-200 bg-amber-50' : 'border-slate-200/70 bg-slate-50'}`}>
          <dt className="text-xs leading-snug break-words text-slate-600">{item.label}</dt>
          <dd className="font-serif text-lg font-semibold text-brand-600 sm:text-xl">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailState({ state }: { state: { status: 'loading' } | { status: 'error' } }) {
  const { t } = useLocale();
  if (state.status === 'error') return <p className="text-sm text-red-700">{t.common.loadError}</p>;
  return (
    <div>
      <span className="sr-only" role="status">
        {t.common.loading}
      </span>
      <Skeleton className="h-14 w-full" />
    </div>
  );
}

const linkClass = buttonClasses({ variant: 'secondary', size: 'sm' });

function RoleCourseCard({ role, course }: { role: CourseRole; course: Course }) {
  if (role === 'design_team') return <ReviewCard course={course} />;
  if (role === 'student') return <StudentCard course={course} />;
  return <TeachingCard course={course} role={role} />;
}

function ReviewCard({ course }: { course: Course }) {
  const { t } = useLocale();
  const state = useLoad(() => loadActivities(course.id), [course.id]);
  return (
    <CardShell
      course={course}
      role="design_team"
      actions={
        <Link href={`/courses/${course.id}`} className={linkClass}>
          {t.dashboard.openCourse}
        </Link>
      }
    >
      {state.status !== 'ready' ? (
        <DetailState state={state} />
      ) : (
        (() => {
          const count = (status: string) => state.data.filter((a) => a.review?.status === status).length;
          const pending = state.data.filter((a) => a.review?.status === 'submitted');
          return (
            <>
              <Figures
                items={[
                  { label: t.dashboard.awaitingReview, value: pending.length, tone: 'warn' },
                  { label: t.dashboard.approvedCount, value: count('approved') },
                  { label: t.dashboard.returnedCount, value: count('returned') },
                  { label: t.dashboard.draftCount, value: count('draft') },
                ]}
              />
              {pending.length ? (
                <ul className="space-y-1" aria-label={t.dashboard.awaitingReview}>
                  {pending.slice(0, 5).map((activity) => (
                    <li key={activity.id}>
                      <Link href={`/courses/${course.id}/activities/${activity.id}`} className="font-medium text-brand-700 hover:underline">
                        {activity.title}
                      </Link>
                      <span className="text-xs text-slate-500"> · {t.activityType[activity.type]}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-slate-600">{t.dashboard.nothingToReview}</p>
              )}
            </>
          );
        })()
      )}
    </CardShell>
  );
}

function TeachingCard({ course, role }: { course: Course; role: 'instructor' | 'non_editing_instructor' }) {
  const { t } = useLocale();
  const content = useLoad(() => loadActivities(course.id), [course.id]);
  const grading = useLoad(() => loadGradingCounts(course.id), [course.id]);
  const learners = useLoad(() => loadStudentProgressCounts(course.id), [course.id]);
  const byType = (type: Activity['type']) => (content.status === 'ready' ? content.data.filter((a) => a.type === type).length : 0);
  return (
    <CardShell
      course={course}
      role={role}
      actions={
        <>
          <Link href={`/courses/${course.id}`} className={linkClass}>
            {t.dashboard.courseContent}
          </Link>
          <Link href={`/courses/${course.id}/grades`} className={linkClass}>
            {t.nav.gradebook}
          </Link>
          <Link href={`/courses/${course.id}/progress`} className={linkClass}>
            {t.progress.studentProgress}
          </Link>
          <Link href={`/courses/${course.id}/tutor`} className={linkClass}>
            {t.nav.tutor}
          </Link>
          <Link href={`/courses/${course.id}/announcements`} className={linkClass}>
            {t.nav.announcements}
          </Link>
          <Link href={`/courses/${course.id}/calendar`} className={linkClass}>
            {t.nav.calendar}
          </Link>
          {role === 'instructor' ? (
            <>
              <Link href={`/courses/${course.id}/announcements#new-announcement`} className={linkClass} data-new-announcement={course.code}>
                {t.communications.dashboard.newAnnouncement}
              </Link>
              <Link href={`/courses/${course.id}/calendar#new-event`} className={linkClass} data-new-event={course.code}>
                {t.communications.dashboard.newEvent}
              </Link>
            </>
          ) : null}
        </>
      }
    >
      {learners.status !== 'ready' ? (
        <DetailState state={learners} />
      ) : (
        <div aria-label={t.progress.studentProgress} role="group">
          <Figures
            items={[
              { label: t.progress.studentsLabel, value: learners.data.students },
              { label: t.progress.finishedAll, value: learners.data.finished },
              { label: t.progress.notStartedCount, value: learners.data.notStarted, tone: 'warn' },
            ]}
          />
        </div>
      )}
      {content.status !== 'ready' ? (
        <DetailState state={content} />
      ) : (
        <Figures
          items={[
            { label: t.dashboard.lessons, value: byType('page') },
            { label: t.dashboard.resources, value: byType('link') },
            { label: t.dashboard.quizzes, value: byType('quiz') },
            { label: t.dashboard.assignments, value: byType('assignment') },
            { label: t.dashboard.documents, value: byType('file') },
          ]}
        />
      )}
      {grading.status !== 'ready' ? (
        <DetailState state={grading} />
      ) : (
        <>
          <Figures
            items={[
              { label: t.dashboard.needsGrading, value: grading.data.counts.needs_grading ?? 0, tone: 'warn' },
              { label: t.dashboard.unreleased, value: grading.data.counts.unreleased ?? 0, tone: 'warn' },
              { label: t.dashboard.changedSinceRelease, value: grading.data.counts.changed_since_release ?? 0, tone: 'warn' },
            ]}
          />
          {grading.data.needsGrading.length ? (
            <ul className="space-y-1" aria-label={t.dashboard.needsGrading}>
              {grading.data.needsGrading.slice(0, 5).map((item) => (
                <li key={`${item.activityId}-${item.student}`}>
                  <Link href={`/courses/${course.id}/activities/${item.activityId}`} className="font-medium text-brand-700 hover:underline">
                    {item.activity}
                  </Link>
                  <span className="text-xs text-slate-500"> · {item.student}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-slate-600">{t.dashboard.nothingToGrade}</p>
          )}
        </>
      )}
    </CardShell>
  );
}

function StudentCard({ course }: { course: Course }) {
  const { t, locale } = useLocale();
  const state = useLoad(() => loadStudentData(course.id), [course.id]);
  return (
    <CardShell
      course={course}
      role="student"
      actions={
        <>
          <Link href={`/courses/${course.id}`} className={linkClass}>
            {t.dashboard.openCourse}
          </Link>
          <Link href={`/courses/${course.id}/grades`} className={linkClass}>
            {t.nav.myGrades}
          </Link>
          <Link href={`/courses/${course.id}/tutor`} className={linkClass}>
            {t.nav.tutor}
          </Link>
          <Link href={`/courses/${course.id}/announcements`} className={linkClass}>
            {t.nav.announcements}
          </Link>
          <Link href={`/courses/${course.id}/calendar`} className={linkClass}>
            {t.nav.calendar}
          </Link>
        </>
      }
    >
      {state.status !== 'ready' ? (
        <DetailState state={state} />
      ) : (
        <>
          <div className="space-y-2" data-progress-card>
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{t.progress.yourProgress}</p>
            <ProgressBar figures={state.data.progress} label={t.progress.progressOf(course.title)} />
            {state.data.progress.continueAt ? (
              <Link href={`/courses/${course.id}/activities/${state.data.progress.continueAt.activityId}`} className={buttonClasses({ size: 'sm' })}>
                {t.progress.continueLearning}
                <span className="sr-only">: {state.data.progress.continueAt.title}</span>
              </Link>
            ) : null}
          </div>
          <div>
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{t.dashboard.releasedGrades}</p>
            {state.data.grades.total.gradedItems > 0 ? (
              <p className="mt-1 text-slate-800">
                <span className="text-lg font-semibold">{state.data.grades.total.grade20?.toFixed(1)} / 20</span>{' '}
                <span className="text-xs text-slate-500">
                  {t.dashboard.courseTotal} · {t.dashboard.gradedItems(state.data.grades.total.gradedItems)}
                </span>
              </p>
            ) : (
              <p className="mt-1 text-slate-600">{t.dashboard.noReleasedGrades}</p>
            )}
          </div>
          <div>
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{t.dashboard.toDo}</p>
            {state.data.todo.length ? (
              <ul className="mt-1 space-y-1">
                {state.data.todo.slice(0, 5).map((item) => (
                  <li key={item.id}>
                    <Link href={`/courses/${course.id}/activities/${item.id}`} className="font-medium text-brand-700 hover:underline">
                      {item.title}
                    </Link>
                    <span className="text-xs text-slate-500">
                      {' '}
                      · {item.kind === 'assignment' && item.due ? t.dashboard.assignmentDue(formatDateTime(item.due, locale)) : t.dashboard.quizAvailable}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-slate-600">{t.dashboard.nothingToDo}</p>
            )}
          </div>
        </>
      )}
    </CardShell>
  );
}
