'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SelectField, TextField } from '@/components/ui/Field';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Course, CourseRole, CourseTemplate, Program, Term } from '@/lib/api/types';

/** Lists show the first page only; enough for the demo setup. */
const LIST_LIMIT = 100;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Errors = Record<string, string>;
type Result = { tone: 'success' | 'error'; message: string } | null;

function codeError(code: string): string | undefined {
  if (!code.trim()) return 'Enter a code.';
  if (code.trim().length > 32 || !CODE_PATTERN.test(code.trim())) {
    return 'Use up to 32 letters, numbers, dots, hyphens or underscores, without spaces.';
  }
  return undefined;
}

function describeError(error: unknown): string {
  if (isApiError(error, 401)) return 'Your session has ended. Sign in again.';
  if (isApiError(error, 403)) return 'You are not allowed to perform this action.';
  // Other API errors carry a safe, human-readable RFC 9457 `detail`.
  if (isApiError(error)) return error.message;
  return 'The request failed. Check your connection and try again.';
}

/**
 * Runs one state-changing request with the session's in-memory CSRF token. Failures are shown to
 * the user and are never retried automatically.
 */
function useAction() {
  const { getCsrfToken, handleUnauthorized } = useSession();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result>(null);

  async function run<T>(action: (csrfToken: string) => Promise<T>, successMessage: (value: T) => string) {
    setPending(true);
    setResult(null);
    try {
      const value = await action(await getCsrfToken());
      setResult({ tone: 'success', message: successMessage(value) });
      return value;
    } catch (error) {
      setResult({ tone: 'error', message: describeError(error) });
      if (isApiError(error, 401)) handleUnauthorized();
      return null;
    } finally {
      setPending(false);
    }
  }

  return { run, pending, result };
}

function StepCard({ step, title, description, children }: { step: number; title: string; description: string; children: ReactNode }) {
  const headingId = `setup-step-${step}`;
  return (
    <Card as="section" padding="lg" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-semibold text-slate-900">
        {step}. {title}
      </h2>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
      <div className="mt-5">{children}</div>
    </Card>
  );
}

function ActionResult({ result }: { result: Result }) {
  return result ? <Alert tone={result.tone}>{result.message}</Alert> : null;
}

const selectOptions = (placeholder: string, items: Array<{ value: string; label: string }>) => [
  { value: '', label: placeholder },
  ...items,
];

export function AcademicSetup() {
  return <RequireAuth role="administrator">{() => <SetupSteps />}</RequireAuth>;
}

type Lists = { programs: Program[]; terms: Term[]; templates: CourseTemplate[]; courses: Course[] };

function SetupSteps() {
  const { handleUnauthorized } = useSession();
  const [lists, setLists] = useState<Lists>({ programs: [], terms: [], templates: [], courses: [] });
  const [listError, setListError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [programs, terms, templates, courses] = await Promise.all([
        api.listPrograms({ limit: LIST_LIMIT }),
        api.listTerms({ limit: LIST_LIMIT }),
        api.listCourseTemplates({ limit: LIST_LIMIT }),
        api.listCourses({ limit: LIST_LIMIT }),
      ]);
      setLists({ programs: programs.items, terms: terms.items, templates: templates.items, courses: courses.items });
      setListError(false);
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      else setListError(true);
    }
  }, [handleUnauthorized]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Academic setup</h1>
        <p className="mt-2 max-w-3xl text-slate-600">
          Create the academic structure for a course and enroll a user. Every step saves directly to the database through the
          AcademiaPath API. Lists show up to {LIST_LIMIT} entries.
        </p>
      </div>
      {listError ? <Alert tone="error">Existing programs, terms, templates and courses could not be loaded.</Alert> : null}
      <ProgramStep onCreated={refresh} />
      <TermStep onCreated={refresh} />
      <TemplateStep programs={lists.programs} onCreated={refresh} />
      <CourseStep programs={lists.programs} terms={lists.terms} templates={lists.templates} onCreated={refresh} />
      <EnrollmentStep courses={lists.courses} onCreated={refresh} />
    </div>
  );
}

function ProgramStep({ onCreated }: { onCreated: () => Promise<void> }) {
  const { run, pending, result } = useAction();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Errors>({});

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    const codeProblem = codeError(code);
    if (codeProblem) next.code = codeProblem;
    if (!name.trim()) next.name = 'Enter a name.';
    setErrors(next);
    if (Object.keys(next).length) return;

    const created = await run(
      (csrf) => api.createProgram({ code: code.trim(), name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }, csrf),
      (program) => `Program ${program.code} created.`,
    );
    if (created) {
      setCode('');
      setName('');
      setDescription('');
      await onCreated();
    }
  };

  return (
    <StepCard step={1} title="Create a program" description="An academic program, for example a degree.">
      <form noValidate onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        <TextField id="program-code" label="Code" value={code} onChange={(e) => setCode(e.target.value)} error={errors.code} hint="For example ING-SIS" required />
        <TextField id="program-name" label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} required />
        <TextField id="program-description" label="Description (optional)" className="sm:col-span-2" value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="space-y-3 sm:col-span-2">
          <ActionResult result={result} />
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create program'}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

function TermStep({ onCreated }: { onCreated: () => Promise<void> }) {
  const { run, pending, result } = useAction();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [errors, setErrors] = useState<Errors>({});

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    const codeProblem = codeError(code);
    if (codeProblem) next.code = codeProblem;
    if (!name.trim()) next.name = 'Enter a name.';
    if (!startsOn) next.startsOn = 'Choose a start date.';
    if (!endsOn) next.endsOn = 'Choose an end date.';
    else if (startsOn && endsOn < startsOn) next.endsOn = 'The end date cannot be before the start date.';
    setErrors(next);
    if (Object.keys(next).length) return;

    const created = await run(
      (csrf) => api.createTerm({ code: code.trim(), name: name.trim(), startsOn, endsOn }, csrf),
      (term) => `Term ${term.code} created.`,
    );
    if (created) {
      setCode('');
      setName('');
      setStartsOn('');
      setEndsOn('');
      await onCreated();
    }
  };

  return (
    <StepCard step={2} title="Create a term" description="An academic period, for example a semester.">
      <form noValidate onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        <TextField id="term-code" label="Code" value={code} onChange={(e) => setCode(e.target.value)} error={errors.code} hint="For example 2026-2" required />
        <TextField id="term-name" label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} required />
        <TextField id="term-starts" label="Starts on" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} error={errors.startsOn} required />
        <TextField id="term-ends" label="Ends on" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} error={errors.endsOn} required />
        <div className="space-y-3 sm:col-span-2">
          <ActionResult result={result} />
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create term'}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

type SectionDraft = { title: string; isVisible: boolean };

function TemplateStep({ programs, onCreated }: { programs: Program[]; onCreated: () => Promise<void> }) {
  const { run, pending, result } = useAction();
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [programId, setProgramId] = useState('');
  const [sections, setSections] = useState<SectionDraft[]>([{ title: '', isVisible: true }]);
  const [errors, setErrors] = useState<Errors>({});

  const updateSection = (index: number, change: Partial<SectionDraft>) =>
    setSections((current) => current.map((section, i) => (i === index ? { ...section, ...change } : section)));

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    const codeProblem = codeError(code);
    if (codeProblem) next.code = codeProblem;
    if (!title.trim()) next.title = 'Enter a title.';
    sections.forEach((section, index) => {
      if (!section.title.trim()) next[`section-${index}`] = 'Enter a section title or remove the section.';
    });
    if (sections.length === 0) next.sections = 'Add at least one section.';
    setErrors(next);
    if (Object.keys(next).length) return;

    const created = await run(
      (csrf) =>
        api.createCourseTemplate(
          {
            code: code.trim(),
            title: title.trim(),
            programId: programId || null,
            sections: sections.map((section) => ({ title: section.title.trim(), isVisible: section.isVisible })),
          },
          csrf,
        ),
      (version) => `Template ${version.code} version ${version.version} created with ${version.sections.length} sections.`,
    );
    if (created) {
      setCode('');
      setTitle('');
      setSections([{ title: '', isVisible: true }]);
      await onCreated();
    }
  };

  return (
    <StepCard
      step={3}
      title="Create a course template"
      description="Using an existing template code creates a new version; earlier versions are kept."
    >
      <form noValidate onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        <TextField id="template-code" label="Code" value={code} onChange={(e) => setCode(e.target.value)} error={errors.code} hint="For example ITIL-F" required />
        <TextField id="template-title" label="Title" value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} required />
        <SelectField
          id="template-program"
          label="Program"
          className="sm:col-span-2"
          value={programId}
          onChange={(e) => setProgramId(e.target.value)}
          options={[{ value: '', label: 'Shared (no specific program)' }, ...programs.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }))]}
        />
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium text-slate-800">Sections (in order)</legend>
          {errors.sections ? <p className="mt-1 text-sm text-red-700">{errors.sections}</p> : null}
          <ol className="mt-2 space-y-3">
            {sections.map((section, index) => (
              <li key={index} className="flex flex-wrap items-end gap-3">
                <TextField
                  id={`template-section-${index}`}
                  label={`Section ${index + 1} title`}
                  className="min-w-0 flex-1"
                  value={section.title}
                  onChange={(e) => updateSection(index, { title: e.target.value })}
                  error={errors[`section-${index}`]}
                />
                <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
                  <input type="checkbox" checked={section.isVisible} onChange={(e) => updateSection(index, { isVisible: e.target.checked })} />
                  Visible to students
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mb-1"
                  onClick={() => setSections((current) => current.filter((_, i) => i !== index))}
                  aria-label={`Remove section ${index + 1}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ol>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={sections.length >= 100}
            onClick={() => setSections((current) => [...current, { title: '', isVisible: true }])}
          >
            Add section
          </Button>
        </fieldset>
        <div className="space-y-3 sm:col-span-2">
          <ActionResult result={result} />
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create template'}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

function CourseStep({
  programs,
  terms,
  templates,
  onCreated,
}: {
  programs: Program[];
  terms: Term[];
  templates: CourseTemplate[];
  onCreated: () => Promise<void>;
}) {
  const { run, pending, result } = useAction();
  const [programId, setProgramId] = useState('');
  const [termId, setTermId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templateVersion, setTemplateVersion] = useState('');
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<'draft' | 'published'>('draft');
  const [errors, setErrors] = useState<Errors>({});

  // Only templates of the selected program (or shared ones) are offered; the API enforces this too.
  const compatibleTemplates = templates.filter(
    (template) => template.latestVersion && (template.programId === null || template.programId === programId),
  );
  const selectedTemplate = compatibleTemplates.find((template) => template.id === templateId);
  const latestVersion = selectedTemplate?.latestVersion?.version ?? 0;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    if (!programId) next.programId = 'Choose a program.';
    if (!termId) next.termId = 'Choose a term.';
    if (!selectedTemplate) next.templateId = 'Choose a template for this program.';
    const codeProblem = codeError(code);
    if (codeProblem) next.code = codeProblem;
    setErrors(next);
    if (Object.keys(next).length) return;

    const created = await run(
      (csrf) =>
        api.createCourse(
          {
            programId,
            termId,
            templateId,
            code: code.trim(),
            status,
            ...(templateVersion ? { templateVersion: Number(templateVersion) } : {}),
            ...(title.trim() ? { title: title.trim() } : {}),
          },
          csrf,
        ),
      (course) => `Course ${course.code} created as ${course.status} with the template's sections.`,
    );
    if (created) {
      setCode('');
      setTitle('');
      setTemplateVersion('');
      await onCreated();
    }
  };

  return (
    <StepCard step={4} title="Create a course" description="A course in a term, created from a template version. The template's sections are copied into the course.">
      <form noValidate onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="course-program"
          label="Program"
          value={programId}
          onChange={(e) => {
            setProgramId(e.target.value);
            setTemplateId('');
            setTemplateVersion('');
          }}
          error={errors.programId}
          options={selectOptions('Select a program', programs.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })))}
        />
        <SelectField
          id="course-term"
          label="Term"
          value={termId}
          onChange={(e) => setTermId(e.target.value)}
          error={errors.termId}
          options={selectOptions('Select a term', terms.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` })))}
        />
        <SelectField
          id="course-template"
          label="Template"
          value={templateId}
          onChange={(e) => {
            setTemplateId(e.target.value);
            setTemplateVersion('');
          }}
          error={errors.templateId}
          disabled={!programId}
          hint={programId ? undefined : 'Choose a program first.'}
          options={selectOptions(
            'Select a template',
            compatibleTemplates.map((t) => ({ value: t.id, label: `${t.code} — ${t.title} (latest v${t.latestVersion?.version})` })),
          )}
        />
        <SelectField
          id="course-template-version"
          label="Template version"
          value={templateVersion}
          onChange={(e) => setTemplateVersion(e.target.value)}
          disabled={!selectedTemplate}
          options={[
            { value: '', label: selectedTemplate ? `Latest (v${latestVersion})` : 'Latest' },
            ...Array.from({ length: latestVersion }, (_, i) => ({ value: String(i + 1), label: `Version ${i + 1}` })),
          ]}
        />
        <TextField id="course-code" label="Course code" value={code} onChange={(e) => setCode(e.target.value)} error={errors.code} hint="Unique within the term, for example ITIL-2026-2-A" required />
        <TextField id="course-title" label="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} hint="Defaults to the template version's title" />
        <SelectField
          id="course-status"
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value === 'published' ? 'published' : 'draft')}
          hint="Students only see published courses."
          options={[
            { value: 'draft', label: 'Draft' },
            { value: 'published', label: 'Published' },
          ]}
        />
        <div className="space-y-3 sm:col-span-2">
          <ActionResult result={result} />
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create course'}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

const ROLE_OPTIONS: Array<{ value: CourseRole; label: string }> = [
  { value: 'student', label: 'Student' },
  { value: 'instructor', label: 'Instructor' },
  { value: 'non_editing_instructor', label: 'Non-editing instructor' },
  { value: 'design_team', label: 'Design team' },
];

function EnrollmentStep({ courses, onCreated }: { courses: Course[]; onCreated: () => Promise<void> }) {
  const { run, pending, result } = useAction();
  const [courseId, setCourseId] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<CourseRole>('student');
  const [errors, setErrors] = useState<Errors>({});

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    if (!courseId) next.courseId = 'Choose a course.';
    if (!email.trim()) next.email = "Enter the user's email address.";
    else if (!EMAIL_PATTERN.test(email.trim())) next.email = 'Enter a valid email address.';
    setErrors(next);
    if (Object.keys(next).length) return;

    const created = await run(
      (csrf) => api.createEnrollment(courseId, { email: email.trim(), role }, csrf),
      (enrollment) => `${enrollment.user.email} enrolled as ${ROLE_OPTIONS.find((r) => r.value === enrollment.role)?.label ?? enrollment.role}.`,
    );
    if (created) {
      setEmail('');
      await onCreated();
    }
  };

  return (
    <StepCard step={5} title="Enroll a user" description="Give an existing user a role in a course. Each user can hold one role per course.">
      <form noValidate onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="enroll-course"
          label="Course"
          className="sm:col-span-2"
          value={courseId}
          onChange={(e) => setCourseId(e.target.value)}
          error={errors.courseId}
          options={selectOptions('Select a course', courses.map((c) => ({ value: c.id, label: `${c.code} — ${c.title} (${c.status})` })))}
        />
        <TextField id="enroll-email" label="User email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} required />
        <SelectField
          id="enroll-role"
          label="Course role"
          value={role}
          onChange={(e) => setRole(ROLE_OPTIONS.find((r) => r.value === e.target.value)?.value ?? 'student')}
          options={ROLE_OPTIONS}
        />
        <div className="space-y-3 sm:col-span-2">
          <ActionResult result={result} />
          <Button type="submit" disabled={pending}>
            {pending ? 'Enrolling…' : 'Enroll user'}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}
