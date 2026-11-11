'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { SubjectForm } from '@/components/admin/academics/AcademicPanels';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { useWorkspace } from '@/components/session/WorkspaceProvider';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingCards } from '@/components/ui/Skeleton';
import { isApiError } from '@/lib/api/client';
import { api, loadAll } from '@/lib/api/endpoints';
import type { CourseTemplate, CourseTemplateDetail, CourseTemplateVersionList, ManagedProgramList } from '@/lib/api/types';
import { formatDate } from '@/lib/i18n/messages';

type ManagedProgram = ManagedProgramList['items'][number];

/**
 * Workspace for program managers: the subjects of the programs they hold a grant for. The page only
 * shows what the API returns; every read and write is authorized by the API per program.
 */
export function AcademicWorkspace() {
  return <RequireAuth>{() => <WorkspaceContent />}</RequireAuth>;
}

function WorkspaceContent() {
  const { t, locale } = useLocale();
  const p = t.programs;
  const { handleUnauthorized } = useSession();
  const { rolesHeld } = useWorkspace();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: ManagedProgramList }>({ status: 'loading' });
  const [programId, setProgramId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.myManagedPrograms();
      setState({ status: 'ready', data });
      setProgramId((current) => current ?? data.items[0]?.id ?? null);
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [handleUnauthorized, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const header = <PageHeader title={p.workspaceTitle} description={p.workspaceIntro} />;
  if (state.status === 'loading') return <div className="space-y-6">{header}<LoadingCards label={p.loading} count={2} /></div>;
  if (state.status === 'error') return <div className="space-y-6">{header}<Alert tone="error">{state.message}</Alert></div>;
  const { data } = state;
  if (data.items.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState titleAs="h2" title={p.noProgramsTitle} description={p.noProgramsDescription} />
      </div>
    );
  }
  const selected = data.items.find((program) => program.id === programId) ?? data.items[0]!;

  return (
    <div className="space-y-6">
      {header}
      {data.scope === 'all' ? (
        <Alert tone="info">
          {p.adminScope}{' '}
          <Link href="/admin/academics" className="font-medium underline">
            {t.nav.academicStructure}
          </Link>
        </Alert>
      ) : null}
      {rolesHeld.has('design_team') ? (
        <Link href="/dashboard" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
          {p.contentReview}
        </Link>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card as="section" aria-labelledby="my-programs-heading" className="space-y-3 self-start">
          <h2 id="my-programs-heading" className="text-lg font-semibold text-brand-600">
            {p.programs}
          </h2>
          <ul className="space-y-2">
            {data.items.map((program) => (
              <li key={program.id}>
                <button
                  type="button"
                  aria-pressed={program.id === selected.id}
                  onClick={() => setProgramId(program.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left ${program.id === selected.id ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}
                >
                  <span className="block font-medium text-slate-900">{program.name}</span>
                  <span className="block text-xs text-slate-500">
                    {program.code} · {p.subjectCount(program.subjectCount)}
                  </span>
                  {program.isActive ? null : (
                    <Badge tone="warning" className="mt-1">
                      {p.inactiveProgram}
                    </Badge>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <ProgramSubjects key={selected.id} program={selected} onChanged={load} />
      </div>
    </div>
  );
}

function ProgramSubjects({ program, onChanged }: { program: ManagedProgram; onChanged: () => Promise<void> }) {
  const { t, locale } = useLocale();
  const p = t.programs;
  const { handleUnauthorized } = useSession();
  const [subjects, setSubjects] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: CourseTemplate[] }>({ status: 'loading' });
  const [subjectId, setSubjectId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSubjects({ status: 'ready', items: await loadAll((page) => api.listCourseTemplates(page, program.id)) });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setSubjects({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [program.id, handleUnauthorized, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    await load();
    await onChanged();
  };

  return (
    <div className="min-w-0 space-y-6">
      <Card as="section" aria-labelledby="program-subjects-heading" className="space-y-4">
        <h2 id="program-subjects-heading" className="text-lg font-semibold text-brand-600">
          {p.subjectsIn(program.name)}
        </h2>
        {subjects.status === 'loading' ? (
          <p role="status" className="text-sm text-slate-600">
            {t.common.loading}
          </p>
        ) : subjects.status === 'error' ? (
          <Alert tone="error">{subjects.message}</Alert>
        ) : subjects.items.length === 0 ? (
          <p className="text-sm text-slate-600">{p.noSubjects}</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {subjects.items.map((subject) => (
              <li key={subject.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">{subject.title}</p>
                  <p className="text-xs text-slate-500">
                    {subject.code} · v{subject.latestVersion?.version ?? 0}
                  </p>
                </div>
                {subject.id === subjectId ? (
                  <Badge tone="brand">{p.selected}</Badge>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => setSubjectId(subject.id)}>
                    {p.open}
                    <span className="sr-only"> {subject.code}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <SubjectForm mode={{ kind: 'create', programId: program.id }} onSaved={refresh} />
      </Card>
      {subjectId ? <SubjectDetail key={subjectId} subjectId={subjectId} onChanged={refresh} /> : null}
    </div>
  );
}

function SubjectDetail({ subjectId, onChanged }: { subjectId: string; onChanged: () => Promise<void> }) {
  const { t, locale } = useLocale();
  const p = t.programs;
  const h = t.setup.hierarchy;
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; detail: CourseTemplateDetail; versions: CourseTemplateVersionList }>({
    status: 'loading',
  });

  const load = useCallback(async () => {
    try {
      const [detail, versions] = await Promise.all([api.getCourseTemplate(subjectId), api.listCourseTemplateVersions(subjectId)]);
      setState({ status: 'ready', detail, versions });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [subjectId, handleUnauthorized, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {h.loadingSubject}
      </p>
    );
  }
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  const { detail, versions } = state;
  const latest = detail.latestVersion;

  return (
    <Card as="section" aria-labelledby="subject-detail-heading" className="space-y-4">
      <div>
        <p className="text-xs font-semibold tracking-wide text-brand-700 uppercase">{detail.code}</p>
        <h2 id="subject-detail-heading" className="text-lg font-semibold text-brand-600">
          {latest?.title ?? detail.title}
        </h2>
        {latest?.description ? <p className="text-sm text-slate-700">{latest.description}</p> : null}
      </div>
      {latest?.sections.length ? (
        <ol className="list-decimal space-y-1 pl-6 text-sm text-slate-800">
          {latest.sections.map((section) => (
            <li key={section.id}>
              {section.title}
              {section.isVisible ? null : <span className="ml-2 text-xs text-slate-500">{h.hidden}</span>}
            </li>
          ))}
        </ol>
      ) : null}
      <section aria-labelledby="versions-heading" className="space-y-2">
        <h3 id="versions-heading" className="font-semibold text-slate-900">
          {p.versionsTitle}
        </h3>
        <ol className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {versions.items.map((version, index) => (
            <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">{version.title}</p>
                <p className="text-xs text-slate-500">{p.versionLine(version.version, version.sectionCount, formatDate(version.createdAt, locale))}</p>
              </div>
              {index === 0 ? <Badge tone="success">{p.latest}</Badge> : null}
            </li>
          ))}
        </ol>
      </section>
      {/* Not keyed by version: the confirmation stays visible and the next edit builds on the new version. */}
      <SubjectForm
        mode={{ kind: 'edit', detail }}
        onSaved={async () => {
          await load();
          await onChanged();
        }}
      />
    </Card>
  );
}
