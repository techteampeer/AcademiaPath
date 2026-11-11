'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatGrade20, GradeStatusBadge } from '@/components/assignments/assignmentDisplay';
import { contentAbilities } from '@/components/content/contentDisplay';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Breadcrumbs } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import { formatDateTimeOrDash } from '@/lib/i18n/messages';
import type { Course, CurrentUser, StudentGradebook } from '@/lib/api/types';
import { CategoryList, CourseGradeValue, ReleaseSelection } from './gradebookDisplay';

type Load<T> = { status: 'loading' } | { status: 'not-found' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

export function StudentGradebookView({ courseId, userId }: { courseId: string; userId: string }) {
  return <RequireAuth>{(user) => <Content courseId={courseId} userId={userId} user={user} />}</RequireAuth>;
}

/** Staff drilldown: one student's activities, current and released grades, and the course grade both ways. */
function Content({ courseId, userId, user }: { courseId: string; userId: string; user: CurrentUser }) {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const b = t.assignments.book;
  const d = t.gradebook.drilldown;
  const [course, setCourse] = useState<Load<Course>>({ status: 'loading' });
  const [data, setData] = useState<Load<StudentGradebook>>({ status: 'loading' });

  const fail = useCallback(
    (error: unknown, set: (value: Load<never>) => void) => {
      if (isApiError(error, 401)) handleUnauthorized();
      else if (isApiError(error, 404) || isApiError(error, 400)) set({ status: 'not-found' });
      else set({ status: 'error', message: describeApiError(error, locale) });
    },
    [handleUnauthorized, locale],
  );
  const load = useCallback(() => {
    api
      .getStudentGradebook(courseId, userId)
      .then((value) => setData({ status: 'ready', data: value }))
      .catch((error: unknown) => fail(error, setData));
  }, [courseId, userId, fail]);
  useEffect(() => {
    api
      .getCourse(courseId)
      .then((value) => setCourse({ status: 'ready', data: value }))
      .catch((error: unknown) => fail(error, setCourse));
    load();
  }, [courseId, load, fail]);

  const back = (
    <Link href={`/courses/${courseId}/grades`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
      {d.back}
    </Link>
  );
  if (course.status === 'loading' || data.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {b.loading}
      </p>
    );
  }
  if (course.status === 'not-found') return <EmptyState titleAs="h1" title={b.notAvailableTitle} description={b.notAvailableDescription} />;
  if (course.status === 'error') return <Alert tone="error">{course.message}</Alert>;
  if (data.status === 'not-found') return <EmptyState titleAs="h1" title={b.notAvailableTitle} description={d.notFound} action={back} />;
  if (data.status === 'error') return <Alert tone="error">{data.message}</Alert>;

  const canRelease = contentAbilities(user, course.data.viewerRole).release;
  const book = data.data;
  const name = `${book.student.givenName} ${book.student.familyName}`;
  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs
          label={t.common.breadcrumb}
          items={[
            { label: t.nav.myCourses, href: '/courses' },
            { label: course.data.title, href: `/courses/${courseId}` },
            { label: b.gradebook, href: `/courses/${courseId}/grades` },
            { label: name },
          ]}
        />
        <h1 className="mt-4 text-[1.75rem] leading-tight font-semibold text-brand-600 sm:text-[2.1rem]">{d.title(name)}</h1>
        <p className="mt-1 text-sm break-all text-slate-600">{book.student.email}</p>
        <p className="mt-1 text-sm text-slate-600">{t.gradebook.policyStatus[book.policy.status]}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card as="section" aria-labelledby="staff-grade">
          <h2 id="staff-grade" className="text-sm font-medium text-slate-500">
            {d.staffGrade}
          </h2>
          <div className="mt-1" data-testid="staff-course-grade">
            <CourseGradeValue grade={book.courseGrade} />
          </div>
          <CategoryList grade={book.courseGrade} />
        </Card>
        <Card as="section" aria-labelledby="student-grade">
          <h2 id="student-grade" className="text-sm font-medium text-slate-500">
            {d.studentSees}
          </h2>
          <div className="mt-1" data-testid="released-course-grade">
            <CourseGradeValue grade={book.releasedCourseGrade} />
          </div>
          <CategoryList grade={book.releasedCourseGrade} />
        </Card>
      </div>
      <Card as="section" aria-label={b.gradebookLabel}>
        {book.activities.length === 0 ? (
          <p className="text-sm text-slate-600">{d.noActivities}</p>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {d.activity}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {d.status}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {d.current}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {d.released}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    {d.submitted}
                  </th>
                </tr>
              </thead>
              <tbody>
                {book.activities.map((row) => {
                  const releasable = canRelease && row.grade && (row.status === 'unreleased' || row.status === 'changed_since_release');
                  return (
                    <tr key={row.activity.activityId} className="border-b border-slate-100 align-top" data-activity={row.activity.title}>
                      <th scope="row" className="py-2 pr-4 font-normal">
                        <span className="block font-medium text-slate-900">{row.activity.title}</span>
                        <span className="block text-xs text-slate-500">
                          {row.activity.type === 'quiz' ? b.quiz : b.assignment} · {b.pts(row.activity.maxPoints)}
                          {row.attemptsUsed !== null ? ` · ${d.attempts(row.attemptsUsed)}` : ''}
                        </span>
                        {row.passed !== null && row.passingScorePercent !== null ? (
                          <span className="mt-1 block">
                            <Badge tone={row.passed ? 'success' : 'warning'}>{row.passed ? d.passed(row.passingScorePercent) : d.notPassed(row.passingScorePercent)}</Badge>
                          </span>
                        ) : null}
                      </th>
                      <td className="py-2 pr-4">
                        <GradeStatusBadge status={row.status} />
                        {row.inProgress ? <span className="mt-1 block text-xs text-slate-500">{d.inProgress}</span> : null}
                      </td>
                      <td className="py-2 pr-4">
                        {row.grade ? (
                          <>
                            <span className="block font-medium text-slate-900">{formatGrade20(row.grade.grade20)}</span>
                            <span className="block text-xs text-slate-500">
                              {b.cellPoints(row.grade.points, row.grade.maxPoints)} · {d.revision(row.grade.revision)}
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                        {releasable ? (
                          <div className="mt-2">
                            <ReleaseSelection
                              courseId={courseId}
                              items={[{ activityId: row.activity.activityId, userId: book.student.id, revision: row.grade!.revision }]}
                              label={t.gradebook.release.releaseOne}
                              onReleased={load}
                            />
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4">
                        {row.released ? (
                          <>
                            <span className="block text-slate-900">{formatGrade20(row.released.grade20)}</span>
                            <span className="block text-xs text-slate-500">
                              {b.cellPoints(row.released.points, row.released.maxPoints)} · {formatDateTimeOrDash(row.released.releasedAt, locale)}
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2">
                        {formatDateTimeOrDash(row.submittedAt, locale)}
                        {row.isLate ? (
                          <span className="ml-1">
                            <Badge tone="warning">{d.late}</Badge>
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {back}
    </div>
  );
}
