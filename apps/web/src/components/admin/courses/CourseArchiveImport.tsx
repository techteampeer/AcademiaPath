'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useLocalizedState } from '@/components/i18n/useLocalizedState';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SelectField, TextField } from '@/components/ui/Field';
import { isApiError } from '@/lib/api/client';
import { api, loadAll } from '@/lib/api/endpoints';
import type { CourseArchiveImportResult, CourseArchivePreviewReport, Program, Term } from '@/lib/api/types';
import type { Messages } from '@/lib/i18n/messages';

type Preview = NonNullable<CourseArchivePreviewReport['preview']>;
type Availability = 'checking' | 'available' | 'unavailable' | 'failed';
type Step = 'form' | 'review';
type FieldErrors = Partial<Record<'programId' | 'termId' | 'code' | 'title' | 'dueAt' | 'acknowledge' | 'confirmNew', string>>;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/**
 * AP-038C2F: the confirmation step of the archive preview. Shown only when the server accepts archive imports
 * (`ARCHIVE_IMPORT_ENABLED`, off by default and refused in production): otherwise it explains that import is not
 * available and offers no action. The administrator chooses the destination, reviews it, and only an explicit
 * confirmation sends the checked file with the API's own fields; the server validates the archive again. Success is
 * shown only for a real 201, with a link to the new draft course.
 */
export function ArchiveImport({ preview, file, onImported, onAnother }: { preview: Preview; file: File | null; onImported: () => void; onAnother: () => void }) {
  const { getCsrfToken, handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const c = t.courseImport;
  const a = c.archive.import;
  const [availability, setAvailability] = useState<Availability>('checking');
  const [programs, setPrograms] = useState<Program[] | null>(null);
  const [terms, setTerms] = useState<Term[] | null>(null);
  const [step, setStep] = useState<Step>('form');
  const [form, setForm] = useState({
    programId: '',
    termId: '',
    code: '',
    title: preview.title ?? '',
    versionPreference: 'approved' as 'approved' | 'working',
    dueAt: '',
    acknowledge: false,
    confirmNew: false,
  });
  const [errors, setErrors] = useLocalizedState<FieldErrors>({});
  const [failure, setFailure] = useLocalizedState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<CourseArchiveImportResult | null>(null);
  // Guards a second click before the button re-renders as disabled: one confirmation sends one request.
  const submitting = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const doneHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    api
      .getCourseArchiveImportAvailability()
      .then((result) => active && setAvailability(result.enabled ? 'available' : 'unavailable'))
      .catch((error: unknown) => {
        if (isApiError(error, 401)) handleUnauthorized();
        if (active) setAvailability('failed');
      });
    return () => {
      active = false;
    };
  }, [handleUnauthorized]);

  useEffect(() => {
    if (availability !== 'available') return;
    void loadAll((page) => api.listPrograms(page)).then(
      (items) => setPrograms(items.filter((program) => program.isActive)),
      () => setPrograms([]),
    );
    void loadAll((page) => api.listTerms(page)).then(setTerms, () => setTerms([]));
  }, [availability]);

  useEffect(() => {
    if (step === 'review') reviewHeading.current?.focus();
  }, [step]);
  useEffect(() => {
    if (done) doneHeading.current?.focus();
  }, [done]);

  const program = programs?.find((item) => item.id === form.programId);
  const term = terms?.find((item) => item.id === form.termId);
  const header = (
    <h2 id="archive-import-heading" className="text-lg font-semibold text-brand-600">
      {a.heading}
    </h2>
  );

  if (done) {
    return (
      <Card as="section" aria-labelledby="archive-import-done-heading" className="space-y-4" data-archive-import="done" data-archive-import-result={done.course.code}>
        <h2 id="archive-import-done-heading" ref={doneHeading} tabIndex={-1} className="text-lg font-semibold text-brand-600">
          {c.successTitle}
        </h2>
        <Alert tone="success">{c.success(done.course.code)}</Alert>
        <p className="text-sm text-slate-700">{c.created(done.created.units, done.created.activities, done.created.questions)}</p>
        <p className="text-sm text-slate-700">{a.documentsCreated(done.created.documents)}</p>
        {done.skipped.length ? <p className="text-sm text-slate-700">{a.notImportedSummary(done.skipped.length)}</p> : null}
        <p className="text-sm text-slate-600">{c.nextSteps}</p>
        <div className="flex flex-wrap gap-2">
          <Link href={`/courses/${done.course.id}`} className={buttonClasses()} data-archive-import-open>
            {c.openCourse}
          </Link>
          <Button variant="secondary" onClick={onAnother}>
            {a.another}
          </Button>
        </div>
      </Card>
    );
  }

  if (availability !== 'available' || !file) {
    const message = availability === 'checking' ? a.checking : availability === 'failed' ? a.availabilityFailed : a.unavailable;
    return (
      <Card as="section" aria-labelledby="archive-import-heading" className="space-y-3" data-archive-import={availability === 'checking' ? 'checking' : 'unavailable'}>
        {header}
        {availability === 'checking' ? (
          <p role="status" className="text-sm text-slate-600">
            {message}
          </p>
        ) : (
          <Alert tone="info">
            <span data-archive-import-unavailable>{message}</span>
          </Alert>
        )}
      </Card>
    );
  }

  /** Built with the catalog shown at render, so the messages follow the EN/ES switch (AP-I18N-01). */
  const validation = (m: Messages): FieldErrors => {
    const r = m.courseImport.required;
    const found: FieldErrors = {};
    if (!form.programId) found.programId = r.program;
    if (!form.termId) found.termId = r.term;
    if (!CODE_PATTERN.test(form.code.trim())) found.code = r.code;
    if (!form.title.trim()) found.title = r.title;
    if (preview.requiresDueDate && (!form.dueAt || Number.isNaN(Date.parse(form.dueAt)))) found.dueAt = r.dueDate;
    if (preview.skipped.length && !form.acknowledge) found.acknowledge = r.acknowledge;
    if (!form.confirmNew) found.confirmNew = m.courseImport.archive.import.required.confirmNew;
    return found;
  };

  const review = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    const found = validation(t);
    setErrors(validation);
    if (Object.keys(found).length) return;
    setStep('review');
  };

  const confirm = async () => {
    if (submitting.current || !file) return;
    submitting.current = true;
    setPending(true);
    setFailure(null);
    try {
      const result = await api.importCourseArchive(
        file,
        {
          programId: form.programId,
          termId: form.termId,
          code: form.code.trim(),
          title: form.title.trim(),
          versionPreference: form.versionPreference,
          acknowledgeSkipped: preview.skipped.length ? 'true' : 'false',
          ...(preview.requiresDueDate ? { assignmentDueAt: new Date(form.dueAt).toISOString() } : {}),
        },
        await getCsrfToken(),
      );
      setDone(result);
      onImported();
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      if (isApiError(error, 409)) {
        setStep('form');
        setErrors((m) => ({ code: m.courseImport.archive.import.codeTaken }));
      } else if (isApiError(error, 403) && error.code === 'ARCHIVE_IMPORT_DISABLED') {
        setAvailability('unavailable');
      } else {
        setFailure((m, ml) => (isApiError(error, 413) ? m.courseImport.archive.tooLarge : isApiError(error, 429) ? m.courseImport.archive.import.rateLimited : describeApiError(error, ml)));
      }
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  if (step === 'review') {
    const due = preview.requiresDueDate && form.dueAt ? new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(form.dueAt)) : null;
    const rows: Array<[string, string, string]> = [
      ['program', c.program, program ? `${program.code} · ${program.name}` : ''],
      ['term', c.term, term ? `${term.code} · ${term.name}` : ''],
      ['code', c.code, form.code.trim()],
      ['title', c.courseTitle, form.title.trim()],
      ['version', c.contentVersion, form.versionPreference === 'approved' ? c.approvedVersion : c.workingVersion],
    ];
    return (
      <Card as="section" aria-labelledby="archive-import-review-heading" className="space-y-4" data-archive-import="review">
        <h2 id="archive-import-review-heading" ref={reviewHeading} tabIndex={-1} className="text-lg font-semibold text-brand-600">
          {a.reviewHeading}
        </h2>
        <p className="text-sm text-slate-700">{a.reviewIntro}</p>
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{a.destination}</h3>
          <dl className="mt-2 grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {rows.map(([key, label, value]) => (
              <div key={key} className="min-w-0">
                <dt className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{label}</dt>
                <dd className="mt-1 text-sm break-words text-slate-900" data-archive-import-field={key}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{a.content}</h3>
          <p className="mt-1 text-sm text-slate-700" data-archive-import-content>
            {a.contentSummary(preview.counts.units, preview.counts.activities, preview.documents.length)}
          </p>
          {preview.skipped.length ? <p className="mt-1 text-sm text-slate-700">{a.notImportedSummary(preview.skipped.length)}</p> : null}
          {due ? <p className="mt-1 text-sm text-slate-700">{a.dueDate(due)}</p> : null}
        </div>
        <Alert tone="info">{c.draftNotice}</Alert>
        {failure ? <Alert tone="error">{failure}</Alert> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void confirm()} disabled={pending} data-archive-import-confirm>
            {pending ? a.importing : a.confirm}
          </Button>
          <Button variant="secondary" onClick={() => setStep('form')} disabled={pending}>
            {a.back}
          </Button>
          {pending ? (
            <p role="status" className="text-sm text-slate-600">
              {a.importing}
            </p>
          ) : null}
        </div>
      </Card>
    );
  }

  const missing = programs !== null && terms !== null && (!programs.length || !terms.length);
  return (
    <Card as="section" aria-labelledby="archive-import-heading" className="space-y-4" data-archive-import="form">
      {header}
      <p className="text-sm text-slate-700">{a.intro}</p>
      {programs !== null && !programs.length ? <Alert tone="info">{a.noPrograms}</Alert> : null}
      {terms !== null && !terms.length ? <Alert tone="info">{a.noTerms}</Alert> : null}
      <form noValidate onSubmit={review} className="space-y-4" data-archive-import-form>
        <div className="grid gap-4 md:grid-cols-2">
          <SelectField
            id="archive-import-program"
            label={c.program}
            value={form.programId}
            error={errors.programId}
            onChange={(event) => setForm({ ...form, programId: event.target.value })}
            options={[{ value: '', label: c.choose }, ...(programs ?? []).map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` }))]}
          />
          <SelectField
            id="archive-import-term"
            label={c.term}
            value={form.termId}
            error={errors.termId}
            onChange={(event) => {
              const chosen = terms?.find((item) => item.id === event.target.value);
              // Suggest the end of the chosen term as the assignments' due date (always editable).
              setForm({ ...form, termId: event.target.value, dueAt: form.dueAt || (chosen ? `${chosen.endsOn}T23:59` : '') });
            }}
            options={[{ value: '', label: c.choose }, ...(terms ?? []).map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` }))]}
          />
          <TextField
            id="archive-import-code"
            label={c.code}
            hint={c.codeHint}
            value={form.code}
            maxLength={32}
            autoComplete="off"
            error={errors.code}
            onChange={(event) => setForm({ ...form, code: event.target.value })}
          />
          <TextField id="archive-import-title" label={c.courseTitle} value={form.title} maxLength={200} error={errors.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-800">{c.contentVersion}</legend>
          {(['approved', 'working'] as const).map((value) => (
            <label key={value} className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="radio"
                name="archive-import-version"
                className="mt-0.5 h-4 w-4 shrink-0"
                checked={form.versionPreference === value}
                onChange={() => setForm({ ...form, versionPreference: value })}
              />
              {value === 'approved' ? c.approvedVersion : c.workingVersion}
            </label>
          ))}
        </fieldset>
        {preview.requiresDueDate ? (
          <TextField
            id="archive-import-due"
            type="datetime-local"
            label={c.dueDate}
            hint={c.dueDateHint}
            value={form.dueAt}
            error={errors.dueAt}
            onChange={(event) => setForm({ ...form, dueAt: event.target.value })}
            className="max-w-sm"
          />
        ) : null}
        {preview.skipped.length ? (
          <Checkbox id="archive-import-acknowledge" checked={form.acknowledge} error={errors.acknowledge} onChange={(checked) => setForm({ ...form, acknowledge: checked })}>
            {c.acknowledge(preview.skipped.length)}
          </Checkbox>
        ) : null}
        <Checkbox id="archive-import-confirm-new" checked={form.confirmNew} error={errors.confirmNew} onChange={(checked) => setForm({ ...form, confirmNew: checked })}>
          {a.confirmNew}
        </Checkbox>
        {failure ? <Alert tone="error">{failure}</Alert> : null}
        <Button type="submit" disabled={missing || programs === null || terms === null}>
          {a.review}
        </Button>
      </form>
    </Card>
  );
}

function Checkbox({ id, checked, error, onChange, children }: { id: string; checked: boolean; error?: string; onChange: (checked: boolean) => void; children: string }) {
  return (
    <div>
      <label htmlFor={id} className="flex items-start gap-2 text-sm text-slate-800">
        <input
          id={id}
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300"
          checked={checked}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        {children}
      </label>
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
