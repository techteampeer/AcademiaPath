'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { api, loadAll } from '@/lib/api/endpoints';
import type { CourseImportPreview, CourseImportResult, Program, Term } from '@/lib/api/types';

/** Largest course package (the API refuses larger bodies too). */
const MAX_BYTES = 20 * 1024 * 1024;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/**
 * AP-038B: import an AcademiaPath course package as a new draft course (administrators). The file is read and parsed in
 * the browser, then validated by the API (preview: nothing is written) before the administrator chooses the program,
 * term and code and confirms. The API checks everything again on confirmation.
 */
export function CourseImport() {
  return <RequireAuth role="administrator">{() => <ImportContent />}</RequireAuth>;
}

type Loaded = { pkg: unknown; fileName: string; preview: CourseImportPreview };

function ImportContent() {
  const { t } = useLocale();
  const c = t.courseImport;
  const check = useCsrfAction();
  const submit = useCsrfAction();
  const fileInput = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [done, setDone] = useState<CourseImportResult | null>(null);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [form, setForm] = useState({ programId: '', termId: '', code: '', title: '', versionPreference: 'approved' as 'approved' | 'working', dueAt: '', acknowledge: false });
  const [errors, setErrors] = useState<Partial<Record<'programId' | 'termId' | 'code' | 'title' | 'dueAt' | 'acknowledge', string>>>({});

  useEffect(() => {
    void loadAll((page) => api.listPrograms(page)).then((items) => setPrograms(items.filter((program) => program.isActive)), () => setPrograms([]));
    void loadAll((page) => api.listTerms(page)).then(setTerms, () => setTerms([]));
  }, []);

  const reset = () => {
    setLoaded(null);
    setDone(null);
    setFileError(null);
    setErrors({});
    setForm({ programId: '', termId: '', code: '', title: '', versionPreference: 'approved', dueAt: '', acknowledge: false });
    check.clearResult();
    submit.clearResult();
    if (fileInput.current) fileInput.current.value = '';
  };

  const choose = async (file: File | undefined) => {
    setLoaded(null);
    setFileError(null);
    check.clearResult();
    submit.clearResult();
    if (!file) return;
    if (file.size > MAX_BYTES) return setFileError(c.tooLarge);
    let pkg: unknown;
    try {
      pkg = JSON.parse(await file.text());
    } catch (error) {
      return setFileError(error instanceof SyntaxError ? c.notJson : c.readFailed);
    }
    const preview = await check.run((csrf) => api.previewCourseImport(pkg, csrf));
    if (!preview) return;
    setLoaded({ pkg, fileName: file.name, preview });
    setForm((current) => ({ ...current, title: preview.source.title ?? current.title }));
  };

  const chooseTerm = (termId: string) => {
    const term = terms.find((item) => item.id === termId);
    // Suggest the end of the chosen term as the assignments' due date (always editable).
    setForm((current) => ({ ...current, termId, dueAt: current.dueAt || (term ? `${term.endsOn}T23:59` : '') }));
  };

  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!loaded) return;
    const { preview } = loaded;
    const found: typeof errors = {};
    if (!form.programId) found.programId = c.required.program;
    if (!form.termId) found.termId = c.required.term;
    if (!CODE_PATTERN.test(form.code.trim())) found.code = c.required.code;
    if (!form.title.trim()) found.title = c.required.title;
    if (preview.requiresDueDate && (!form.dueAt || Number.isNaN(Date.parse(form.dueAt)))) found.dueAt = c.required.dueDate;
    if (preview.requiresAcknowledgement && !form.acknowledge) found.acknowledge = c.required.acknowledge;
    setErrors(found);
    if (Object.keys(found).length) return;
    const result = await submit.run((csrf) =>
      api.importCourse(
        {
          package: loaded.pkg as never,
          programId: form.programId,
          termId: form.termId,
          code: form.code.trim(),
          title: form.title.trim(),
          versionPreference: form.versionPreference,
          acknowledgeSkipped: form.acknowledge,
          ...(preview.requiresDueDate ? { assignmentDueAt: new Date(form.dueAt).toISOString() } : {}),
        },
        csrf,
      ),
    );
    if (result) setDone(result);
  };

  const header = (
    <PageHeader
      breadcrumbs={[{ label: t.nav.adminOverview, href: '/admin' }, { label: t.admin.coursesTitle, href: '/admin/courses' }, { label: c.title }]}
      breadcrumbLabel={t.common.breadcrumb}
      title={c.title}
      description={c.intro}
    />
  );

  if (done) {
    return (
      <div className="space-y-6">
        {header}
        <Card as="section" aria-labelledby="import-done-heading" className="space-y-4" data-import-result={done.course.code}>
          <h2 id="import-done-heading" className="text-lg font-semibold text-brand-600">
            {c.successTitle}
          </h2>
          <Alert tone="success">{c.success(done.course.code)}</Alert>
          <p className="text-sm text-slate-700">{c.created(done.created.units, done.created.activities, done.created.questions)}</p>
          {done.skipped.length ? (
            <div className="text-sm text-slate-700">
              <p>{c.skippedSummary(done.skipped.length)}</p>
              <ul className="mt-1 list-disc pl-5">
                {done.skipped.map((item) => (
                  <li key={item.key} className="break-words">
                    {item.title} — {c.skippedReason[item.reason]}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-sm text-slate-600">{c.nextSteps}</p>
          <div className="flex flex-wrap gap-2">
            <Link href={`/courses/${done.course.id}`} className={buttonClasses()}>
              {c.openCourse}
            </Link>
            <Button variant="secondary" onClick={reset}>
              {c.importAnother}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const preview = loaded?.preview ?? null;
  return (
    <div className="space-y-6">
      {header}
      <Card as="section" aria-labelledby="import-file-heading" className="space-y-3">
        <h2 id="import-file-heading" className="text-lg font-semibold text-brand-600">
          {c.step1}
        </h2>
        <div>
          <label htmlFor="import-file" className="block text-sm font-medium text-slate-800">
            {c.fileLabel}
          </label>
          <input
            ref={fileInput}
            id="import-file"
            type="file"
            accept=".json,application/json"
            aria-describedby="import-file-hint"
            className="mt-1 block w-full max-w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border file:border-brand-600/35 file:bg-white file:px-3 file:py-1.5 file:text-brand-700"
            disabled={check.pending || submit.pending}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
          <p id="import-file-hint" className="mt-1 text-xs text-slate-500">
            {c.fileHint}
          </p>
        </div>
        {check.pending ? <p className="text-sm text-slate-600">{c.checking}</p> : null}
        {fileError ? <Alert tone="error">{fileError}</Alert> : null}
        {check.result?.tone === 'error' ? <Alert tone="error">{check.result.message}</Alert> : null}
      </Card>

      {preview ? <PreviewCard preview={preview} /> : null}

      {preview?.valid ? (
        <Card as="section" aria-labelledby="import-confirm-heading" className="space-y-4">
          <h2 id="import-confirm-heading" className="text-lg font-semibold text-brand-600">
            {c.step3}
          </h2>
          <form noValidate onSubmit={(event) => void confirm(event)} className="space-y-4" data-import-form>
            <div className="grid gap-4 md:grid-cols-2">
              <SelectField
                id="import-program"
                label={c.program}
                value={form.programId}
                error={errors.programId}
                onChange={(event) => setForm({ ...form, programId: event.target.value })}
                options={[{ value: '', label: c.choose }, ...programs.map((program) => ({ value: program.id, label: `${program.code} · ${program.name}` }))]}
              />
              <SelectField
                id="import-term"
                label={c.term}
                value={form.termId}
                error={errors.termId}
                onChange={(event) => chooseTerm(event.target.value)}
                options={[{ value: '', label: c.choose }, ...terms.map((term) => ({ value: term.id, label: `${term.code} · ${term.name}` }))]}
              />
              <TextField id="import-code" label={c.code} hint={c.codeHint} value={form.code} maxLength={32} autoComplete="off" error={errors.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
              <TextField id="import-title" label={c.courseTitle} value={form.title} maxLength={200} error={errors.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-slate-800">{c.contentVersion}</legend>
              {(['approved', 'working'] as const).map((value) => (
                <label key={value} className="flex items-start gap-2 text-sm text-slate-700">
                  <input type="radio" name="import-version" className="mt-0.5 h-4 w-4 shrink-0" checked={form.versionPreference === value} onChange={() => setForm({ ...form, versionPreference: value })} />
                  {value === 'approved' ? c.approvedVersion : c.workingVersion}
                </label>
              ))}
            </fieldset>
            {preview.requiresDueDate ? (
              <TextField id="import-due" type="datetime-local" label={c.dueDate} hint={c.dueDateHint} value={form.dueAt} error={errors.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} className="max-w-sm" />
            ) : null}
            {preview.requiresAcknowledgement ? (
              <div>
                <label className="flex items-start gap-2 text-sm text-slate-800">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300" checked={form.acknowledge} aria-describedby={errors.acknowledge ? 'import-ack-error' : undefined} onChange={(event) => setForm({ ...form, acknowledge: event.target.checked })} />
                  {c.acknowledge(preview.skipped.length)}
                </label>
                {errors.acknowledge ? (
                  <p id="import-ack-error" className="mt-1 text-sm text-red-700">
                    {errors.acknowledge}
                  </p>
                ) : null}
              </div>
            ) : null}
            <Alert tone="info">{c.draftNotice}</Alert>
            {submit.result?.tone === 'error' ? <Alert tone="error">{submit.result.message}</Alert> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={submit.pending}>
                {submit.pending ? c.importing : c.confirm}
              </Button>
              <Button variant="secondary" onClick={reset} disabled={submit.pending}>
                {c.chooseAnother}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

function PreviewCard({ preview }: { preview: CourseImportPreview }) {
  const { t } = useLocale();
  const c = t.courseImport;
  return (
    <Card as="section" aria-labelledby="import-preview-heading" className="space-y-4" data-import-preview data-import-valid={String(preview.valid)}>
      <h2 id="import-preview-heading" className="text-lg font-semibold text-brand-600">
        {c.step2}
      </h2>
      <Alert tone={preview.valid ? 'success' : 'error'}>{preview.valid ? c.validTitle : c.invalidTitle}</Alert>
      {preview.source.title ? (
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">{c.sourceCourse}</p>
          <p className="font-semibold break-words text-slate-900">{preview.source.title}</p>
          {preview.source.description ? <p className="mt-1 text-sm break-words text-slate-700">{preview.source.description}</p> : null}
          <p className="mt-1 text-sm text-slate-600">
            {preview.formatVersion ? c.format(preview.formatVersion) : null}
            {preview.source.courseCode ? ` · ${c.sourceCode(preview.source.courseCode)}` : null}
          </p>
          <p className="mt-1 text-sm text-slate-600">{preview.hashVerified ? c.hashVerified : c.hashFailed}</p>
        </div>
      ) : null}
      {preview.counts.units || preview.counts.activities ? (
        <div className="space-y-2">
          <p className="flex flex-wrap gap-2" data-import-counts>
            <Badge>{c.counts.units(preview.counts.units)}</Badge>
            <Badge>{c.counts.folders(preview.counts.folders)}</Badge>
            <Badge>{c.counts.activities(preview.counts.activities)}</Badge>
            <Badge>{c.counts.questions(preview.counts.questions)}</Badge>
          </p>
          <div>
            <p className="text-sm font-medium text-slate-800">{c.byType}</p>
            <ul className="mt-1 grid gap-1 text-sm text-slate-700 sm:grid-cols-2">
              {Object.entries(preview.counts.activitiesByType).map(([type, n]) => (
                <li key={type} data-import-type={type}>
                  {c.types[type] ?? type}: {n}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      {preview.documents.length ? (
        <div className="space-y-1" data-import-documents>
          <h3 className="font-semibold text-slate-900">{c.documentsTitle}</h3>
          <p className="text-sm text-slate-600">{c.documentsIntro}</p>
          <ul className="space-y-1 text-sm">
            {preview.documents.map((document) => (
              <li key={document.assetKey} className="flex flex-wrap items-center gap-2 break-all">
                <span className="text-slate-800">{document.fileName}</span>
                <Badge tone="warning">{document.availability === 'missing_at_source' ? c.missingAtSource : c.notBundled}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.skipped.length ? (
        <div className="space-y-1" data-import-skipped>
          <h3 className="font-semibold text-slate-900">{c.skippedTitle}</h3>
          <ul className="list-disc pl-5 text-sm text-slate-700">
            {preview.skipped.map((item) => (
              <li key={item.key} className="break-words">
                {item.title} — {c.skippedReason[item.reason]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.unsupportedFieldCount ? (
        <div className="space-y-1" data-import-unsupported>
          <h3 className="font-semibold text-slate-900">{c.unsupportedTitle}</h3>
          <p className="text-sm text-slate-600">{c.unsupportedIntro(preview.unsupportedFieldCount)}</p>
          <ul className="list-disc pl-5 font-mono text-xs break-all text-slate-700">
            {preview.unsupportedFields.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.errors.length ? (
        <div className="space-y-1" data-import-errors>
          <h3 className="font-semibold text-red-800">{c.errorsTitle}</h3>
          <ul className="list-disc pl-5 text-sm text-red-800">
            {preview.errors.map((issue, index) => (
              <li key={`${issue.path}-${index}`} className="break-words" data-import-error={issue.code}>
                <span className="font-mono text-xs break-all">{issue.path}</span> — {issue.message}
              </li>
            ))}
          </ul>
          {preview.errorCount > preview.errors.length ? <p className="text-sm text-red-800">{c.errorsMore(preview.errors.length, preview.errorCount)}</p> : null}
        </div>
      ) : null}
    </Card>
  );
}
