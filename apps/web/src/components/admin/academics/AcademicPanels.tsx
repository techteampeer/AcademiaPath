'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { CourseStatusBadge } from '@/components/courses/CourseCard';
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

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PERIODS = [
  { value: '1', label: '1 — First semester' },
  { value: '2', label: '2 — Second semester' },
  { value: '0', label: '0 — Summer term (verano)' },
];
type Errors = Record<string, string>;

function codeError(code: string): string | undefined {
  const value = code.trim();
  if (!value) return 'Enter a code.';
  if (value.length > 32 || !CODE_PATTERN.test(value)) return 'Use up to 32 letters, numbers, dots, hyphens or underscores, without spaces.';
  return undefined;
}

function textError(value: string, label: string, max = 200): string | undefined {
  if (!value.trim()) return `Enter ${label}.`;
  if (value.length > max) return `Use at most ${max} characters.`;
  return undefined;
}

function datesError(startsOn: string, endsOn: string): Errors {
  const errors: Errors = {};
  if (!startsOn) errors.startsOn = 'Choose the start date.';
  if (!endsOn) errors.endsOn = 'Choose the end date.';
  else if (startsOn && endsOn < startsOn) errors.endsOn = 'The term cannot end before it starts.';
  return errors;
}

const formatDate = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString();
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
        <h2 className="mt-1 text-xl font-semibold break-words text-slate-900">{title}</h2>
        {meta ? <p className="text-sm text-slate-500">{meta}</p> : null}
      </div>
      {badge}
    </div>
  );
}

// ---------------------------------------------------------------- Academic year

export function YearPanel({ year, terms, onSelectTerm, onCreated }: { year: number; terms: Term[]; onSelectTerm: (id: string) => void; onCreated: (term: Term) => Promise<void> }) {
  const free = PERIODS.filter((period) => !terms.some((term) => term.code === `${year}-${period.value}`));
  const [period, setPeriod] = useState(free[0]?.value ?? '1');
  const [name, setName] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const { run, pending, result } = useCsrfAction();
  const code = `${year}-${period}`;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = datesError(startsOn, endsOn);
    if (name.length > 200) next.name = 'Use at most 200 characters.';
    setErrors(next);
    if (Object.keys(next).length) return;
    const created = await run(
      (csrf) => api.createTerm({ code, name: name.trim() || (period === '0' ? `Verano ${code}` : `Semestre ${code}`), academicYear: year, startsOn, endsOn }, csrf),
      (term) => `Term ${term.code} created.`,
    );
    if (created) await onCreated(created);
  };

  return (
    <Card as="section" aria-labelledby="panel-heading" className="space-y-6">
      <div id="panel-heading">
        <PanelHeader kicker="Academic year" title={String(year)} meta={`${terms.length} ${terms.length === 1 ? 'term' : 'terms'}`} />
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
                {formatDate(term.startsOn)} – {formatDate(term.endsOn)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">
          No terms in {year} yet. The academic year is saved together with its first term.
        </p>
      )}
      <form noValidate onSubmit={submit} className="space-y-4 border-t border-slate-200 pt-4" aria-labelledby="new-term-heading">
        <h3 id="new-term-heading" className="font-semibold text-slate-900">
          New term in {year}
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField id="term-period" label="Period" value={period} onChange={(event) => setPeriod(event.target.value)} options={PERIODS} hint={`Term code: ${code}`} />
          <TextField id="term-name" label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder={period === '0' ? `Verano ${code}` : `Semestre ${code}`} error={errors.name} />
          <TextField id="term-starts" label="Starts on" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} error={errors.startsOn} />
          <TextField id="term-ends" label="Ends on" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} error={errors.endsOn} />
        </div>
        {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : `Create term ${code}`}
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

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = datesError(startsOn, endsOn);
    const nameError = textError(name, 'a name');
    if (nameError) next.name = nameError;
    setErrors(next);
    if (Object.keys(next).length) return;
    const saved = await edit.run((csrf) => api.updateTerm(term.id, { name: name.trim(), startsOn, endsOn }, csrf), (t) => `Term ${t.code} saved.`);
    if (saved) await onChanged();
  };

  return (
    <div className="space-y-6">
      <Card as="section" aria-labelledby="panel-heading" className="space-y-4">
        <div id="panel-heading">
          <PanelHeader
            kicker={`Term · academic year ${term.academicYear}`}
            title={term.code}
            meta={term.name}
            badge={<Badge tone="brand">{offeringCount === null ? '…' : `${offeringCount} ${offeringCount === 1 ? 'offering' : 'offerings'}`}</Badge>}
          />
        </div>
        <form noValidate onSubmit={save} className="space-y-4" aria-label="Edit term">
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField id="edit-term-name" label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} className="sm:col-span-3" />
            <TextField id="edit-term-starts" label="Starts on" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} error={errors.startsOn} />
            <TextField id="edit-term-ends" label="Ends on" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} error={errors.endsOn} />
          </div>
          <p className="text-xs text-slate-500">The code and academic year identify the term and cannot change.</p>
          {edit.result ? <Alert tone={edit.result.tone}>{edit.result.message}</Alert> : null}
          <Button type="submit" variant="secondary" disabled={edit.pending}>
            {edit.pending ? 'Saving…' : 'Save term'}
          </Button>
        </form>
      </Card>

      <Card as="section" aria-labelledby="programs-heading" className="space-y-4">
        <h3 id="programs-heading" className="text-lg font-semibold text-slate-900">
          Programs
        </h3>
        <p className="text-sm text-slate-600">Programs are shared by every academic year and term. Counts show offerings in {term.code}.</p>
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
                  {program.isActive ? null : <Badge tone="warning">Inactive</Badge>}
                  <span className="text-xs text-slate-600">{programCounts.get(program.id) ?? 0} in this term</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">No programs yet.</p>
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
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    const c = codeError(code);
    const n = textError(name, 'a name');
    if (c) next.code = c;
    if (n) next.name = n;
    if (description.length > 2000) next.description = 'Use at most 2000 characters.';
    setErrors(next);
    if (Object.keys(next).length) return;
    const created = await run(
      (csrf) => api.createProgram({ code: code.trim(), name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }, csrf),
      (p) => `Program ${p.name} created.`,
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
        New program
      </h4>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id="program-code" label="Code" value={code} onChange={(e) => setCode(e.target.value)} error={errors.code} placeholder="IT-MGMT" />
        <TextField id="program-name" label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} placeholder="IT Management" />
      </div>
      <Textarea id="program-description" label="Description (optional)" value={description} onChange={setDescription} error={errors.description} rows={2} />
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Saving…' : 'Create program'}
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

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    const n = textError(name, 'a name');
    if (n) next.name = n;
    if (description.length > 2000) next.description = 'Use at most 2000 characters.';
    setErrors(next);
    if (Object.keys(next).length) return;
    const saved = await edit.run(
      (csrf) => api.updateProgram(program.id, { name: name.trim(), description: description.trim() || null, isActive }, csrf),
      (p) => `Program ${p.name} saved.`,
    );
    if (saved) await onChanged();
  };

  return (
    <div className="space-y-6">
      <Card as="section" aria-labelledby="panel-heading" className="space-y-4">
        <div id="panel-heading">
          <PanelHeader
            kicker={`Program · viewing term ${term.code}`}
            title={program.name}
            meta={program.code}
            badge={program.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Inactive</Badge>}
          />
        </div>
        <form noValidate onSubmit={save} className="space-y-4" aria-label="Edit program">
          <TextField id="edit-program-name" label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
          <Textarea id="edit-program-description" label="Description (optional)" value={description} onChange={setDescription} error={errors.description} rows={2} />
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
            Active (inactive programs keep their subjects and courses but cannot receive new offerings)
          </label>
          <p className="text-xs text-slate-500">The code identifies the program and cannot change.</p>
          {edit.result ? <Alert tone={edit.result.tone}>{edit.result.message}</Alert> : null}
          <Button type="submit" variant="secondary" disabled={edit.pending}>
            {edit.pending ? 'Saving…' : 'Save program'}
          </Button>
        </form>
      </Card>

      <Card as="section" aria-labelledby="subjects-heading" className="space-y-4">
        <h3 id="subjects-heading" className="text-lg font-semibold text-slate-900">
          Subjects
        </h3>
        <p className="text-sm text-slate-600">Subjects are reusable templates of this program. Counts show offerings in {term.code}.</p>
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
                <span className="text-xs text-slate-600">{subjectCounts.get(subject.id) ?? 0} in this term</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">No subjects in this program yet.</p>
        )}
        <SubjectForm mode={{ kind: 'create', programId: program.id }} onSaved={onChanged} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Subject

type SubjectFormMode = { kind: 'create'; programId: string } | { kind: 'edit'; detail: CourseTemplateDetail };

function SubjectForm({ mode, onSaved }: { mode: SubjectFormMode; onSaved: () => Promise<void> }) {
  const detail = mode.kind === 'edit' ? mode.detail : null;
  const [code, setCode] = useState(detail?.code ?? '');
  const [title, setTitle] = useState(detail?.latestVersion?.title ?? detail?.title ?? '');
  const [description, setDescription] = useState(detail?.latestVersion?.description ?? '');
  const [sections, setSections] = useState((detail?.latestVersion?.sections ?? []).map((s) => s.title).join('\n'));
  const [errors, setErrors] = useState<Errors>({});
  const { run, pending, result } = useCsrfAction();
  const baseVersion = detail ? (detail.latestVersion?.version ?? 0) : 0;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    const c = detail ? undefined : codeError(code);
    const t = textError(title, 'a title');
    const lines = sectionLines(sections);
    if (c) next.code = c;
    if (t) next.title = t;
    if (description.length > 2000) next.description = 'Use at most 2000 characters.';
    if (!lines.length) next.sections = 'Add at least one section (one per line).';
    else if (lines.length > 100 || lines.some((line) => line.length > 200)) next.sections = 'Use at most 100 sections of up to 200 characters.';
    setErrors(next);
    if (Object.keys(next).length) return;
    const programId = detail ? detail.programId : mode.kind === 'create' ? mode.programId : null;
    const saved = await run(
      (csrf) =>
        api.createCourseTemplate(
          {
            code: detail ? detail.code : code.trim(),
            programId,
            title: title.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
            baseVersion,
            sections: lines.map((line) => ({ title: line, isVisible: true })),
          },
          csrf,
        ),
      (version) => (detail ? `Saved as version ${version.version}. Existing offerings keep their version.` : `Subject ${version.code} created.`),
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
        {detail ? `Edit subject (saves version ${baseVersion + 1})` : 'New subject'}
      </h4>
      <div className="grid gap-4 sm:grid-cols-2">
        {detail ? null : <TextField id={`${idp}-code`} label="Code" value={code} onChange={(e) => setCode(e.target.value)} error={errors.code} placeholder="ITIL-F" />}
        <TextField id={`${idp}-title`} label="Title" value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} placeholder="ITIL Foundation" className={detail ? 'sm:col-span-2' : undefined} />
      </div>
      <Textarea id={`${idp}-description`} label="Description (optional)" value={description} onChange={setDescription} error={errors.description} rows={2} />
      <Textarea id={`${idp}-sections`} label="Sections" value={sections} onChange={setSections} error={errors.sections} hint="One section per line, in order." rows={4} />
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      <Button type="submit" variant={detail ? 'secondary' : 'primary'} disabled={pending}>
        {pending ? 'Saving…' : detail ? 'Save new version' : 'Create subject'}
      </Button>
    </form>
  );
}

export function SubjectPanel({ subjectId, program, term, offerings, onChanged }: { subjectId: string; program: Program; term: Term; offerings: Course[]; onChanged: () => Promise<void> }) {
  const { handleUnauthorized } = useSession();
  const [detail, setDetail] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: CourseTemplateDetail }>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      setDetail({ status: 'ready', value: await api.getCourseTemplate(subjectId) });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setDetail({ status: 'error', message: describeApiError(error) });
    }
  }, [subjectId, handleUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  if (detail.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        Loading subject…
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
            kicker={`Subject · ${program.name}`}
            title={latest?.title ?? subject.title}
            meta={`${subject.code} · version ${latest?.version ?? 0} of ${subject.versionCount}`}
            badge={<Badge tone="neutral">Reusable template</Badge>}
          />
        </div>
        {latest?.description ? <p className="text-sm text-slate-700">{latest.description}</p> : null}
        {latest?.sections.length ? (
          <ol className="list-decimal space-y-1 pl-6 text-sm text-slate-800">
            {latest.sections.map((section) => (
              <li key={section.id}>
                {section.title}
                {section.isVisible ? null : <span className="ml-2 text-xs text-slate-500">(hidden)</span>}
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
          Offerings in {term.code}
        </h3>
        <p className="text-sm text-slate-600">Each offering is a course for this term, created from the subject&rsquo;s current version.</p>
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
                    Open course<span className="sr-only"> {course.code}</span>
                  </Link>
                  <Link href="/admin/setup" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
                    Enrollments<span className="sr-only"> for {course.code}</span>
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">
            {subject.code} is not offered in {term.code} yet.
          </p>
        )}
        {program.isActive ? (
          // Keyed by version so the suggested title follows the subject's current version.
          <NewOfferingForm key={latest?.version ?? 0} subject={subject} program={program} term={term} onCreated={onChanged} />
        ) : (
          <Alert tone="info">This program is inactive, so new offerings cannot be created. Reactivate it on the program page.</Alert>
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
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    const c = codeError(code);
    const t = textError(title, 'a title');
    if (c) next.code = c;
    if (t) next.title = t;
    setErrors(next);
    if (Object.keys(next).length) return;
    const created = await run(
      (csrf) => api.createCourse({ programId: program.id, termId: term.id, templateId: subject.id, code: code.trim(), title: title.trim(), status }, csrf),
      (course) => `Offering ${course.code} created in ${term.code}.`,
    );
    if (created) await onCreated();
  };
  return (
    <form noValidate onSubmit={submit} className="space-y-4 border-t border-slate-200 pt-4" aria-labelledby="new-offering-heading">
      <h4 id="new-offering-heading" className="font-semibold text-slate-900">
        New offering in {term.code}
      </h4>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField id="offering-code" label="Course code" value={code} onChange={(e) => setCode(e.target.value)} error={errors.code} />
        <TextField id="offering-title" label="Title" value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} />
        <SelectField
          id="offering-status"
          label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value === 'published' ? 'published' : 'draft')}
          options={[
            { value: 'draft', label: 'Draft (staff only)' },
            { value: 'published', label: 'Published' },
          ]}
        />
      </div>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Create offering'}
      </Button>
    </form>
  );
}
