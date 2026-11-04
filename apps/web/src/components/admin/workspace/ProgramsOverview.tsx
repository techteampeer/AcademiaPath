'use client';

import Link from 'next/link';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingCards } from '@/components/ui/Skeleton';
import { useAdminRecords } from './AdminOverview';

export function ProgramsOverview() {
  return <RequireAuth role="administrator">{() => <ProgramsContent />}</RequireAuth>;
}

/** Read-only overview of programs and their reusable subjects; editing happens in the academic structure. */
function ProgramsContent() {
  const { t } = useLocale();
  const { state, load } = useAdminRecords();
  const header = (
    <PageHeader
      breadcrumbs={[{ label: t.nav.adminOverview, href: '/admin' }, { label: t.admin.programsTitle }]}
      breadcrumbLabel={t.common.breadcrumb}
      title={t.admin.programsTitle}
      description={t.admin.programsIntro}
      actions={
        <Link href="/admin/academics" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
          {t.admin.editInStructure}
        </Link>
      }
    />
  );
  if (state.status === 'loading') return <div className="space-y-6">{header}<LoadingCards label={t.common.loading} /></div>;
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
  const { programs, subjects, courses } = state.data;
  return (
    <div className="space-y-6">
      {header}
      {programs.length === 0 ? (
        <EmptyState title={t.admin.noPrograms} description={t.admin.emptyDescription} />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {programs.map((program) => {
            const own = subjects.filter((subject) => subject.programId === program.id);
            return (
              <Card as="li" key={program.id} className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">{program.name}</h2>
                    <p className="text-xs text-slate-500">
                      {program.code} · {t.admin.subjectCount(own.length)} · {courses.filter((c) => c.programId === program.id).length} {t.admin.courses.toLowerCase()}
                    </p>
                  </div>
                  <Badge tone={program.isActive ? 'success' : 'warning'}>{program.isActive ? t.status.active : t.status.inactive}</Badge>
                </div>
                {program.description ? <p className="text-sm text-slate-600">{program.description}</p> : null}
                {own.length ? (
                  <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                    {own.map((subject) => (
                      <li key={subject.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                        <span className="font-medium text-slate-800">{subject.title}</span>
                        <span className="text-xs text-slate-500">
                          {subject.code} · {t.admin.version(subject.latestVersion?.version ?? 0)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-500">{t.admin.noSubjects}</p>
                )}
              </Card>
            );
          })}
        </ul>
      )}
    </div>
  );
}
