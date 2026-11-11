'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatGrade20, GradeStatusBadge, ReleasedGradeView } from '@/components/assignments/assignmentDisplay';
import { contentAbilities } from '@/components/content/contentDisplay';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Breadcrumbs } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Course, CurrentUser, Gradebook, StudentGrades } from '@/lib/api/types';
import { CategoryList, CourseGradeValue, ExportCsvButton, ReleaseSelection } from './gradebookDisplay';
import { ReleaseGradesButton } from './ReleaseGradesButton';

type Load<T> = { status: 'loading' } | { status: 'not-found' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

export function GradesView({ courseId }: { courseId: string }) {
  return <RequireAuth>{(user) => <GradesContent courseId={courseId} user={user} />}</RequireAuth>;
}

function GradesContent({ courseId, user }: { courseId: string; user: CurrentUser }) {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const b = t.assignments.book;
  const [course, setCourse] = useState<Load<Course>>({ status: 'loading' });

  useEffect(() => {
    api
      .getCourse(courseId)
      .then((data) => setCourse({ status: 'ready', data }))
      .catch((error: unknown) => {
        if (isApiError(error, 401)) handleUnauthorized();
        else if (isApiError(error, 404) || isApiError(error, 400)) setCourse({ status: 'not-found' });
        else setCourse({ status: 'error', message: describeApiError(error, locale) });
      });
  }, [courseId, handleUnauthorized, locale]);

  const backLink = (
    <Link href={`/courses/${courseId}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
      {t.content.view.backToCourse}
    </Link>
  );
  if (course.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {b.loadingCourse}
      </p>
    );
  }
  if (course.status === 'not-found') {
    return <EmptyState titleAs="h1" title={b.notAvailableTitle} description={b.notAvailableDescription} action={backLink} />;
  }
  if (course.status === 'error') return <Alert tone="error">{course.message}</Alert>;

  const abilities = contentAbilities(user, course.data.viewerRole);
  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs
          label={t.common.breadcrumb}
          items={[
            { label: t.nav.myCourses, href: '/courses' },
            { label: course.data.title, href: `/courses/${course.data.id}` },
            { label: abilities.viewGrades ? b.gradebook : b.myGrades },
          ]}
        />
        <p className="mt-4 text-sm text-slate-500">{course.data.code}</p>
        <h1 className="mt-1 text-[1.75rem] leading-tight font-semibold text-brand-600 sm:text-[2.1rem]">
          {abilities.viewGrades ? b.gradebook : b.myGrades}
        </h1>
        <p className="mt-1 text-sm text-slate-600">{b.scale}</p>
      </div>
      {abilities.viewGrades ? (
        <StaffGradebook courseId={courseId} canRelease={abilities.release} />
      ) : abilities.attempt ? (
        <StudentGradesList courseId={courseId} />
      ) : (
        <Alert tone="info">{b.notForRole}</Alert>
      )}
    </div>
  );
}

function useLoad<T>(fetcher: () => Promise<T>) {
  const { handleUnauthorized } = useSession();
  const { locale } = useLocale();
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', data: await fetcher() });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [fetcher, handleUnauthorized, locale]);
  useEffect(() => {
    void load();
  }, [load]);
  return { state, load };
}

/** Instructor view: one row per student, one column per approved quiz or assignment, and the policy's course grade. */
function StaffGradebook({ courseId, canRelease }: { courseId: string; canRelease: boolean }) {
  const { t } = useLocale();
  const b = t.assignments.book;
  const g = t.gradebook;
  const fetcher = useCallback(() => api.getGradebook(courseId, { limit: 100 }), [courseId]);
  const { state, load } = useLoad<Gradebook>(fetcher);
  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {b.loading}
      </p>
    );
  }
  if (state.status !== 'ready') return <Alert tone="error">{state.status === 'error' ? state.message : b.notAvailable}</Alert>;
  const book = state.data;
  const categoryName = new Map(book.policy.categories.map((category) => [category.id, category]));
  // Everything graded but not (or no longer) released, each with the revision shown here.
  const releasable = book.items.flatMap((row) =>
    row.cells
      .filter((cell) => (cell.status === 'unreleased' || cell.status === 'changed_since_release') && cell.revision !== null)
      .map((cell) => ({ activityId: cell.activityId, userId: row.student.id, revision: cell.revision! })),
  );
  const toolbar = (
    <div className="flex flex-wrap items-start gap-2">
      <Button variant="secondary" size="sm" onClick={() => void load()}>
        {b.refresh}
      </Button>
      <ExportCsvButton courseId={courseId} />
      <Link href={`/courses/${courseId}/grades/categories`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
        {g.toolbar.categories}
      </Link>
    </div>
  );
  if (!book.columns.length) {
    return (
      <div className="space-y-4">
        {toolbar}
        <EmptyState title={b.nothingTitle} description={b.nothingDescription} />
      </div>
    );
  }
  return (
    <Card as="section" aria-label={b.gradebookLabel} className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1 text-sm text-slate-600">
          <p data-policy-status={book.policy.status}>
            <span className="font-medium text-slate-900">{g.policyStatus[book.policy.status]}</span>
            {book.policy.method === 'weighted' ? `: ${book.policy.categories.map((category) => g.categoryWeight(category.name, category.weightPercent)).join(', ')}` : null}
          </p>
          <p>{b.note}</p>
          <p>{g.pendingWorkNote}</p>
        </div>
        {toolbar}
      </div>
      {canRelease ? (
        // Always mounted, so the result of a release (and any skipped items) stays visible after the reload.
        <ReleaseSelection
          courseId={courseId}
          items={releasable}
          label={`${g.toolbar.releaseAll} (${releasable.length})`}
          emptyLabel={g.toolbar.nothingToRelease}
          onReleased={() => void load()}
        />
      ) : null}
      <div className="relative overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 align-bottom text-slate-500">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">
                {b.student}
              </th>
              {book.columns.map((column) => (
                <th key={column.activityId} scope="col" className="min-w-40 py-2 pr-4 font-medium">
                  <Link href={`/courses/${courseId}/activities/${column.activityId}`} className="text-brand-700 hover:underline">
                    {column.title}
                  </Link>
                  <span className="block text-xs font-normal">
                    {column.type === 'quiz' ? b.quiz : b.assignment} · {b.pts(column.maxPoints)}
                  </span>
                  {book.policy.method === 'weighted' ? (
                    <span className="block text-xs font-normal text-slate-500">
                      {column.categoryId ? categoryName.get(column.categoryId)?.name : g.notCounted}
                    </span>
                  ) : null}
                  {!column.visible ? <span className="block text-xs font-normal text-amber-700">{g.hidden}</span> : null}
                  {canRelease ? (
                    <div className="mt-2 font-normal">
                      <ReleaseGradesButton courseId={courseId} activityId={column.activityId} label={b.release} onReleased={() => void load()} />
                    </div>
                  ) : null}
                </th>
              ))}
              <th scope="col" className="min-w-44 py-2 pr-4 font-medium">
                {g.courseGrade}
              </th>
              <th scope="col" className="min-w-32 py-2 font-medium">
                {g.unweightedTotal}
              </th>
            </tr>
          </thead>
          <tbody>
            {book.items.map((row) => (
              <tr key={row.student.id} className="border-b border-slate-100 align-top" data-student={row.student.email}>
                <th scope="row" className="py-2 pr-4 font-normal">
                  <Link href={`/courses/${courseId}/grades/students/${row.student.id}`} className="block text-brand-700 hover:underline">
                    {row.student.givenName} {row.student.familyName}
                  </Link>
                  <span className="block text-xs break-all text-slate-500">{row.student.email}</span>
                  <span className="block text-xs text-slate-500">{g.counts(row.counts.needsGrading, row.counts.unreleased)}</span>
                </th>
                {row.cells.map((cell) => (
                  <td key={cell.activityId} className="py-2 pr-4">
                    {cell.points !== null ? (
                      <span className="block font-medium text-slate-900">
                        {formatGrade20(cell.grade20)}
                        <span className="block text-xs font-normal text-slate-500">
                          {b.cellPoints(cell.points, cell.maxPoints)}
                        </span>
                      </span>
                    ) : null}
                    <GradeStatusBadge status={cell.status} />
                  </td>
                ))}
                <td className="py-2 pr-4">
                  <CourseGradeValue grade={row.courseGrade} compact />
                </td>
                <td className="py-2 text-slate-900">
                  {formatGrade20(row.total.grade20)}
                  <span className="block text-xs font-normal text-slate-500">
                    {b.totalDetail(row.total.points, row.total.maxPoints, row.total.gradedItems)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {book.items.length === 0 ? <p className="text-sm text-slate-600">{b.noStudents}</p> : null}
    </Card>
  );
}

/** Student view: only released grades; everything else is pending, without numbers. */
function StudentGradesList({ courseId }: { courseId: string }) {
  const { t } = useLocale();
  const b = t.assignments.book;
  const g = t.gradebook;
  const fetcher = useCallback(() => api.myGrades(courseId), [courseId]);
  const { state } = useLoad<StudentGrades>(fetcher);
  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {b.loadingMine}
      </p>
    );
  }
  if (state.status !== 'ready') return <Alert tone="error">{state.status === 'error' ? state.message : b.notAvailable}</Alert>;
  const grades = state.data;
  const categoryName = new Map(grades.policy.categories.map((category) => [category.id, category]));
  const workTone = { not_submitted: 'neutral', in_progress: 'brand', submitted: 'warning', released: 'success' } as const;
  return (
    <div className="space-y-4">
      <Card as="section" aria-labelledby="total-heading">
        <h2 id="total-heading" className="text-sm font-medium text-slate-500">
          {g.student.heading}
        </h2>
        <div className="mt-1">
          <CourseGradeValue grade={grades.courseGrade} />
        </div>
        <p className="mt-1 text-xs text-slate-500">{g.method[grades.courseGrade.method]}</p>
        {grades.courseGrade.method === 'weighted' ? (
          <>
            <h3 className="mt-3 text-sm font-medium text-slate-700">{g.student.weighting}</h3>
            <CategoryList grade={grades.courseGrade} />
          </>
        ) : null}
        <p className="mt-3 text-xs text-slate-500">{g.pendingWorkNote}</p>
        <p className="text-xs text-slate-500">{g.student.progressNote}</p>
      </Card>
      {grades.items.length === 0 ? (
        <p className="text-sm text-slate-600">{b.noItems}</p>
      ) : (
        <ul className="space-y-3">
          {grades.items.map((item) => (
            <li key={item.activityId} data-activity={item.title} data-work-status={item.workStatus}>
              <Card as="article" aria-labelledby={`grade-${item.activityId}`} className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id={`grade-${item.activityId}`} className="font-semibold text-brand-600">
                    <Link href={`/courses/${courseId}/activities/${item.activityId}`} className="text-brand-700 hover:underline">
                      {item.title}
                    </Link>
                    <span className="ml-2 text-xs font-normal text-slate-500">{item.type === 'quiz' ? b.quiz : b.assignment}</span>
                    {item.categoryId && categoryName.get(item.categoryId) ? (
                      <span className="ml-2 text-xs font-normal text-slate-500">· {categoryName.get(item.categoryId)!.name}</span>
                    ) : null}
                  </h2>
                  <span className="flex flex-wrap gap-2">
                    {item.passed !== null ? <Badge tone={item.passed ? 'success' : 'warning'}>{item.passed ? g.student.passed : g.student.notPassed}</Badge> : null}
                    <Badge tone={workTone[item.workStatus]}>{g.student.workStatus[item.workStatus]}</Badge>
                  </span>
                </div>
                {item.grade ? <ReleasedGradeView grade={item.grade} /> : <p className="text-sm text-slate-600">{b.notReleased}</p>}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
