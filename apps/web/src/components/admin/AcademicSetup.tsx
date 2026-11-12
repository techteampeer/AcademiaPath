'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { useCsrfAction, type ActionResult } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Course, CourseRole, CourseTemplate, Program, Term } from '@/lib/api/types';
import { localizeTermName, type Messages } from '@/lib/i18n/messages';

/** Lists show the first page only; enough for the demo setup. */
const LIST_LIMIT = 100;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Errors = Record<string, string>;

function codeError(code: string, t: Messages): string | undefined {
  if (!code.trim()) return t.errors.enterCode;
  if (code.trim().length > 32 || !CODE_PATTERN.test(code.trim())) return t.errors.codeFormat;
  return undefined;
}

/** Shared CSRF action (localized errors); each step shows its own result. */
const useAction = useCsrfAction;

function StepCard({ step, title, description, children }: { step: number; title: string; description: string; children: ReactNode }) {
  const headingId = `setup-step-${step}`;
  return (
    <Card as="section" padding="lg" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-semibold text-brand-600">
        {step}. {title}
      </h2>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
      <div className="mt-5">{children}</div>
    </Card>
  );
}

function ActionResultAlert({ result }: { result: ActionResult }) {
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
  const { t } = useLocale();
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
      <PageHeader
        breadcrumbs={[{ label: t.nav.adminOverview, href: '/admin' }, { label: t.nav.courseSetup }]}
        breadcrumbLabel={t.common.breadcrumb}
        title={t.nav.courseSetup}
        description={t.setup.setup.intro(LIST_LIMIT)}
      />
      {listError ? <Alert tone="error">{t.setup.setup.listError}</Alert> : null}
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
  const { t } = useLocale();
  const s = t.setup.setup;
  const f = t.setup.fields;
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Errors>({});

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    const codeProblem = codeError(code, t);
    if (codeProblem) next.code = codeProblem;
    if (!name.trim()) next.name = t.errors.enterName;
    setErrors(next);
    if (Object.keys(next).length) return;

    const created = await run(
      (csrf) => api.createProgram({ code: code.trim(), name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }, csrf),
      (program) => s.programCreated(program.code),
    );
    if (created) {
      setCode('');
      setName('');
      setDescription('');
      await onCreated();
    }
  };

  return (
    <StepCard step={1} title={s.programStep} description={s.programStepHelp}>
      <form noValidate onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        <TextField id="program-code" label={f.code} value={code} onChange={(e) => setCode(e.target.value)} error={errors.code} hint={s.programCodeHint} required />
        <TextField id="program-name" label={f.name} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} required />
        <TextField id="program-description" label={f.descriptionOptional} className="sm:col-span-2" value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="space-y-3 sm:col-span-2">
          <ActionResultAlert result={result} />
          <Button type="submit" disabled={pending}>
            {pending ? f.creating : s.createProgram}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

function TermStep({ onCreated }: { onCreated: () => Promise<void> }) {
  const { run, pending, result } = useAction();
  const { t } = useLocale();
  const s = t.setup.setup;
  const f = t.setup.fields;
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [errors, setErrors] = useState<Errors>({});

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    const codeProblem = codeError(code, t);
    if (codeProblem) next.code = codeProblem;
    if (!name.trim()) next.name = t.errors.enterName;
    if (!startsOn) next.startsOn = t.setup.dates.chooseStart;
    if (!endsOn) next.endsOn = t.setup.dates.chooseEnd;
    else if (startsOn && endsOn < startsOn) next.endsOn = t.setup.dates.endBeforeStart;
    setErrors(next);
    if (Object.keys(next).length) return;

    const created = await run(
      (csrf) => api.createTerm({ code: code.trim(), name: name.trim(), startsOn, endsOn }, csrf),
      (term) => s.termCreated(term.code),
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
    <StepCard step={2} title={s.termStep} description={s.termStepHelp}>
      <form noValidate onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        <TextField id="term-code" label={f.code} value={code} onChange={(e) => setCode(e.target.value)} error={errors.code} hint={s.termCodeHint} required />
        <TextField id="term-name" label={f.name} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} required />
        <TextField id="term-starts" label={f.startsOn} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} error={errors.startsOn} required />
        <TextField id="term-ends" label={f.endsOn} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} error={errors.endsOn} required />
        <div className="space-y-3 sm:col-span-2">
          <ActionResultAlert result={result} />
          <Button type="submit" disabled={pending}>
            {pending ? f.creating : s.createTerm}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

type SectionDraft = { title: string; isVisible: boolean };

function TemplateStep({ programs, onCreated }: { programs: Program[]; onCreated: () => Promise<void> }) {
  const { run, pending, result } = useAction();
  const { t } = useLocale();
  const s = t.setup.setup;
  const f = t.setup.fields;
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
    const codeProblem = codeError(code, t);
    if (codeProblem) next.code = codeProblem;
    if (!title.trim()) next.title = t.errors.enterTitle;
    sections.forEach((section, index) => {
      if (!section.title.trim()) next[`section-${index}`] = s.sectionRequired;
    });
    if (sections.length === 0) next.sections = s.atLeastOneSection;
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
      (version) => s.templateCreated(version.code, version.version, version.sections.length),
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
      title={s.templateStep}
      description={s.templateStepHelp}
    >
      <form noValidate onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        <TextField id="template-code" label={f.code} value={code} onChange={(e) => setCode(e.target.value)} error={errors.code} hint={s.templateCodeHint} required />
        <TextField id="template-title" label={f.title} value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} required />
        <SelectField
          id="template-program"
          label={f.program}
          className="sm:col-span-2"
          value={programId}
          onChange={(e) => setProgramId(e.target.value)}
          options={[{ value: '', label: s.sharedProgram }, ...programs.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }))]}
        />
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium text-slate-800">{s.sectionsInOrder}</legend>
          {errors.sections ? <p className="mt-1 text-sm text-red-700">{errors.sections}</p> : null}
          <ol className="mt-2 space-y-3">
            {sections.map((section, index) => (
              <li key={index} className="flex flex-wrap items-end gap-3">
                <TextField
                  id={`template-section-${index}`}
                  label={s.sectionTitle(index + 1)}
                  className="min-w-0 flex-1"
                  value={section.title}
                  onChange={(e) => updateSection(index, { title: e.target.value })}
                  error={errors[`section-${index}`]}
                />
                <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
                  <input type="checkbox" checked={section.isVisible} onChange={(e) => updateSection(index, { isVisible: e.target.checked })} />
                  {s.visibleToStudents}
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mb-1"
                  onClick={() => setSections((current) => current.filter((_, i) => i !== index))}
                  aria-label={s.removeSection(index + 1)}
                >
                  {f.remove}
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
            {s.addSection}
          </Button>
        </fieldset>
        <div className="space-y-3 sm:col-span-2">
          <ActionResultAlert result={result} />
          <Button type="submit" disabled={pending}>
            {pending ? f.creating : s.createTemplate}
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
  const { t, locale } = useLocale();
  const s = t.setup.setup;
  const f = t.setup.fields;
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
    if (!programId) next.programId = s.chooseProgram;
    if (!termId) next.termId = s.chooseTerm;
    if (!selectedTemplate) next.templateId = s.chooseTemplate;
    const codeProblem = codeError(code, t);
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
      (course) => s.courseCreated(course.code, t.status[course.status]),
    );
    if (created) {
      setCode('');
      setTitle('');
      setTemplateVersion('');
      await onCreated();
    }
  };

  return (
    <StepCard step={4} title={s.courseStep} description={s.courseStepHelp}>
      <form noValidate onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="course-program"
          label={f.program}
          value={programId}
          onChange={(e) => {
            setProgramId(e.target.value);
            setTemplateId('');
            setTemplateVersion('');
          }}
          error={errors.programId}
          options={selectOptions(s.selectProgram, programs.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })))}
        />
        <SelectField
          id="course-term"
          label={f.term}
          value={termId}
          onChange={(e) => setTermId(e.target.value)}
          error={errors.termId}
          options={selectOptions(s.selectTerm, terms.map((term) => ({ value: term.id, label: `${term.code} — ${localizeTermName(term.name, locale)}` })))}
        />
        <SelectField
          id="course-template"
          label={s.template}
          value={templateId}
          onChange={(e) => {
            setTemplateId(e.target.value);
            setTemplateVersion('');
          }}
          error={errors.templateId}
          disabled={!programId}
          hint={programId ? undefined : s.programFirst}
          options={selectOptions(
            s.selectTemplate,
            compatibleTemplates.map((template) => ({ value: template.id, label: s.templateOption(template.code, template.title, template.latestVersion?.version ?? 0) })),
          )}
        />
        <SelectField
          id="course-template-version"
          label={s.templateVersion}
          value={templateVersion}
          onChange={(e) => setTemplateVersion(e.target.value)}
          disabled={!selectedTemplate}
          options={[
            { value: '', label: selectedTemplate ? s.latestVersion(latestVersion) : s.latest },
            ...Array.from({ length: latestVersion }, (_, i) => ({ value: String(i + 1), label: s.versionN(i + 1) })),
          ]}
        />
        <TextField id="course-code" label={f.courseCode} value={code} onChange={(e) => setCode(e.target.value)} error={errors.code} hint={s.courseCodeHint} required />
        <TextField id="course-title" label={f.titleOptional} value={title} onChange={(e) => setTitle(e.target.value)} hint={s.courseTitleHint} />
        <SelectField
          id="course-status"
          label={f.status}
          value={status}
          onChange={(e) => setStatus(e.target.value === 'published' ? 'published' : 'draft')}
          hint={s.statusHint}
          options={[
            { value: 'draft', label: t.status.draft },
            { value: 'published', label: t.status.published },
          ]}
        />
        <div className="space-y-3 sm:col-span-2">
          <ActionResultAlert result={result} />
          <Button type="submit" disabled={pending}>
            {pending ? f.creating : s.createCourse}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

const ROLE_VALUES: CourseRole[] = ['student', 'instructor', 'non_editing_instructor', 'design_team'];

function EnrollmentStep({ courses, onCreated }: { courses: Course[]; onCreated: () => Promise<void> }) {
  const { run, pending, result } = useAction();
  const { t } = useLocale();
  const s = t.setup.setup;
  const roleOptions = ROLE_VALUES.map((value) => ({ value, label: t.roles[value] }));
  const [courseId, setCourseId] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<CourseRole>('student');
  const [errors, setErrors] = useState<Errors>({});

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Errors = {};
    if (!courseId) next.courseId = s.chooseCourse;
    if (!email.trim()) next.email = s.enterEmail;
    else if (!EMAIL_PATTERN.test(email.trim())) next.email = t.errors.invalidEmail;
    setErrors(next);
    if (Object.keys(next).length) return;

    const created = await run(
      (csrf) => api.createEnrollment(courseId, { email: email.trim(), role }, csrf),
      (enrollment) => s.enrolled(enrollment.user.email, t.roles[enrollment.role]),
    );
    if (created) {
      setEmail('');
      await onCreated();
    }
  };

  return (
    <StepCard step={5} title={s.enrollStep} description={s.enrollStepHelp}>
      <form noValidate onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="enroll-course"
          label={s.course}
          className="sm:col-span-2"
          value={courseId}
          onChange={(e) => setCourseId(e.target.value)}
          error={errors.courseId}
          options={selectOptions(s.selectCourse, courses.map((c) => ({ value: c.id, label: `${c.code} — ${c.title} (${t.status[c.status]})` })))}
        />
        <TextField id="enroll-email" label={s.userEmail} type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} required />
        <SelectField
          id="enroll-role"
          label={s.courseRole}
          value={role}
          onChange={(e) => setRole(ROLE_VALUES.find((value) => value === e.target.value) ?? 'student')}
          options={roleOptions}
        />
        <div className="space-y-3 sm:col-span-2">
          <ActionResultAlert result={result} />
          <Button type="submit" disabled={pending}>
            {pending ? s.enrolling : s.enroll}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}
