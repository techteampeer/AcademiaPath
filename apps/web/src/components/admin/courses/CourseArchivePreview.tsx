'use client';

import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useLocalizedState } from '@/components/i18n/useLocalizedState';
import { ArchiveImport } from '@/components/admin/courses/CourseArchiveImport';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FileInput } from '@/components/ui/FileInput';
import { PageHeader } from '@/components/ui/PageHeader';
import { tableClasses } from '@/components/ui/table';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { CourseArchivePreviewReport } from '@/lib/api/types';

/** Mirrors the API's provisional 25 MB archive limit (the API enforces it; this only saves a pointless upload). */
const MAX_BYTES = 25 * 1024 * 1024;
const ARCHIVE_FORMAT = 'academiapath.course-archive';
/** Activity types with their own count; any other type is listed under "Other activities". */
const COUNTED_TYPES = new Set(['page', 'quiz', 'assignment', 'link', 'file']);

type Issue = CourseArchivePreviewReport['issues'][number];
type Preview = NonNullable<CourseArchivePreviewReport['preview']>;
/**
 * What was checked: the report and the file's name. The chosen file itself (a browser file handle; its bytes are never
 * read here) is kept only while an importable report is shown, for the import step (AP-038C2F); it is released when the
 * page is cleared, another file is chosen or the import succeeded.
 */
type Checked = { report: CourseArchivePreviewReport; fileName: string; file: File | null };

/**
 * AP-038C2D: administrators check a portable course archive (.zip, AP-038C1E) and see what an import would create.
 * The file is sent as it is to the preview API (AP-038C2C), which validates it in an isolated worker and stores
 * nothing; the browser never reads, unpacks or runs it. There is no import action yet. Text from the archive (titles,
 * descriptions, file names, paths) is shown as plain text, as written.
 */
export function CourseArchivePreview() {
  return <RequireAuth role="administrator">{() => <Content />}</RequireAuth>;
}

function Content() {
  const { t } = useLocale();
  const c = t.courseImport.archive;
  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: t.nav.adminOverview, href: '/admin' },
          { label: t.admin.coursesTitle, href: '/admin/courses' },
          { label: t.courseImport.title, href: '/admin/courses/import' },
          { label: c.title },
        ]}
        breadcrumbLabel={t.common.breadcrumb}
        title={c.title}
      />
      <Alert tone="info">
        <span className="block">{c.intro}</span>
        <span className="mt-1 block font-medium" data-archive-draft-notice>
          {c.draftNotice}
        </span>
      </Alert>
      <Checker />
    </div>
  );
}

function Checker() {
  const { getCsrfToken, handleUnauthorized } = useSession();
  const { t } = useLocale();
  const c = t.courseImport.archive;
  const [file, setFile] = useState<File | null>(null);
  // Messages follow the EN/ES switch while they are shown (AP-I18N-01 convention).
  const [fileError, setFileError] = useLocalizedState<string | undefined>(undefined);
  const [failure, setFailure] = useLocalizedState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  // Focus moves to a NEW report only (releasing the file after an import must not pull focus back from its result).
  const report = checked?.report;
  useEffect(() => {
    if (report) resultHeading.current?.focus();
  }, [report]);

  const forgetFile = () => {
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    setChecked(null);
    // Checked from the name and size only: the browser never reads the archive's bytes.
    if (!file) return setFileError((m) => m.courseImport.archive.chooseFile);
    if (!/\.zip$/i.test(file.name)) return setFileError((m) => m.courseImport.archive.onlyZip);
    if (file.size === 0) return setFileError((m) => m.courseImport.archive.emptyFile);
    if (file.size > MAX_BYTES) return setFileError((m) => m.courseImport.archive.tooLarge);
    setFileError(undefined);
    setPending(true);
    try {
      const report = await api.previewCourseArchive(file, await getCsrfToken());
      setChecked({ report, fileName: file.name, file: report.preview ? file : null });
      // The picker is cleared; only an importable archive's file is kept, for the import step below the report.
      forgetFile();
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setFailure((m, ml) =>
        isApiError(error, 413)
          ? m.courseImport.archive.tooLarge
          : isApiError(error, 415)
            ? m.courseImport.archive.onlyZip
            : isApiError(error, 429)
              ? m.courseImport.archive.rateLimited
              : describeApiError(error, ml),
      );
    } finally {
      setPending(false);
    }
  };

  const reset = () => {
    setChecked(null);
    setFailure(null);
    setFileError(undefined);
    forgetFile();
    fileInput.current?.focus();
  };

  return (
    <>
      <Card as="section" aria-labelledby="archive-form-heading">
        <form noValidate onSubmit={submit} className="space-y-4" data-archive-form>
          <h2 id="archive-form-heading" className="text-lg font-semibold text-brand-600">
            {c.formHeading}
          </h2>
          <div>
            <label htmlFor="archive-file" className="block text-sm font-medium text-slate-800">
              {c.fileLabel}
            </label>
            <FileInput
              ref={fileInput}
              id="archive-file"
              accept=".zip,application/zip,application/x-zip-compressed"
              aria-invalid={fileError ? true : undefined}
              aria-describedby={fileError ? 'archive-file-hint archive-file-error' : 'archive-file-hint'}
              selectedName={file?.name ?? null}
              disabled={pending}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setFileError(undefined);
                setFailure(null);
                setChecked(null);
              }}
            />
            <p id="archive-file-hint" className="mt-1 text-xs text-slate-500">
              {c.fileHint}
            </p>
            {fileError ? (
              <p id="archive-file-error" className="mt-1 text-sm text-red-700">
                {fileError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? c.checking : c.check}
            </Button>
            {file || checked || failure || fileError ? (
              <Button variant="secondary" onClick={reset} disabled={pending}>
                {c.clear}
              </Button>
            ) : null}
            {pending ? (
              <p role="status" className="text-sm text-slate-600">
                {c.checkingStatus}
              </p>
            ) : null}
          </div>
          {failure ? <Alert tone="error">{failure}</Alert> : null}
        </form>
      </Card>
      {checked ? <Report checked={checked} headingRef={resultHeading} onReset={reset} /> : null}
      {checked?.report.preview ? (
        <ArchiveImport preview={checked.report.preview} file={checked.file} onImported={() => setChecked((current) => current && { ...current, file: null })} onAnother={reset} />
      ) : null}
    </>
  );
}

function useFormat() {
  const { t, locale } = useLocale();
  const c = t.courseImport.archive;
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  return {
    number,
    size: (bytes: number) => {
      if (bytes < 1024) return c.bytes(number(bytes), 'B');
      if (bytes < 1024 * 1024) return c.bytes(number(bytes / 1024), 'KB');
      return c.bytes(number(bytes / (1024 * 1024)), 'MB');
    },
    date: (value: string | null) => {
      if (!value) return c.notRecorded;
      const time = Date.parse(value);
      // The date the archive records, shown in UTC (the export's own clock); an unreadable value is shown as written.
      return Number.isNaN(time) ? value : new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(time);
    },
  };
}

function Report({ checked, headingRef, onReset }: { checked: Checked; headingRef: RefObject<HTMLHeadingElement | null>; onReset: () => void }) {
  const { t } = useLocale();
  const c = t.courseImport.archive;
  const format = useFormat();
  const { report, fileName } = checked;
  const preview = report.preview;
  const errors = report.issues.filter((issue) => issue.severity === 'error');
  const warnings = report.issues.filter((issue) => issue.severity === 'warning');
  const tone = report.status === 'invalid' ? 'error' : report.status === 'valid' ? 'success' : 'info';
  const recognized = report.manifest.format === ARCHIVE_FORMAT && report.manifest.formatVersion !== null;
  const summary: Array<[string, string, string]> = [];
  if (preview) {
    // Authored by the source course's staff: shown as written, never translated.
    summary.push(['title', c.fields.title, preview.title ?? c.untitled]);
    summary.push(['description', c.fields.description, preview.description ?? c.noDescription]);
    summary.push(['sourceCode', c.fields.sourceCode, preview.sourceCourseCode ?? c.notRecorded]);
    summary.push(['exportedAt', c.fields.exportedAt, format.date(preview.exportedAt)]);
  }
  summary.push(['format', c.fields.format, recognized ? c.formatVersion(report.manifest.formatVersion!) : c.formatUnknown]);
  summary.push(['file', c.fields.file, fileName]);
  summary.push(['size', c.fields.size, c.sizes(format.size(report.archive.byteSize), report.archive.uncompressedBytes === null ? null : format.size(report.archive.uncompressedBytes))]);

  return (
    <section aria-labelledby="archive-result-heading" className="space-y-6" data-archive-report data-archive-status={report.status}>
      <h2 id="archive-result-heading" ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight text-brand-600">
        {c.resultHeading}
      </h2>
      <Alert tone={tone}>
        <span className="block font-semibold" data-archive-status-text>
          {c.status[report.status]}
        </span>
        <span className="mt-1 block">{c.statusDetail[report.status]}</span>
      </Alert>
      <Alert tone="info">
        <span className="block" data-archive-not-imported>
          {c.notImported}
        </span>
        <span className="mt-1 block">{c.draftNotice}</span>
      </Alert>

      <Card as="section" aria-label={c.summaryLabel}>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {summary.map(([key, label, value]) => (
            <div key={key} className="min-w-0">
              <dt className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{label}</dt>
              <dd className="mt-1 text-sm break-words whitespace-pre-line text-slate-900" data-archive-field={key}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      {preview ? <ContentCard preview={preview} /> : null}
      {preview ? <SupportCard preview={preview} /> : null}
      {preview ? <DocumentsCard preview={preview} /> : null}

      <Card as="section" aria-labelledby="archive-issues-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="archive-issues-heading" className="text-lg font-semibold text-brand-600">
            {c.issuesHeading}
          </h3>
          <p className="text-sm text-slate-600" data-archive-issue-counts>
            {c.issueCounts(errors.length, warnings.length)}
          </p>
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
        {report.issueCount > report.issues.length ? <p className="text-xs text-slate-500">{c.issuesMore(report.issues.length, report.issueCount)}</p> : null}
      </Card>

      <Button variant="secondary" onClick={onReset}>
        {c.another}
      </Button>
    </section>
  );
}

function ContentCard({ preview }: { preview: Preview }) {
  const { t } = useLocale();
  const c = t.courseImport.archive;
  const format = useFormat();
  const byType = preview.counts.activitiesByType;
  const counts: Array<[string, string, number]> = [
    ['units', c.counts.units, preview.counts.units],
    ['lessons', c.counts.lessons, byType.page ?? 0],
    ['quizzes', c.counts.quizzes, byType.quiz ?? 0],
    ['assignments', c.counts.assignments, byType.assignment ?? 0],
    ['documents', c.counts.documents, preview.documents.length],
    ['questions', c.counts.questions, preview.counts.questions],
    ['folders', c.counts.folders, preview.counts.folders],
    ['links', c.counts.links, byType.link ?? 0],
  ];
  const others = Object.entries(byType).filter(([type, n]) => !COUNTED_TYPES.has(type) && n > 0);
  return (
    <Card as="section" aria-labelledby="archive-content-heading" className="space-y-3">
      <h3 id="archive-content-heading" className="text-lg font-semibold text-brand-600">
        {c.contentHeading}
      </h3>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {counts.map(([key, label, value]) => (
          <div key={key} className="min-w-0 rounded-lg border border-slate-200 px-3 py-2" data-archive-count={key}>
            <dt className="text-xs font-medium break-words text-slate-600">{label}</dt>
            <dd className="text-lg font-semibold text-slate-900" data-archive-count-value>
              {format.number(value)}
            </dd>
          </div>
        ))}
      </dl>
      {others.length ? (
        <div>
          <p className="text-sm font-medium text-slate-800">{c.otherTypes}</p>
          <ul className="mt-1 text-sm text-slate-700">
            {others.map(([type, n]) => (
              <li key={type} className="break-words" data-archive-other-type={type}>
                {t.courseImport.types[type] ?? type}: {format.number(n)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function SupportCard({ preview }: { preview: Preview }) {
  const { t } = useLocale();
  const c = t.courseImport.archive;
  return (
    <Card as="section" aria-labelledby="archive-support-heading" className="space-y-3" data-archive-support>
      <h3 id="archive-support-heading" className="text-lg font-semibold text-brand-600">
        {c.supportHeading}
      </h3>
      <p className="text-sm text-slate-700" data-archive-importable>
        {c.importable(preview.counts.importableActivities)}
      </p>
      {preview.skipped.length ? (
        <div className="space-y-1" data-archive-skipped>
          <p className="text-sm text-slate-700">{c.notImportable(preview.skipped.length)}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            {preview.skipped.map((item) => (
              <li key={item.key} className="break-words" data-archive-skipped-item={item.key}>
                {item.title} — {t.courseImport.types[item.type] ?? item.type} · {t.courseImport.skippedReason[item.reason] ?? item.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-slate-700">{c.allImportable}</p>
      )}
      {preview.requiresDueDate ? <p className="text-sm text-slate-700">{c.dueDateNote}</p> : null}
    </Card>
  );
}

function DocumentsCard({ preview }: { preview: Preview }) {
  const { t } = useLocale();
  const c = t.courseImport.archive;
  const format = useFormat();
  const byFormat = preview.documentsByFormat;
  return (
    <Card as="section" aria-labelledby="archive-documents-heading" className="space-y-3" data-archive-documents>
      <h3 id="archive-documents-heading" className="text-lg font-semibold text-brand-600">
        {c.documentsHeading}
      </h3>
      <p className="flex flex-wrap gap-2" data-archive-formats>
        {(['pdf', 'docx', 'pptx'] as const).map((key) => (
          <Badge key={key}>
            <span data-archive-format={key}>
              {c.formats[key]}: {format.number(byFormat[key])}
            </span>
          </Badge>
        ))}
      </p>
      {preview.documents.length ? (
        <>
          <p className="text-sm text-slate-600">{c.documentsIntro}</p>
          <div className={tableClasses.wrapper}>
            <table className={tableClasses.table}>
              <thead className={tableClasses.head}>
                <tr>
                  <th scope="col" className={tableClasses.th}>
                    {c.columns.file}
                  </th>
                  <th scope="col" className={tableClasses.th}>
                    {c.columns.type}
                  </th>
                  <th scope="col" className={tableClasses.th}>
                    {c.columns.size}
                  </th>
                  <th scope="col" className={tableClasses.th}>
                    {c.columns.usedBy}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {preview.documents.map((document) => (
                  <tr key={document.key} className={tableClasses.row} data-archive-document={document.key}>
                    <th scope="row" className={`${tableClasses.td} font-medium break-all text-slate-900`}>
                      {document.fileName}
                    </th>
                    <td className={tableClasses.td}>{c.formats[document.format] ?? document.format}</td>
                    <td className={`${tableClasses.td} whitespace-nowrap`}>{format.size(document.byteSize)}</td>
                    <td className={`${tableClasses.td} whitespace-nowrap`}>{c.usedBy(document.activityKeys.length)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="text-sm text-slate-600">{c.documentsEmpty}</p>
      )}
    </Card>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  const { t } = useLocale();
  const c = t.courseImport.archive;
  // Described by its stable code in the interface language; the API's English text only for a code this page does not know.
  const text = (t.courseImport.archiveIssues as Record<string, string>)[issue.code] ?? issue.message;
  const isError = issue.severity === 'error';
  return (
    <li className={`rounded-lg border px-4 py-3 ${isError ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`} data-archive-issue={issue.code} data-archive-severity={issue.severity}>
      <p className="text-sm text-slate-900">
        <span className={`mr-2 inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${isError ? 'bg-red-700 text-white' : 'bg-amber-200 text-amber-900'}`}>{isError ? c.error : c.warning}</span>
        {text}
      </p>
      {issue.path ? <p className="mt-1 text-xs break-all text-slate-700">{c.where(issue.path)}</p> : null}
    </li>
  );
}
