'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { HeritageBanner } from '@/components/layout/Heritage';
import { LoadingCards } from '@/components/ui/Skeleton';
import { StatCard } from '@/components/ui/StatCard';
import { isApiError } from '@/lib/api/client';
import { api, loadAll } from '@/lib/api/endpoints';
import type { Course, CourseTemplate, Program, Term } from '@/lib/api/types';
import { formatDate } from '@/lib/i18n/messages';

type Records = { programs: Program[]; terms: Term[]; subjects: CourseTemplate[]; courses: Course[] };

export function AdminOverview() {
  return <RequireAuth role="administrator">{() => <OverviewContent />}</RequireAuth>;
}

/** Real counts only: every figure is derived from the administrator list endpoints. */
export function useAdminRecords() {
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error' } | { status: 'ready'; data: Records }>({ status: 'loading' });
  const load = useCallback(async () => {
    try {
      const [programs, terms, subjects, courses] = await Promise.all([
        loadAll((page) => api.listPrograms(page)),
        loadAll((page) => api.listTerms(page)),
        loadAll((page) => api.listCourseTemplates(page)),
        loadAll((page) => api.listCourses(page)),
      ]);
      setState({ status: 'ready', data: { programs, terms, subjects, courses } });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error' });
    }
  }, [handleUnauthorized]);
  useEffect(() => {
    void load();
  }, [load]);
  return { state, load };
}

const today = () => new Date().toISOString().slice(0, 10);

function OverviewContent() {
  const { t, locale } = useLocale();
  const { state, load } = useAdminRecords();

  const header = (
    <HeritageBanner compact>
      <div className="max-w-xl">
        <p className="text-xs font-semibold tracking-[0.14em] text-gold-200 uppercase">{t.roles.administrator}</p>
        <h1 className="mt-2 text-[1.9rem] leading-tight font-semibold text-ivory sm:text-[2.4rem]">{t.admin.title}</h1>
        <div aria-hidden="true" className="heritage-rule mt-3 w-28" />
        <p className="mt-3 text-ivory/90">{t.admin.intro}</p>
      </div>
    </HeritageBanner>
  );
  if (state.status === 'loading') {
    return (
      <div className="space-y-6">
        {header}
        <LoadingCards label={t.common.loading} count={4} />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="space-y-6">
        {header}
        <Alert tone="error">
          {t.common.loadError}{' '}
          <button type="button" className="font-medium underline" onClick={() => void load()}>
            {t.common.retry}
          </button>
        </Alert>
      </div>
    );
  }

  const { programs, terms, subjects, courses } = state.data;
  const years = [...new Set(terms.map((term) => term.academicYear))].sort((a, b) => b - a);
  const byStatus = (status: Course['status']) => courses.filter((course) => course.status === status).length;
  const now = today();
  const current = terms.find((term) => term.startsOn <= now && now <= term.endsOn) ?? null;
  const coursesInTerm = (termId: string) => courses.filter((course) => course.termId === termId).length;
  const sortedTerms = [...terms].sort((a, b) => b.startsOn.localeCompare(a.startsOn)).slice(0, 6);
  const empty = programs.length === 0 && terms.length === 0;

  return (
    <div className="space-y-8">
      {header}
      {empty ? (
        <EmptyState
          title={t.admin.emptyTitle}
          description={t.admin.emptyDescription}
          action={
            <Link href="/admin/academics" className={buttonClasses()}>
              {t.admin.manageStructure}
            </Link>
          }
        />
      ) : null}

      <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t.admin.programs} value={programs.length} hint={t.admin.activePrograms(programs.filter((p) => p.isActive).length)} />
        <StatCard label={t.admin.subjects} value={subjects.length} />
        <StatCard label={t.admin.academicYears} value={years.length} hint={`${t.admin.termCount(terms.length)}${years.length ? ` · ${years.join(', ')}` : ''}`} />
        <StatCard
          label={t.admin.courses}
          value={courses.length}
          hint={`${byStatus('published')} ${t.status.published.toLowerCase()} · ${byStatus('draft')} ${t.status.draft.toLowerCase()} · ${byStatus('archived')} ${t.status.archived.toLowerCase()}`}
        />
      </dl>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <Card as="section" aria-labelledby="terms-heading" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="terms-heading" className="text-lg font-semibold text-brand-600">
              {t.admin.upcomingTerms}
            </h2>
            {current ? (
              <Badge tone="success">
                {t.admin.currentTerm}: {current.code}
              </Badge>
            ) : (
              <span className="text-xs text-slate-500">{t.admin.noCurrentTerm}</span>
            )}
          </div>
          {sortedTerms.length ? (
            <ul className="divide-y divide-slate-100">
              {sortedTerms.map((term) => (
                <li key={term.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <Link href={`/admin/academics?year=${term.academicYear}&term=${term.id}`} className="font-medium text-brand-700 hover:underline">
                      {term.code}
                    </Link>
                    <span className="ml-2 text-sm text-slate-600">{term.name}</span>
                  </div>
                  <span className="text-xs text-slate-500">
                    {formatDate(term.startsOn, locale)} – {formatDate(term.endsOn, locale)} · {coursesInTerm(term.id)} {t.admin.courses.toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-600">{t.academics.noTerms}</p>
          )}
        </Card>

        <div className="space-y-6">
          <Card as="section" aria-labelledby="actions-heading" className="space-y-3">
            <h2 id="actions-heading" className="text-lg font-semibold text-brand-600">
              {t.admin.quickActions}
            </h2>
            <div className="flex flex-col gap-2">
              <Link href="/admin/academics" className={buttonClasses({ className: 'justify-start' })}>
                {t.admin.manageStructure}
              </Link>
              <Link href="/admin/users" className={buttonClasses({ variant: 'secondary', className: 'justify-start' })}>
                {t.admin.manageUsers}
              </Link>
              <Link href="/admin/courses" className={buttonClasses({ variant: 'secondary', className: 'justify-start' })}>
                {t.admin.manageCourses}
              </Link>
              <Link href="/admin/setup" className={buttonClasses({ variant: 'secondary', className: 'justify-start' })}>
                {t.admin.setup}
              </Link>
            </div>
          </Card>
          <Card as="section" aria-labelledby="unavailable-heading" className="space-y-2">
            <h2 id="unavailable-heading" className="text-base font-semibold text-brand-600">
              {t.admin.notAvailableTitle}
            </h2>
            <p className="text-sm text-slate-600">{t.admin.notAvailableIntro}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
              {t.admin.notAvailable.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
