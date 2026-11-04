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
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingCards, Skeleton } from '@/components/ui/Skeleton';
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

function DashboardContent({ user }: { user: CurrentUser }) {
  const { t } = useLocale();
  const workspace = useWorkspace();
  const header = <PageHeader title={t.dashboard.title} description={`${t.dashboard.welcome(user.givenName)} ${t.dashboard.rolesIntro}`} />;

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
  const roles = ROLE_ORDER.filter((role) => byRole(role).length > 0);
  return (
    <div className="space-y-10">
      {header}
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
    </div>
  );
}

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
          <h2 id={headingId} className="text-xl font-semibold tracking-tight text-slate-900">
            {text.title} <Badge tone="brand" className="ml-1 align-middle">{t.roles[role]}</Badge>
          </h2>
          <p className="mt-1 text-sm text-slate-600">{text.intro}</p>
        </div>
        {role === 'student' ? <p className="text-xs text-slate-500">{t.dashboard.progressNotTracked}</p> : null}
      </div>
      {courses.length > DETAIL_LIMIT ? <p className="text-xs text-slate-500">{t.dashboard.partial(DETAIL_LIMIT, courses.length)}</p> : null}
      <ul className="grid gap-4 lg:grid-cols-2">
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

/** Sections and activities the caller may see (students: approved, visible only — enforced by the API). */
async function loadActivities(courseId: string): Promise<Activity[]> {
  const sections = (await loadAll((page) => api.listSections(courseId, page), 2)).slice(0, SECTION_LIMIT);
  const lists = await Promise.all(sections.map((section) => loadAll((page) => api.listActivities(courseId, section.id, page), 2)));
  return lists.flat();
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

/** Student to-do items: open assignments not yet submitted and quizzes not yet attempted. */
async function loadStudentData(courseId: string) {
  const activities = await loadActivities(courseId);
  const assignments = activities.filter((a) => a.type === 'assignment').slice(0, 10);
  const quizzes = activities.filter((a) => a.type === 'quiz').slice(0, 10);
  const [grades, assignmentStates, quizStates] = await Promise.all([
    api.myGrades(courseId),
    Promise.all(assignments.map((a) => api.myAssignmentStatus(courseId, a.id).then((status) => ({ activity: a, status })))),
    Promise.all(quizzes.map((q) => api.myQuizAttempts(courseId, q.id).then((summary) => ({ activity: q, summary })))),
  ]);
  const todo = [
    ...assignmentStates
      .filter(({ status }) => status.acceptingSubmissions && !status.submission)
      .map(({ activity, status }) => ({ id: activity.id, title: activity.title, kind: 'assignment' as const, due: status.dueAt })),
    ...quizStates
      .filter(({ summary }) => summary.attemptsUsed === 0)
      .map(({ activity }) => ({ id: activity.id, title: activity.title, kind: 'quiz' as const, due: null as string | null })),
  ].sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  return { grades, todo };
}

// ---------------------------------------------------------------- cards

function CardShell({ course, role, children, actions }: { course: Course; role: CourseRole; children: ReactNode; actions: ReactNode }) {
  const { t } = useLocale();
  return (
    <Card as="article" className="flex h-full flex-col gap-4" aria-labelledby={`card-${role}-${course.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`card-${role}-${course.id}`} className="text-base font-semibold break-words text-slate-900">
            <Link href={`/courses/${course.id}`} className="hover:text-brand-700 hover:underline">
              {course.title}
            </Link>
          </h3>
          <p className="text-xs text-slate-500">
            {course.code} · {t.roles[role]}
          </p>
        </div>
        <CourseStatusBadge status={course.status} />
      </div>
      <div className="flex-1 space-y-3 text-sm">{children}</div>
      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">{actions}</div>
    </Card>
  );
}

function Figures({ items }: { items: Array<{ label: string; value: number; tone?: 'warn' }> }) {
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className={`rounded-lg px-3 py-2 ${item.tone === 'warn' && item.value > 0 ? 'bg-amber-50' : 'bg-slate-50'}`}>
          <dt className="text-xs text-slate-500">{item.label}</dt>
          <dd className="text-lg font-semibold text-slate-900">{item.value}</dd>
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
          <Link href={`/courses/${course.id}/tutor`} className={linkClass}>
            {t.nav.tutor}
          </Link>
        </>
      }
    >
      {content.status !== 'ready' ? (
        <DetailState state={content} />
      ) : (
        <Figures
          items={[
            { label: t.dashboard.lessons, value: byType('page') },
            { label: t.dashboard.resources, value: byType('link') },
            { label: t.dashboard.quizzes, value: byType('quiz') },
            { label: t.dashboard.assignments, value: byType('assignment') },
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
        </>
      }
    >
      {state.status !== 'ready' ? (
        <DetailState state={state} />
      ) : (
        <>
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
