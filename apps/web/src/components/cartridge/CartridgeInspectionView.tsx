'use client';

import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { contentAbilities } from '@/components/content/contentDisplay';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useLocalizedState } from '@/components/i18n/useLocalizedState';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { FileInput } from '@/components/ui/FileInput';
import { PageHeader } from '@/components/ui/PageHeader';
import { tableClasses } from '@/components/ui/table';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { CartridgeInspectionIssue, CartridgeInspectionReport, CartridgeResource, Course, CurrentUser } from '@/lib/api/types';

/** Mirrors the API's 25 MB inspection limit (the API enforces it; this only saves a pointless upload). */
const MAX_BYTES = 25 * 1024 * 1024;
const BYTE_LIMIT_CODES = new Set(['CARTRIDGE_ARCHIVE_TOO_LARGE', 'CARTRIDGE_ENTRY_TOO_LARGE', 'CARTRIDGE_MANIFEST_TOO_LARGE', 'CARTRIDGE_DESCRIPTOR_LIMIT']);
const CLASSIFICATION_TONES: Record<CartridgeResource['classification'], BadgeTone> = { recognized: 'neutral', mappable: 'success', transform: 'gold', unsupported: 'warning', invalid: 'warning' };

type Load = { status: 'loading' } | { status: 'not-found' } | { status: 'error'; message: string } | { status: 'ready'; course: Course };

export function CartridgeInspectionView({ courseId }: { courseId: string }) {
  return <RequireAuth>{(user) => <Content courseId={courseId} user={user} />}</RequireAuth>;
}

/**
 * AP-038D: content editors check an IMS Common Cartridge (e.g. a Canvas course export) before planning a migration.
 * A dry run: the API stores nothing, imports nothing and never runs or fetches the package's content; this page offers
 * no import action because none exists. Text from the package (titles, paths, addresses) is shown as written.
 */
function Content({ courseId, user }: { courseId: string; user: CurrentUser }) {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const c = t.cartridge;
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
        {c.loading}
      </p>
    );
  }
  if (state.status === 'not-found') return <EmptyState titleAs="h1" title={c.notFound} />;
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  const { course } = state;
  const header = (
    <PageHeader
      title={c.title}
      kicker={course.code}
      breadcrumbLabel={t.common.breadcrumb}
      breadcrumbs={[{ label: t.nav.myCourses, href: '/courses' }, { label: course.title, href: `/courses/${course.id}` }, { label: c.navLabel }]}
    />
  );
  // The API decides (403 otherwise); students and non-editing instructors are told so instead of seeing a form.
  if (!contentAbilities(user, course.viewerRole).edit) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={c.title} description={c.forbidden} />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {header}
      <Alert tone="info">
        <span className="block">{c.intro}</span>
        <span className="mt-1 block font-medium">{c.importNotice}</span>
      </Alert>
      <Inspector courseId={course.id} />
    </div>
  );
}

function Inspector({ courseId }: { courseId: string }) {
  const { getCsrfToken, handleUnauthorized } = useSession();
  const { t } = useLocale();
  const c = t.cartridge;
  const [file, setFile] = useState<File | null>(null);
  // Messages follow the EN/ES switch while they are shown (AP-I18N-01 convention).
  const [fileError, setFileError] = useLocalizedState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useLocalizedState<string | null>(null);
  const [report, setReport] = useState<CartridgeInspectionReport | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (report) resultHeading.current?.focus();
  }, [report]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    setReport(null);
    if (!file) return setFileError((m) => m.cartridge.chooseFile);
    if (!/\.(imscc|zip)$/i.test(file.name)) return setFileError((m) => m.cartridge.onlyCartridge);
    if (file.size > MAX_BYTES) return setFileError((m) => m.cartridge.tooLarge);
    setFileError(undefined);
    setPending(true);
    try {
      setReport(await api.inspectCommonCartridge(courseId, file, await getCsrfToken()));
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setFailure((m, ml) =>
        isApiError(error, 413) ? m.cartridge.tooLarge : isApiError(error, 415) ? m.cartridge.onlyCartridge : isApiError(error, 429) ? m.cartridge.rateLimited : describeApiError(error, ml),
      );
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
      <Card as="section" aria-labelledby="cartridge-form-heading">
        <form noValidate onSubmit={submit} className="space-y-4">
          <h2 id="cartridge-form-heading" className="text-lg font-semibold text-brand-600">
            {c.formHeading}
          </h2>
          <div>
            <label htmlFor="cartridge-file" className="block text-sm font-medium text-slate-800">
              {c.fileLabel}
            </label>
            <FileInput
              ref={fileInput}
              id="cartridge-file"
              accept=".imscc,.zip,application/zip,application/x-zip-compressed"
              aria-invalid={fileError ? true : undefined}
              aria-describedby={fileError ? 'cartridge-file-hint cartridge-file-error' : 'cartridge-file-hint'}
              selectedName={file?.name ?? null}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setFileError(undefined);
                setReport(null);
                setFailure(null);
              }}
            />
            <p id="cartridge-file-hint" className="mt-1 text-xs text-slate-500">
              {c.fileHint}
            </p>
            {fileError ? (
              <p id="cartridge-file-error" className="mt-1 text-sm text-red-700">
                {fileError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? c.inspecting : c.inspect}
            </Button>
            {pending ? (
              <p role="status" className="text-sm text-slate-600">
                {c.inspectingStatus}
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

function useSize() {
  const { t, locale } = useLocale();
  return (bytes: number) => {
    const format = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
    if (bytes < 1024) return t.cartridge.bytes(format(bytes), 'B');
    if (bytes < 1024 * 1024) return t.cartridge.bytes(format(bytes / 1024), 'KB');
    return t.cartridge.bytes(format(bytes / (1024 * 1024)), 'MB');
  };
}

function Report({ report, headingRef, onReset }: { report: CartridgeInspectionReport; headingRef: RefObject<HTMLHeadingElement | null>; onReset: () => void }) {
  const { t } = useLocale();
  const c = t.cartridge;
  const size = useSize();
  const errors = report.issues.filter((issue) => issue.severity === 'error');
  const warnings = report.issues.filter((issue) => issue.severity === 'warning');
  const tone = report.status === 'invalid' ? 'error' : report.status === 'valid' ? 'success' : 'info';
  const formatText = `${c.formats[report.format]}${report.version ? ` · ${c.version(report.version)}` : ''}${report.declared.schemaVersion ? ` (${c.declared(report.declared.schemaVersion)})` : ''}`;
  const summary: Array<[string, string, string]> = [
    ['format', c.fields.format, formatText],
    ['title', c.fields.title, report.title ?? c.untitled],
    ['file', c.fields.file, report.package.fileName ?? c.unnamedFile],
    ['size', c.fields.size, c.sizes(size(report.package.compressedBytes), report.package.uncompressedBytes === null ? null : size(report.package.uncompressedBytes))],
    ['canvas', c.fields.canvas, report.canvas.detected ? c.canvasDetected : c.canvasNotDetected],
    ['content', c.fields.content, c.contentCounts(report.counts.modules, report.counts.outlineItems, report.counts.resources, report.counts.questions)],
  ];
  // The language the package declares about itself, shown as written (authored metadata is never translated).
  if (report.language) summary.push(['language', c.fields.language, report.language]);

  return (
    <section aria-labelledby="cartridge-result-heading" className="space-y-6" data-cartridge-report data-cartridge-status={report.status}>
      <h2 id="cartridge-result-heading" ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight text-brand-600">
        {c.resultHeading}
      </h2>
      <Alert tone={tone}>
        <span className="block font-semibold">{c.status[report.status]}</span>
        <span className="mt-1 block">{c.statusDetail[report.status]}</span>
      </Alert>
      <Alert tone="info">
        <span data-cartridge-not-imported>{c.notImported}</span>
      </Alert>

      <Card as="section" aria-label={c.summaryLabel}>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {summary.map(([key, label, value]) => (
            <div key={key} className="min-w-0">
              <dt className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{label}</dt>
              <dd className="mt-1 text-sm break-words text-slate-900" data-cartridge-field={key}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card as="section" aria-labelledby="cartridge-compat-heading" className="space-y-3">
        <h3 id="cartridge-compat-heading" className="text-lg font-semibold text-brand-600">
          {c.compatibilityHeading}
        </h3>
        <p className="text-sm text-slate-600">{c.compatibilityIntro}</p>
        {report.compatibility.length ? (
          <div className={tableClasses.wrapper}>
            <table className={tableClasses.table}>
              <thead className={tableClasses.head}>
                <tr>
                  <th scope="col" className={tableClasses.th}>{c.columns.content}</th>
                  <th scope="col" className={tableClasses.th}>{c.columns.count}</th>
                  <th scope="col" className={tableClasses.th}>{c.columns.target}</th>
                  <th scope="col" className={tableClasses.th}>{c.columns.support}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.compatibility.map((row) => (
                  <tr key={`${row.kind}-${row.support}`} className={tableClasses.row} data-cartridge-compat={row.kind} data-support={row.support}>
                    <th scope="row" className={`${tableClasses.td} font-medium text-slate-900`}>
                      {c.kinds[row.kind]}
                    </th>
                    <td className={tableClasses.td}>{row.count}</td>
                    <td className={tableClasses.td}>{row.target ? c.targets[row.target] : c.targets.none}</td>
                    <td className={tableClasses.td}>{c.support[row.support]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-500">{c.compatibilityEmpty}</p>
        )}
        <p className="text-xs text-slate-600">{c.classificationsLegend}</p>
      </Card>

      <Card as="section" aria-labelledby="cartridge-outline-heading" className="space-y-3">
        <h3 id="cartridge-outline-heading" className="text-lg font-semibold text-brand-600">
          {c.outlineHeading}
        </h3>
        {report.modules.length ? (
          <ol className="space-y-3">
            {report.modules.map((module, index) => (
              <li key={`${module.title}-${index}`} className="rounded-lg border border-slate-200 px-4 py-3" data-cartridge-module>
                <p className="font-medium break-words text-slate-900">
                  {module.title ?? c.untitledModule} <span className="text-xs font-normal text-slate-500">· {c.moduleItems(module.itemCount)}</span>
                </p>
                {module.items.length ? (
                  <ul className="mt-2 space-y-1 text-sm">
                    {module.items.map((item, position) => (
                      <li key={`${item.identifierref}-${position}`} className="flex min-w-0 flex-wrap items-center gap-2" style={{ paddingInlineStart: `${Math.max(0, item.depth - 1) * 1}rem` }} data-cartridge-item>
                        <span className="min-w-0 break-words text-slate-800">{item.title ?? c.untitled}</span>
                        {item.kind ? <span className="text-xs text-slate-500">{c.kinds[item.kind]}</span> : <span className="text-xs text-slate-500">{c.textHeading}</span>}
                        {item.classification ? <Badge tone={CLASSIFICATION_TONES[item.classification]}>{c.classifications[item.classification]}</Badge> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-slate-500">{c.outlineEmpty}</p>
        )}
      </Card>

      {report.resources.length ? (
        <Card as="section" aria-label={c.resourcesHeading(report.counts.resources)} className="space-y-3">
          <details>
            <summary className="cursor-pointer text-lg font-semibold text-brand-600">{c.resourcesHeading(report.counts.resources)}</summary>
            <ul className="mt-3 space-y-2">
              {report.resources.map((resource, index) => (
                <ResourceRow key={`${resource.identifier}-${index}`} resource={resource} />
              ))}
            </ul>
          </details>
          {report.listsTruncated ? <p className="text-xs text-slate-500">{c.listsTruncated}</p> : null}
        </Card>
      ) : null}

      <Card as="section" aria-labelledby="cartridge-issues-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="cartridge-issues-heading" className="text-lg font-semibold text-brand-600">
            {c.issuesHeading}
          </h3>
          <p className="text-sm text-slate-600">{c.issueCounts(errors.length, warnings.length)}</p>
        </div>
        {report.issues.length ? (
          <ul className="space-y-2">
            {[...errors, ...warnings].map((issue, index) => (
              <IssueRow key={`${issue.code}-${index}`} issue={issue} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">{c.noIssues}</p>
        )}
        {report.issuesTruncated ? <p className="text-xs text-slate-500">{c.issuesTruncated}</p> : null}
      </Card>

      <Button variant="secondary" onClick={onReset}>
        {c.another}
      </Button>
    </section>
  );
}

function ResourceRow({ resource }: { resource: CartridgeResource }) {
  const { t } = useLocale();
  const c = t.cartridge;
  const details: string[] = [];
  if (resource.questionCount !== null) {
    const types = resource.questionTypes.map((entry) => `${c.questionTypes[entry.type] ?? entry.type} × ${entry.count}${entry.supported ? '' : ` (${c.notSupportedType})`}`).join(', ');
    details.push(`${c.questions(resource.questionCount)}${types ? `: ${types}` : ''}`);
  }
  if (resource.url) details.push(c.address(resource.url));
  if (resource.submissionTypes.length) details.push(c.submissionTypes(resource.submissionTypes.join(', ')));
  if (resource.kind === 'page') details.push(c.links(resource.externalLinks, resource.brokenLinks, resource.canvasLinks));
  if (resource.missingFileCount) details.push(c.missingFiles(resource.missingFileCount));
  return (
    <li className="rounded-lg border border-slate-200 px-4 py-3 text-sm" data-cartridge-resource={resource.identifier ?? ''} data-classification={resource.classification}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 font-medium break-words text-slate-900">{resource.title ?? resource.identifier ?? c.untitled}</span>
        <span className="text-xs text-slate-500">{c.kinds[resource.kind]}</span>
        <Badge tone={CLASSIFICATION_TONES[resource.classification]}>{c.classifications[resource.classification]}</Badge>
        {resource.canvas ? <Badge tone="brand">{c.canvasBadge}</Badge> : null}
      </div>
      {resource.href ? <code className="mt-1 block text-xs break-all text-slate-600">{resource.href}</code> : null}
      {details.map((detail) => (
        <p key={detail} className="mt-1 text-xs break-words text-slate-700">
          {detail}
        </p>
      ))}
    </li>
  );
}

function IssueRow({ issue }: { issue: CartridgeInspectionIssue }) {
  const { t, locale } = useLocale();
  const c = t.cartridge;
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  const details = [
    issue.path ? c.where.path(issue.path) : null,
    issue.line ? c.where.line(issue.line) : null,
    issue.value ? c.where.value(issue.value) : null,
    issue.limit === null ? null : BYTE_LIMIT_CODES.has(issue.code) ? c.where.limitBytes(number(issue.limit / (1024 * 1024))) : c.where.limitCount(number(issue.limit)),
  ].filter((detail): detail is string => detail !== null);
  const isError = issue.severity === 'error';
  return (
    <li className={`rounded-lg border px-4 py-3 ${isError ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`} data-cartridge-issue={issue.code} data-cartridge-severity={issue.severity}>
      <p className="text-sm text-slate-900">
        <span className={`mr-2 inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${isError ? 'bg-red-700 text-white' : 'bg-amber-200 text-amber-900'}`}>{isError ? c.error : c.warning}</span>
        {c.issues[issue.code] ?? issue.message}
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
