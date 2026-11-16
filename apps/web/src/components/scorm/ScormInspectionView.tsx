'use client';

import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { contentAbilities } from '@/components/content/contentDisplay';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Course, CurrentUser, ScormInspectionIssue, ScormInspectionReport } from '@/lib/api/types';
import type { Messages } from '@/lib/i18n/messages';

/** Mirrors the API's 25 MB inspection limit (the API enforces it; this only saves a pointless upload). */
const MAX_BYTES = 25 * 1024 * 1024;
const BYTE_LIMIT_CODES = new Set(['SCORM_PACKAGE_TOO_LARGE', 'SCORM_ARCHIVE_TOO_LARGE', 'SCORM_ENTRY_TOO_LARGE', 'SCORM_MANIFEST_TOO_LARGE']);

type Load = { status: 'loading' } | { status: 'not-found' } | { status: 'error'; message: string } | { status: 'ready'; course: Course };
type ScormMessages = Messages['scorm'];

export function ScormInspectionView({ courseId }: { courseId: string }) {
  return <RequireAuth>{(user) => <Content courseId={courseId} user={user} />}</RequireAuth>;
}

/**
 * AP-033B: content editors check a SCORM package's structure. A dry run: the API stores nothing, creates no activity
 * and never runs the package, and this page offers no import or publish action because SCORM playback does not exist.
 */
function Content({ courseId, user }: { courseId: string; user: CurrentUser }) {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const s = t.scorm;
  const [state, setState] = useState<Load>({ status: 'loading' });
  useEffect(() => {
    api
      .getCourse(courseId)
      .then((course) => setState({ status: 'ready', course }))
      .catch((error: unknown) => {
        if (isApiError(error, 401)) handleUnauthorized();
        else if (isApiError(error, 404) || isApiError(error, 400)) setState({ status: 'not-found' });
        else setState({ status: 'error', message: describeApiError(error, locale) });
      });
  }, [courseId, handleUnauthorized, locale]);

  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {s.loading}
      </p>
    );
  }
  if (state.status === 'not-found') return <EmptyState titleAs="h1" title={s.notFound} />;
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  const { course } = state;
  const header = (
    <PageHeader
      title={s.title}
      kicker={course.code}
      breadcrumbLabel={t.common.breadcrumb}
      breadcrumbs={[{ label: t.nav.myCourses, href: '/courses' }, { label: course.title, href: `/courses/${course.id}` }, { label: s.navLabel }]}
    />
  );
  // The API decides (403 otherwise); students and non-editing instructors are told so instead of seeing a form.
  if (!contentAbilities(user, course.viewerRole).edit) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s.title} description={s.forbidden} />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {header}
      <Alert tone="info">
        <span className="block">{s.intro}</span>
        <span className="mt-1 block font-medium">{s.playbackNotice}</span>
      </Alert>
      <Inspector courseId={course.id} />
    </div>
  );
}

function Inspector({ courseId }: { courseId: string }) {
  const { getCsrfToken, handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const s = t.scorm;
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [report, setReport] = useState<ScormInspectionReport | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (report) resultHeading.current?.focus();
  }, [report]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    setReport(null);
    if (!file) return setFileError(s.chooseFile);
    if (!/\.zip$/i.test(file.name)) return setFileError(s.onlyZip);
    if (file.size > MAX_BYTES) return setFileError(s.tooLarge);
    setFileError(undefined);
    setPending(true);
    try {
      setReport(await api.inspectScormPackage(courseId, file, await getCsrfToken()));
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setFailure(isApiError(error, 413) ? s.tooLarge : isApiError(error, 415) ? s.onlyZip : isApiError(error, 429) ? s.rateLimited : describeApiError(error, locale));
    } finally {
      setPending(false);
    }
  };

  const reset = () => {
    setReport(null);
    setFile(null);
    setFailure(null);
    if (fileInput.current) {
      fileInput.current.value = '';
      fileInput.current.focus();
    }
  };

  return (
    <>
      <Card as="section" aria-labelledby="scorm-form-heading">
        <form noValidate onSubmit={submit} className="space-y-4">
          <h2 id="scorm-form-heading" className="text-lg font-semibold text-brand-600">
            {s.formHeading}
          </h2>
          <div>
            <label htmlFor="scorm-file" className="block text-sm font-medium text-slate-800">
              {s.fileLabel}
            </label>
            <input
              ref={fileInput}
              id="scorm-file"
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              aria-invalid={fileError ? true : undefined}
              aria-describedby={fileError ? 'scorm-file-hint scorm-file-error' : 'scorm-file-hint'}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setFileError(undefined);
                setReport(null);
                setFailure(null);
              }}
              className="mt-1 block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-800 hover:file:bg-slate-50"
            />
            <p id="scorm-file-hint" className="mt-1 text-xs text-slate-500">
              {s.fileHint}
            </p>
            {fileError ? (
              <p id="scorm-file-error" className="mt-1 text-sm text-red-700">
                {fileError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? s.inspecting : s.inspect}
            </Button>
            {pending ? (
              <p role="status" className="text-sm text-slate-600">
                {s.inspectingStatus}
              </p>
            ) : null}
          </div>
          {failure ? <Alert tone="error">{failure}</Alert> : null}
        </form>
      </Card>
      {report ? <Report report={report} headingRef={resultHeading} onReset={reset} /> : null}
    </>
  );
}

function useSizeFormat() {
  const { t, locale } = useLocale();
  return (bytes: number) => {
    const format = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
    if (bytes < 1024) return t.scorm.bytes(format(bytes), 'B');
    if (bytes < 1024 * 1024) return t.scorm.bytes(format(bytes / 1024), 'KB');
    return t.scorm.bytes(format(bytes / (1024 * 1024)), 'MB');
  };
}

function standardText(s: ScormMessages, report: ScormInspectionReport): string {
  const { format, version, edition, schemaVersion } = report.standard;
  const name = version ? `${s.standards[version]}${edition ? ` · ${s.editions[edition]}` : ''}` : s.standards[format];
  return schemaVersion ? `${name} (${s.declared(schemaVersion)})` : name;
}

function Report({ report, headingRef, onReset }: { report: ScormInspectionReport; headingRef: RefObject<HTMLHeadingElement | null>; onReset: () => void }) {
  const { t } = useLocale();
  const s = t.scorm;
  const size = useSizeFormat();
  const errors = report.issues.filter((issue) => issue.severity === 'error');
  const warnings = report.issues.filter((issue) => issue.severity === 'warning');
  const tone = report.status === 'invalid' ? 'error' : report.status === 'valid' ? 'success' : 'info';
  const summary: Array<[string, string, string]> = [
    ['standard', s.fields.standard, standardText(s, report)],
    ['title', s.fields.title, report.title ?? s.untitled],
    ['file', s.fields.file, report.package.fileName ?? s.unnamedFile],
    ['size', s.fields.size, s.sizes(size(report.package.compressedBytes), report.package.uncompressedBytes === null ? null : size(report.package.uncompressedBytes))],
    ['content', s.fields.content, s.contentCounts(report.counts.scos, report.counts.assets, report.package.fileCount)],
    ['playback', s.fields.playback, s.playback[report.runtime.plannedSupport]],
  ];

  return (
    <section aria-labelledby="scorm-result-heading" className="space-y-6" data-scorm-report data-scorm-status={report.status}>
      <h2 id="scorm-result-heading" ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight text-brand-600 outline-none">
        {s.resultHeading}
      </h2>
      <Alert tone={tone}>
        <span className="block font-semibold">{s.status[report.status]}</span>
        <span className="mt-1 block">{s.statusDetail[report.status]}</span>
      </Alert>
      <Alert tone="info">
        <span data-scorm-not-imported>{s.notImported}</span>
      </Alert>

      <Card as="section" aria-label={s.summaryLabel}>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {summary.map(([key, label, value]) => (
            <div key={key} className="min-w-0">
              <dt className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{label}</dt>
              <dd className="mt-1 text-sm break-words text-slate-900" data-scorm-field={key}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      {report.standard.format === 'common_cartridge' ? <Alert tone="info">{s.commonCartridgeHint}</Alert> : null}

      <Card as="section" aria-labelledby="scorm-launchable-heading" className="space-y-3">
        <h3 id="scorm-launchable-heading" className="text-lg font-semibold text-brand-600">
          {s.launchableHeading}
        </h3>
        <p className="text-sm text-slate-600">{s.launchableIntro}</p>
        {report.launchable.length ? (
          <ol className="space-y-2">
            {report.launchable.map((entry) => (
              <li key={`${entry.organization}/${entry.item}`} className="rounded-lg border border-slate-200 px-4 py-3" data-scorm-launchable>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium break-words text-slate-900">{entry.title ?? entry.item}</span>
                  <Badge tone={entry.scormType === 'sco' ? 'brand' : 'neutral'}>{entry.scormType === 'sco' ? s.sco : s.asset}</Badge>
                  {entry.visible ? null : <Badge>{s.hidden}</Badge>}
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  <span className="font-medium">{s.launchFile}</span> <code className="break-all text-slate-800">{`${entry.launchPath}${entry.parameters ?? ''}`}</code>
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-slate-500">{s.launchableEmpty}</p>
        )}
        {report.resources.length ? (
          <details className="rounded-lg border border-slate-200 px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium text-slate-800">{s.resourcesHeading(report.counts.resources)}</summary>
            <ul className="mt-3 space-y-2">
              {report.resources.map((resource) => (
                <li key={resource.identifier} className="text-sm">
                  <span className="font-medium break-all text-slate-900">{resource.identifier}</span>{' '}
                  <Badge tone={resource.scormType === 'sco' ? 'brand' : 'neutral'}>{resource.scormType === 'sco' ? s.sco : s.asset}</Badge>
                  <span className="block text-xs break-all text-slate-600">{resource.launchPath ?? s.noLaunchFile}</span>
                  <span className="block text-xs text-slate-500">{s.resourceDetail(resource.fileCount, resource.missingFileCount, resource.dependencyCount)}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {report.listsTruncated ? <p className="text-xs text-slate-500">{s.listsTruncated}</p> : null}
      </Card>

      <Card as="section" aria-labelledby="scorm-issues-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="scorm-issues-heading" className="text-lg font-semibold text-brand-600">
            {s.issuesHeading}
          </h3>
          <p className="text-sm text-slate-600">{s.issueCounts(errors.length, warnings.length)}</p>
        </div>
        {report.issues.length ? (
          <ul className="space-y-2">
            {[...errors, ...warnings].map((issue, index) => (
              <IssueRow key={`${issue.code}-${index}`} issue={issue} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">{s.noIssues}</p>
        )}
        {report.issuesTruncated ? <p className="text-xs text-slate-500">{s.issuesTruncated}</p> : null}
      </Card>

      <Button variant="secondary" onClick={onReset}>
        {s.another}
      </Button>
    </section>
  );
}

function IssueRow({ issue }: { issue: ScormInspectionIssue }) {
  const { t, locale } = useLocale();
  const s = t.scorm;
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  const details = [
    issue.path ? s.where.path(issue.path) : null,
    issue.line ? s.where.line(issue.line) : null,
    issue.value ? s.where.value(issue.value) : null,
    issue.limit === null
      ? null
      : BYTE_LIMIT_CODES.has(issue.code)
        ? s.where.limitBytes(number(issue.limit / (1024 * 1024)))
        : issue.code === 'SCORM_ENTRY_EXPANSION_RATIO'
          ? s.where.limitRatio(number(issue.limit))
          : s.where.limitCount(number(issue.limit)),
  ].filter((detail): detail is string => detail !== null);
  const isError = issue.severity === 'error';
  return (
    <li className={`rounded-lg border px-4 py-3 ${isError ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`} data-scorm-issue={issue.code} data-scorm-severity={issue.severity}>
      <p className="text-sm text-slate-900">
        <span className={`mr-2 inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${isError ? 'bg-red-700 text-white' : 'bg-amber-200 text-amber-900'}`}>{isError ? s.error : s.warning}</span>
        {s.issues[issue.code] ?? issue.message}
      </p>
      {details.length ? (
        <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
          {details.map((detail) => (
            <li key={detail} className="break-all">
              {detail}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
