'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { isApiError } from '@/lib/api/client';
import { api, loadAll } from '@/lib/api/endpoints';
import type { Course, CourseTemplate, Program, Term } from '@/lib/api/types';
import { ProgramPanel, SubjectPanel, TermPanel, YearPanel } from './AcademicPanels';

type Data = { terms: Term[]; programs: Program[]; subjects: CourseTemplate[] };
type Selection = { year?: string; term?: string; program?: string; subject?: string };
const LEVELS: Array<keyof Selection> = ['year', 'term', 'program', 'subject'];

export function AcademicHierarchy() {
  return <RequireAuth role="administrator">{() => <HierarchyContent />}</RequireAuth>;
}

/** Counts offerings (courses) of the selected term per program and per subject. */
function countBy(offerings: Course[] | null, key: 'programId' | 'templateId') {
  const counts = new Map<string, number>();
  for (const course of offerings ?? []) {
    const id = course[key];
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function HierarchyContent() {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [data, setData] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: Data }>({ status: 'loading' });
  const [offerings, setOfferings] = useState<Course[] | null>(null);
  const [newYear, setNewYear] = useState('');

  const selection: Selection = Object.fromEntries(LEVELS.flatMap((level) => (params.get(level) ? [[level, params.get(level)!]] : [])));
  const navigate = useCallback(
    (next: Selection) => {
      const query = new URLSearchParams();
      for (const level of LEVELS) if (next[level]) query.set(level, next[level]!);
      const search = query.toString();
      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const reload = useCallback(async () => {
    try {
      const [terms, programs, subjects] = await Promise.all([
        loadAll((page) => api.listTerms(page)),
        loadAll((page) => api.listPrograms(page)),
        loadAll((page) => api.listCourseTemplates(page)),
      ]);
      setData({ status: 'ready', value: { terms, programs, subjects } });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setData({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [handleUnauthorized, locale]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Resolve the selection against real data; anything that does not exist is ignored.
  const value = data.status === 'ready' ? data.value : null;
  const years = useMemo(() => [...new Set((value?.terms ?? []).map((term) => term.academicYear))].sort((a, b) => b - a), [value]);
  const term = value?.terms.find((t) => t.id === selection.term) ?? null;
  const requestedYear = Number(selection.year);
  const activeYear = term?.academicYear ?? (Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100 ? requestedYear : (years[0] ?? null));
  const program = term ? (value?.programs.find((p) => p.id === selection.program) ?? null) : null;
  const subject = program ? (value?.subjects.find((s) => s.id === selection.subject && s.programId === program.id) ?? null) : null;
  const termsOfYear = (value?.terms ?? []).filter((t) => t.academicYear === activeYear).sort((a, b) => a.code.localeCompare(b.code));
  const subjectsOf = (programId: string) => (value?.subjects ?? []).filter((s) => s.programId === programId).sort((a, b) => a.code.localeCompare(b.code));

  const loadOfferings = useCallback(async () => {
    if (!term) return setOfferings(null);
    try {
      setOfferings(await loadAll((page) => api.listCourses(page, { termId: term.id })));
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setOfferings([]);
    }
  }, [term, handleUnauthorized]);

  useEffect(() => {
    void loadOfferings();
  }, [loadOfferings]);

  const refreshAll = useCallback(async () => {
    await reload();
    await loadOfferings();
  }, [reload, loadOfferings]);

  if (data.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {t.common.loading}
      </p>
    );
  }
  if (data.status === 'error') {
    return (
      <Alert tone="error">
        {data.message}{' '}
        <button type="button" className="font-medium underline" onClick={() => void reload()}>
          {t.common.retry}
        </button>
      </Alert>
    );
  }

  const programCounts = countBy(offerings, 'programId');
  const subjectCounts = countBy(offerings, 'templateId');
  const crumbs: Array<{ label: string; target: Selection }> = [{ label: t.academics.title, target: {} }];
  if (activeYear) crumbs.push({ label: String(activeYear), target: { year: String(activeYear) } });
  if (term) crumbs.push({ label: term.code, target: { year: String(term.academicYear), term: term.id } });
  if (term && program) crumbs.push({ label: program.name, target: { year: String(term.academicYear), term: term.id, program: program.id } });
  if (term && program && subject) crumbs.push({ label: subject.title, target: { year: String(term.academicYear), term: term.id, program: program.id, subject: subject.id } });

  const yearOptions = activeYear && !years.includes(activeYear) ? [activeYear, ...years] : years;
  const startYear = () => {
    const year = Number(newYear);
    if (Number.isInteger(year) && year >= 2000 && year <= 2100) {
      setNewYear('');
      navigate({ year: String(year) });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <nav aria-label={t.common.breadcrumb}>
          <ol className="flex flex-wrap items-center gap-1 text-sm text-slate-500">
            {crumbs.map((crumb, index) => (
              <li key={crumb.label + index} className="flex items-center gap-1">
                {index > 0 ? <span aria-hidden="true">/</span> : null}
                {index === crumbs.length - 1 ? (
                  <span aria-current="page" className="font-medium text-slate-900">
                    {crumb.label}
                  </span>
                ) : (
                  <button type="button" className="text-brand-700 hover:underline" onClick={() => navigate(crumb.target)}>
                    {crumb.label}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{t.academics.title}</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">{t.academics.intro}</p>
          </div>
          <Link href="/admin/setup" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
            {t.academics.courseSetup}
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <Card as="section" aria-labelledby="hierarchy-heading" className="space-y-4 lg:self-start">
          <h2 id="hierarchy-heading" className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
            {t.academics.hierarchy}
          </h2>
          {yearOptions.length ? (
            <div>
              <label htmlFor="academic-year" className="block text-sm font-medium text-slate-800">
                {t.academics.academicYear}
              </label>
              <select
                id="academic-year"
                value={activeYear ?? ''}
                onChange={(event) => navigate({ year: event.target.value })}
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
              >
                {yearOptions.map((year) => (
                  <option key={year} value={year}>
                    {year}
                    {years.includes(year) ? '' : ` ${t.academics.noTermsLabel}`}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="new-year" className="block text-sm font-medium text-slate-800">
                {t.academics.newAcademicYear}
              </label>
              <input
                id="new-year"
                inputMode="numeric"
                placeholder="2027"
                value={newYear}
                onChange={(event) => setNewYear(event.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
              />
            </div>
            <Button variant="secondary" size="sm" onClick={startYear}>
              {t.common.open}
            </Button>
          </div>
          <div className="max-h-[28rem] overflow-y-auto lg:max-h-none">
            {activeYear ? (
              <nav aria-label={t.academics.treeLabel}>
                <ul className="space-y-1 text-sm">
                  <li>
                    <TreeItem depth={0} label={String(activeYear)} meta={t.academics.academicYear} selected={!term} expanded onSelect={() => navigate({ year: String(activeYear) })} />
                    <ul className="space-y-1">
                      {termsOfYear.length === 0 ? <li className="py-1 pl-6 text-xs text-slate-500">{t.academics.noTerms}</li> : null}
                      {termsOfYear.map((tm) => (
                        <li key={tm.id}>
                          <TreeItem
                            depth={1}
                            label={tm.code}
                            meta={tm.name}
                            selected={tm.id === term?.id && !program}
                            expanded={tm.id === term?.id}
                            onSelect={() => navigate({ year: String(tm.academicYear), term: tm.id })}
                          />
                          {tm.id === term?.id ? (
                            <ul className="space-y-1">
                              {(value?.programs ?? []).length === 0 ? <li className="py-1 pl-10 text-xs text-slate-500">{t.academics.noPrograms}</li> : null}
                              {(value?.programs ?? []).map((p) => (
                                <li key={p.id}>
                                  <TreeItem
                                    depth={2}
                                    label={p.name}
                                    meta={p.code}
                                    badge={p.isActive ? `${programCounts.get(p.id) ?? 0}` : t.status.inactive}
                                    badgeLabel={p.isActive ? t.academics.offeringsInTerm : undefined}
                                    selected={p.id === program?.id && !subject}
                                    expanded={p.id === program?.id}
                                    onSelect={() => navigate({ year: String(tm.academicYear), term: tm.id, program: p.id })}
                                  />
                                  {p.id === program?.id ? (
                                    <ul className="space-y-1">
                                      {subjectsOf(p.id).length === 0 ? <li className="py-1 pl-14 text-xs text-slate-500">{t.academics.noSubjects}</li> : null}
                                      {subjectsOf(p.id).map((s) => (
                                        <li key={s.id}>
                                          <TreeItem
                                            depth={3}
                                            label={s.title}
                                            meta={s.code}
                                            badge={`${subjectCounts.get(s.id) ?? 0}`}
                                            badgeLabel={t.academics.offeringsInTerm}
                                            selected={s.id === subject?.id}
                                            onSelect={() => navigate({ year: String(tm.academicYear), term: tm.id, program: p.id, subject: s.id })}
                                          />
                                        </li>
                                      ))}
                                    </ul>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </li>
                </ul>
              </nav>
            ) : (
              <p className="text-sm text-slate-600">{t.academics.noYears}</p>
            )}
          </div>
        </Card>

        <div className="min-w-0">
          {!activeYear ? (
            <PanelPlaceholder title={t.academics.startTitle} description={t.academics.startDescription} />
          ) : term && program && subject ? (
            <SubjectPanel
              key={subject.id}
              subjectId={subject.id}
              program={program}
              term={term}
              offerings={(offerings ?? []).filter((c) => c.templateId === subject.id)}
              onChanged={refreshAll}
            />
          ) : term && program ? (
            <ProgramPanel
              key={program.id}
              program={program}
              term={term}
              subjects={subjectsOf(program.id)}
              subjectCounts={subjectCounts}
              onChanged={refreshAll}
              onSelectSubject={(id) => navigate({ year: String(term.academicYear), term: term.id, program: program.id, subject: id })}
            />
          ) : term ? (
            <TermPanel
              key={term.id}
              term={term}
              programs={value?.programs ?? []}
              programCounts={programCounts}
              offeringCount={offerings?.length ?? null}
              onChanged={refreshAll}
              onSelectProgram={(id) => navigate({ year: String(term.academicYear), term: term.id, program: id })}
            />
          ) : (
            <YearPanel
              year={activeYear}
              terms={termsOfYear}
              onSelectTerm={(id) => navigate({ year: String(activeYear), term: id })}
              onCreated={async (created) => {
                await reload();
                navigate({ year: String(created.academicYear), term: created.id });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TreeItem({
  depth,
  label,
  meta,
  badge,
  badgeLabel,
  selected,
  expanded,
  onSelect,
}: {
  depth: 0 | 1 | 2 | 3;
  label: string;
  meta?: string;
  badge?: string;
  badgeLabel?: string;
  selected: boolean;
  expanded?: boolean;
  onSelect: () => void;
}) {
  const indent = ['pl-1', 'pl-5', 'pl-9', 'pl-13'][depth];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'page' : undefined}
      aria-expanded={depth < 3 ? Boolean(expanded) : undefined}
      className={`flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left ${indent} ${selected ? 'bg-brand-50 font-semibold text-brand-900' : 'text-slate-800 hover:bg-slate-100'}`}
    >
      <span aria-hidden="true" className="w-3 text-xs text-slate-400">
        {depth < 3 ? (expanded ? '▾' : '▸') : '•'}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {meta ? <span className="block truncate text-xs font-normal text-slate-500">{meta}</span> : null}
      </span>
      {badge ? (
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
          {badge}
          {badgeLabel ? <span className="sr-only"> {badgeLabel}</span> : null}
        </span>
      ) : null}
    </button>
  );
}

export function PanelPlaceholder({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  const { t } = useLocale();
  return (
    <Card className="space-y-2">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <p className="text-sm text-slate-600">{description}</p>
      {children}
      <Badge tone="neutral">{t.setup.hierarchy.adminOnly}</Badge>
    </Card>
  );
}
