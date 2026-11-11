'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { LocalizedCourseStatusBadge as CourseStatusBadge } from '@/components/courses/LocalizedCourseStatusBadge';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SelectField, TextField } from '@/components/ui/Field';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Course, CourseTemplate, CourseTemplateDetail, Program, Term } from '@/lib/api/types';
import { formatDate, type Messages } from '@/lib/i18n/messages';
import { ProgramManagersPanel } from './ProgramManagers';

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PERIOD_VALUES = ['1', '2', '0'] as const;
const periodOptions = (t: Messages) => {
  const p = t.setup.hierarchy.periods;
  return [
    { value: '1', label: p.first },
    { value: '2', label: p.second },
    { value: '0', label: p.summer },
  ];
};
type Errors = Record<string, string>;

function codeError(code: string, t: Messages): string | undefined {
  const value = code.trim();
  if (!value) return t.errors.enterCode;
  if (value.length > 32 || !CODE_PATTERN.test(value)) return t.errors.codeFormat;
  return undefined;
}

/** `missing` is the localized "enter a name/title" message. */
function textError(value: string, missing: string, t: Messages, max = 200): string | undefined {
  if (!value.trim()) return missing;
  if (value.length > max) return t.errors.maxChars(max);
  return undefined;
}

function datesError(startsOn: string, endsOn: string, t: Messages): Errors {
  const errors: Errors = {};
  if (!startsOn) errors.startsOn = t.setup.dates.chooseStart;
  if (!endsOn) errors.endsOn = t.setup.dates.chooseEnd;
  else if (startsOn && endsOn < startsOn) errors.endsOn = t.setup.dates.endBeforeStart;
  return errors;
}
const sectionLines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

function Textarea({ id, label, value, onChange, hint, error, rows = 3 }: { id: string; label: string; value: string; onChange: (value: string) => void; hint?: string; error?: string; rows?: number }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined}
        className={`mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ${error ? 'border-red-500' : 'border-slate-300'}`}
      />
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PanelHeader({ kicker, title, meta, badge }: { kicker: string; title: string; meta?: string; badge?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{kicker}</p>
        <h2 className="mt-1 text-xl font-semibold break-words text-brand-600">{title}</h2>
        {meta ? <p className="text-sm text-slate-500">{meta}</p> : null}
      </div>
      {badge}
    </div>
  );
}

// ---------------------------------------------------------------- Academic year

export function YearPanel({ year, terms, onSelectTerm, onCreated }: { year: number; terms: Term[]; onSelectTerm: (id: string) => void; onCreated: (term: Term) => Promise<void> }) {
  const { t, locale } = useLocale();
  const h = t.setup.hierarchy;
  const f = t.setup.fields;
  const free = PERIOD_VALUES.filter((period) => !terms.some((term) => term.code === `${year}-${period}`));
  const [period, setPeriod] = useState<string>(free[0] ?? '1');
  const [name, setName] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const { run, pending, result } = useCsrfAction();
  const code = `${year}-${period}`;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = datesError(startsOn, endsOn, t);
    if (name.length > 200) next.name = t.errors.maxChars(200);
    setErrors(next);
    if (Object.keys(next).length) return;
    const created = await run(
      (csrf) => api.createTerm({ code, name: name.trim() || (period === '0' ? `Verano ${code}` : `Semestre ${code}`), academicYear: year, startsOn, endsOn }, csrf),
      (term) => h.termCreated(term.code),
    );
    if (created) await onCreated(created);
  };

  return (
    <Card as="section" aria-labelledby="panel-heading" className="space-y-6">
      <div id="panel-heading">
        <PanelHeader kicker={h.yearKicker} title={String(year)} meta={t.admin.termCount(terms.length)} />
      </div>
      {terms.length ? (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {terms.map((term) => (
            <li key={term.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div>
                <button type="button" onClick={() => onSelectTerm(term.id)} className="font-medium text-brand-700 hover:underline">
                  {term.code}
                </button>
                <span className="ml-2 text-sm text-slate-600">{term.name}</span>
              </div>
              <span className="text-xs text-slate-500">
                {formatDate(term.startsOn, locale)} – {formatDate(term.endsOn, locale)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">
          {h.noTermsInYear(year)}
        </p>
      )}
      <form noValidate onSubmit={submit} className="space-y-4 border-t border-slate-200 pt-4" aria-labelledby="new-term-heading">
        <h3 id="new-term-heading" className="font-semibold text-slate-900">
          {h.newTermIn(year)}
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField id="term-period" label={h.period} value={period} onChange={(event) => setPeriod(event.target.value)} options={periodOptions(t)} hint={h.termCode(code)} />
          <TextField id="term-name" label={f.nameOptional} value={name} onChange={(e) => setName(e.target.value)} placeholder={period === '0' ? `Verano ${code}` : `Semestre ${code}`} error={errors.name} />
          <TextField id="term-starts" label={f.startsOn} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} error={errors.startsOn} />
          <TextField id="term-ends" label={f.endsOn} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} error={errors.endsOn} />
        </div>
        {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
        <Button type="submit" disabled={pending}>
          {pending ? f.saving : h.createTermCode(code)}
        </Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- Term

export function TermPanel({
  term,
  programs,
  programCounts,
  offeringCount,
  onChanged,
  onSelectProgram,
}: {
  term: Term;
  programs: Program[];
  programCounts: Map<string, number>;
  offeringCount: number | null;
  onChanged: () => Promise<void>;
  onSelectProgram: (id: string) => void;
}) {
  const [name, setName] = useState(term.name);
  const [startsOn, setStartsOn] = useState(term.startsOn);
  const [endsOn, setEndsOn] = useState(term.endsOn);
  const [errors, setErrors] = useState<Errors>({});
  const edit = useCsrfAction();
  const { t } = useLocale();
  const h = t.setup.hierarchy;
  const f = t.setup.fields;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = datesError(startsOn, endsOn, t);
    const nameError = textError(name, t.errors.enterName, t);
    if (nameError) next.name = nameError;
    setErrors(next);
    if (Object.keys(next).length) return;
    const saved = await edit.run((csrf) => api.updateTerm(term.id, { name: name.trim(), startsOn, endsOn }, csrf), (saved) => h.termSaved(saved.code));
    if (saved) await onChanged();
  };

  return (
    <div className="space-y-6">
      <Card as="section" aria-labelledby="panel-heading" className="space-y-4">
        <div id="panel-heading">
          <PanelHeader
            kicker={h.termKicker(term.academicYear)}
            title={term.code}
            meta={term.name}
            badge={<Badge tone="brand">{offeringCount === null ? '…' : h.offerings(offeringCount)}</Badge>}
          />
        </div>
        <form noValidate onSubmit={save} className="space-y-4" aria-label={h.editTerm}>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField id="edit-term-name" label={f.name} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} className="sm:col-span-3" />
            <TextField id="edit-term-starts" label={f.startsOn} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} error={errors.startsOn} />
            <TextField id="edit-term-ends" label={f.endsOn} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} error={errors.endsOn} />
          </div>
          <p className="text-xs text-slate-500">{h.termFixed}</p>
          {edit.result ? <Alert tone={edit.result.tone}>{edit.result.message}</Alert> : null}
          <Button type="submit" variant="secondary" disabled={edit.pending}>
            {edit.pending ? f.saving : h.saveTerm}
          </Button>
        </form>
      </Card>

      <Card as="section" aria-labelledby="programs-heading" className="space-y-4">
        <h3 id="programs-heading" className="text-lg font-semibold text-slate-900">
          {h.programs}
        </h3>
        <p className="text-sm text-slate-600">{h.programsNote(term.code)}</p>
        {programs.length ? (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {programs.map((program) => (
              <li key={program.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div>
                  <button type="button" onClick={() => onSelectProgram(program.id)} className="font-medium text-brand-700 hover:underline">
                    {program.name}
                  </button>
                  <span className="ml-2 text-xs text-slate-500">{program.code}</span>
                </div>
                <div className="flex items-center gap-2">
                  {program.isActive ? null : <Badge tone="warning">{h.inactive}</Badge>}
                  <span className="text-xs text-slate-600">{h.inThisTerm(programCounts.get(program.id) ?? 0)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">{h.noPrograms}</p>
        )}
        <NewProgramForm onCreated={onChanged} />
      </Card>
    </div>
  );
}

function NewProgramForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const { run, pending, result } = useCsrfAction();
  const { t } = useLocale();
  const h = t.setup.hierarchy;
  const f = t.setup.fields;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    const c = codeError(code, t);
    const n = textError(name, t.errors.enterName, t);
    if (c) next.code = c;
    if (n) next.name = n;
    if (description.length > 2000) next.description = t.errors.maxChars(2000);
    setErrors(next);
    if (Object.keys(next).length) return;
    const created = await run(
      (csrf) => api.createProgram({ code: code.trim(), name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }, csrf),
      (p) => h.programCreated(p.name),
    );
    if (created) {
      setCode('');
      setName('');
      setDescription('');
      await onCreated();
    }
  };
  return (
    <form noValidate onSubmit={submit} className="space-y-4 border-t border-slate-200 pt-4" aria-labelledby="new-program-heading">
      <h4 id="new-program-heading" className="font-semibold text-slate-900">
        {h.newProgram}
      </h4>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id="program-code" label={f.code} value={code} onChange={(e) => setCode(e.target.value)} error={errors.code} placeholder="IT-MGMT" />
        <TextField id="program-name" label={f.name} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} placeholder={h.programNamePlaceholder} />
      </div>
      <Textarea id="program-description" label={f.descriptionOptional} value={description} onChange={setDescription} error={errors.description} rows={2} />
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? f.saving : h.createProgram}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------- Program

export function ProgramPanel({
  program,
  term,
  subjects,
  subjectCounts,
  onChanged,
  onSelectSubject,
}: {
  program: Program;
  term: Term;
  subjects: CourseTemplate[];
  subjectCounts: Map<string, number>;
  onChanged: () => Promise<void>;
  onSelectSubject: (id: string) => void;
}) {
  const [name, setName] = useState(program.name);
  const [description, setDescription] = useState(program.description ?? '');
  const [isActive, setIsActive] = useState(program.isActive);
  const [errors, setErrors] = useState<Errors>({});
  const edit = useCsrfAction();
  const { t } = useLocale();
  const h = t.setup.hierarchy;
  const f = t.setup.fields;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    const n = textError(name, t.errors.enterName, t);
    if (n) next.name = n;
    if (description.length > 2000) next.description = t.errors.maxChars(2000);
    setErrors(next);
    if (Object.keys(next).length) return;
    const saved = await edit.run(
      (csrf) => api.updateProgram(program.id, { name: name.trim(), description: description.trim() || null, isActive }, csrf),
      (p) => h.programSaved(p.name),
    );
    if (saved) await onChanged();
  };

  return (
    <div className="space-y-6">
      <Card as="section" aria-labelledby="panel-heading" className="space-y-4">
        <div id="panel-heading">
          <PanelHeader
            kicker={h.programKicker(term.code)}
            title={program.name}
            meta={program.code}
            badge={program.isActive ? <Badge tone="success">{h.active}</Badge> : <Badge tone="warning">{h.inactive}</Badge>}
          />
        </div>
        <form noValidate onSubmit={save} className="space-y-4" aria-label={h.editProgram}>
          <TextField id="edit-program-name" label={f.name} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
          <Textarea id="edit-program-description" label={f.descriptionOptional} value={description} onChange={setDescription} error={errors.description} rows={2} />
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
            {h.activeLabel}
          </label>
          <p className="text-xs text-slate-500">{h.programFixed}</p>
          {edit.result ? <Alert tone={edit.result.tone}>{edit.result.message}</Alert> : null}
          <Button type="submit" variant="secondary" disabled={edit.pending}>
            {edit.pending ? f.saving : h.saveProgram}
          </Button>
        </form>
      </Card>

      <ProgramManagersPanel key={program.id} program={program} />

      <Card as="section" aria-labelledby="subjects-heading" className="space-y-4">
        <h3 id="subjects-heading" className="text-lg font-semibold text-slate-900">
          {h.subjects}
        </h3>
        <p className="text-sm text-slate-600">{h.subjectsNote(term.code)}</p>
        {subjects.length ? (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {subjects.map((subject) => (
              <li key={subject.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div>
                  <button type="button" onClick={() => onSelectSubject(subject.id)} className="font-medium text-brand-700 hover:underline">
                    {subject.title}
                  </button>
                  <span className="ml-2 text-xs text-slate-500">
                    {subject.code} · v{subject.latestVersion?.version ?? 0}
                  </span>
                </div>
                <span className="text-xs text-slate-600">{h.inThisTerm(subjectCounts.get(subject.id) ?? 0)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">{h.noSubjects}</p>
        )}
        <SubjectForm mode={{ kind: 'create', programId: program.id }} onSaved={onChanged} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Subject

export type SubjectFormMode = { kind: 'create'; programId: string } | { kind: 'edit'; detail: CourseTemplateDetail };

/** Create a subject or save a new version of one (also used by the Academic management workspace). */
export function SubjectForm({ mode, onSaved }: { mode: SubjectFormMode; onSaved: () => Promise<void> }) {
  const detail = mode.kind === 'edit' ? mode.detail : null;
  const [code, setCode] = useState(detail?.code ?? '');
  const [title, setTitle] = useState(detail?.latestVersion?.title ?? detail?.title ?? '');
  const [description, setDescription] = useState(detail?.latestVersion?.description ?? '');
  const [sections, setSections] = useState((detail?.latestVersion?.sections ?? []).map((s) => s.title).join('\n'));
  const [errors, setErrors] = useState<Errors>({});
  const { run, pending, result } = useCsrfAction();
  const { t } = useLocale();
  const h = t.setup.hierarchy;
  const f = t.setup.fields;
  const baseVersion = detail ? (detail.latestVersion?.version ?? 0) : 0;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    const c = detail ? undefined : codeError(code, t);
    const titleProblem = textError(title, t.errors.enterTitle, t);
    const lines = sectionLines(sections);
    if (c) next.code = c;
    if (titleProblem) next.title = titleProblem;
    if (description.length > 2000) next.description = t.errors.maxChars(2000);
    if (!lines.length) next.sections = h.sectionsRequired;
    else if (lines.length > 100 || lines.some((line) => line.length > 200)) next.sections = h.sectionsLimit;
    setErrors(next);
    if (Object.keys(next).length) return;
    const programId = detail ? detail.programId : mode.kind === 'create' ? mode.programId : null;
    // A new version keeps each existing section's visibility (matched by title); new sections are visible.
    const visibility = new Map((detail?.latestVersion?.sections ?? []).map((section) => [section.title, section.isVisible]));
    const saved = await run(
      (csrf) =>
        api.createCourseTemplate(
          {
            code: detail ? detail.code : code.trim(),
            programId,
            title: title.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
            baseVersion,
            sections: lines.map((line) => ({ title: line, isVisible: visibility.get(line) ?? true })),
          },
          csrf,
        ),
      (version) => (detail ? h.savedVersion(version.version) : h.subjectCreated(version.code)),
    );
    if (saved) {
      if (!detail) {
        setCode('');
        setTitle('');
        setDescription('');
        setSections('');
      }
      await onSaved();
    }
  };

  const idp = detail ? 'edit-subject' : 'subject';
  return (
    <form noValidate onSubmit={submit} className="space-y-4 border-t border-slate-200 pt-4" aria-labelledby={`${idp}-heading`}>
      <h4 id={`${idp}-heading`} className="font-semibold text-slate-900">
        {detail ? h.editSubject(baseVersion + 1) : h.newSubject}
      </h4>
      <div className="grid gap-4 sm:grid-cols-2">
        {detail ? null : <TextField id={`${idp}-code`} label={f.code} value={code} onChange={(e) => setCode(e.target.value)} error={errors.code} placeholder="ITIL-F" />}
        <TextField id={`${idp}-title`} label={f.title} value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} placeholder="ITIL Foundation" className={detail ? 'sm:col-span-2' : undefined} />
      </div>
      <Textarea id={`${idp}-description`} label={f.descriptionOptional} value={description} onChange={setDescription} error={errors.description} rows={2} />
      <Textarea id={`${idp}-sections`} label={h.sections} value={sections} onChange={setSections} error={errors.sections} hint={h.sectionsHint} rows={4} />
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      <Button type="submit" variant={detail ? 'secondary' : 'primary'} disabled={pending}>
        {pending ? f.saving : detail ? h.saveVersion : h.createSubject}
      </Button>
    </form>
  );
}

export function SubjectPanel({ subjectId, program, term, offerings, onChanged }: { subjectId: string; program: Program; term: Term; offerings: Course[]; onChanged: () => Promise<void> }) {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const h = t.setup.hierarchy;
  const [detail, setDetail] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: CourseTemplateDetail }>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      setDetail({ status: 'ready', value: await api.getCourseTemplate(subjectId) });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setDetail({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [subjectId, handleUnauthorized, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  if (detail.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {h.loadingSubject}
      </p>
    );
  }
  if (detail.status === 'error') return <Alert tone="error">{detail.message}</Alert>;
  const subject = detail.value;
  const latest = subject.latestVersion;

  return (
    <div className="space-y-6">
      <Card as="section" aria-labelledby="panel-heading" className="space-y-4">
        <div id="panel-heading">
          <PanelHeader
            kicker={h.subjectKicker(program.name)}
            title={latest?.title ?? subject.title}
            meta={h.subjectMeta(subject.code, latest?.version ?? 0, subject.versionCount)}
            badge={<Badge tone="neutral">{h.reusable}</Badge>}
          />
        </div>
        {latest?.description ? <p className="text-sm text-slate-700">{latest.description}</p> : null}
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
        {/* Not keyed by version: the confirmation stays visible and the next edit builds on the new version. */}
        <SubjectForm
          mode={{ kind: 'edit', detail: subject }}
          onSaved={async () => {
            await load();
            await onChanged();
          }}
        />
      </Card>

      <Card as="section" aria-labelledby="offerings-heading" className="space-y-4">
        <h3 id="offerings-heading" className="text-lg font-semibold text-slate-900">
          {h.offeringsIn(term.code)}
        </h3>
        <p className="text-sm text-slate-600">{h.offeringsNote}</p>
        {offerings.length ? (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {offerings.map((course) => (
              <li key={course.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">{course.title}</p>
                  <p className="text-xs text-slate-500">{course.code}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <CourseStatusBadge status={course.status} />
                  <Link href={`/courses/${course.id}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
                    {h.openCourse}
                    <span className="sr-only"> {course.code}</span>
                  </Link>
                  <Link href="/admin/courses" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
                    {h.enrollments}
                    <span className="sr-only"> {h.forCourse(course.code)}</span>
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">
            {h.notOffered(subject.code, term.code)}
          </p>
        )}
        {program.isActive ? (
          // Keyed by version so the suggested title follows the subject's current version.
          <NewOfferingForm key={latest?.version ?? 0} subject={subject} program={program} term={term} onCreated={onChanged} />
        ) : (
          <Alert tone="info">{h.programInactive}</Alert>
        )}
      </Card>
    </div>
  );
}

function NewOfferingForm({ subject, program, term, onCreated }: { subject: CourseTemplateDetail; program: Program; term: Term; onCreated: () => Promise<void> }) {
  const suggested = `${subject.code}-${term.code}`.slice(0, 32);
  const [code, setCode] = useState(suggested);
  const [title, setTitle] = useState(subject.latestVersion?.title ?? subject.title);
  const [status, setStatus] = useState<'draft' | 'published'>('draft');
  const [errors, setErrors] = useState<Errors>({});
  const { run, pending, result } = useCsrfAction();
  const { t } = useLocale();
  const h = t.setup.hierarchy;
  const f = t.setup.fields;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    const c = codeError(code, t);
    const titleProblem = textError(title, t.errors.enterTitle, t);
    if (c) next.code = c;
    if (titleProblem) next.title = titleProblem;
    setErrors(next);
    if (Object.keys(next).length) return;
    const created = await run(
      (csrf) => api.createCourse({ programId: program.id, termId: term.id, templateId: subject.id, code: code.trim(), title: title.trim(), status }, csrf),
      (course) => h.offeringCreated(course.code, term.code),
    );
    if (created) await onCreated();
  };
  return (
    <form noValidate onSubmit={submit} className="space-y-4 border-t border-slate-200 pt-4" aria-labelledby="new-offering-heading">
      <h4 id="new-offering-heading" className="font-semibold text-slate-900">
        {h.newOfferingIn(term.code)}
      </h4>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField id="offering-code" label={f.courseCode} value={code} onChange={(e) => setCode(e.target.value)} error={errors.code} />
        <TextField id="offering-title" label={f.title} value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} />
        <SelectField
          id="offering-status"
          label={f.status}
          value={status}
          onChange={(event) => setStatus(event.target.value === 'published' ? 'published' : 'draft')}
          options={[
            { value: 'draft', label: h.draftStaffOnly },
            { value: 'published', label: t.status.published },
          ]}
        />
      </div>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      <Button type="submit" disabled={pending}>
        {pending ? f.saving : h.createOffering}
      </Button>
    </form>
  );
}
