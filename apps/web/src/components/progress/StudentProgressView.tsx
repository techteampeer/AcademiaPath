'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ScrollRegion } from '@/components/ui/ScrollRegion';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingCards } from '@/components/ui/Skeleton';
import { tableClasses } from '@/components/ui/table';
import { isApiError } from '@/lib/api/client';
import { api, loadAll } from '@/lib/api/endpoints';
import type { Course, StudentProgressPage } from '@/lib/api/types';
import { ProgressBar } from './ProgressDisplay';

type Row = StudentProgressPage['items'][number];
type ViewState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'ready'; course: Course; totalCount: number; rows: Row[] };

/**
 * Read-only progress of a course's active students for instructors, non-editing instructors and
 * administrators. Every figure comes from the API; the page offers no way to change progress.
 */
export function StudentProgressView({ courseId }: { courseId: string }) {
  return <RequireAuth>{() => <StudentProgressContent courseId={courseId} />}</RequireAuth>;
}

function StudentProgressContent({ courseId }: { courseId: string }) {
  const { t, locale } = useLocale();
  const p = t.progress;
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<ViewState>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const course = await api.getCourse(courseId);
      let totalCount = 0;
      const rows = await loadAll(async (page) => {
        const result = await api.studentProgress(courseId, page);
        totalCount = result.totalCount;
        return result;
      }, 10);
      setState({ status: 'ready', course, totalCount, rows });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      else if (isApiError(error, 404) || isApiError(error, 400)) setState({ status: 'not-found' });
      else setState({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [courseId, handleUnauthorized, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const backLink = (
    <Link href={`/courses/${courseId}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
      {t.content.view.backToCourse}
    </Link>
  );

  if (state.status === 'loading') return <LoadingCards label={p.loadingStudents} count={2} />;
  if (state.status === 'not-found') {
    return <EmptyState titleAs="h1" title={t.courses.notAvailableTitle} description={t.courses.notAvailableDescription} action={backLink} />;
  }
  if (state.status === 'error') {
    return (
      <div className="space-y-4">
        <PageHeader title={p.studentProgress} />
        <Alert tone="error">{state.message}</Alert>
        {backLink}
      </div>
    );
  }

  const { course, totalCount, rows } = state;
  return (
    <div className="space-y-6">
      <PageHeader
        title={p.studentProgress}
        kicker={course.code}
        description={p.studentProgressIntro}
        breadcrumbLabel={t.common.breadcrumb}
        breadcrumbs={[{ label: t.nav.myCourses, href: '/courses' }, { label: course.title, href: `/courses/${course.id}` }, { label: p.studentProgress }]}
      />
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
        <p>{p.eligibleActivities(totalCount)}</p>
        <p className="text-xs text-slate-500">{p.readOnly}</p>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={p.noStudents} />
      ) : (
        <ScrollRegion label={p.studentProgress} className={tableClasses.wrapper}>
          <table className={tableClasses.table}>
            <caption className="sr-only">{p.studentProgress}</caption>
            <thead className={tableClasses.head}>
              <tr>
                <th scope="col" className={tableClasses.th}>
                  {p.student}
                </th>
                <th scope="col" className={tableClasses.th}>
                  {p.completedColumn}
                </th>
                <th scope="col" className={`${tableClasses.th} w-1/3 min-w-40`}>
                  {p.progressColumn}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.student.id} className={tableClasses.row}>
                  <td className={tableClasses.td}>
                    <p className="font-medium text-slate-900">
                      {row.student.givenName} {row.student.familyName}
                    </p>
                    <p className="text-xs break-all text-slate-500">{row.student.email}</p>
                  </td>
                  <td className={`${tableClasses.td} whitespace-nowrap`}>
                    {row.totalCount > 0 ? `${row.completedCount} / ${row.totalCount}` : '—'}
                  </td>
                  <td className={tableClasses.td}>
                    <ProgressBar figures={row} label={p.progressOf(`${row.student.givenName} ${row.student.familyName}`)} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      {backLink}
    </div>
  );
}
