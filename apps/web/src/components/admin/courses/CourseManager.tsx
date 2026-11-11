'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { LocalizedCourseStatusBadge as CourseStatusBadge } from '@/components/courses/LocalizedCourseStatusBadge';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingCards } from '@/components/ui/Skeleton';
import { tableClasses } from '@/components/ui/table';
import { isApiError } from '@/lib/api/client';
import { api, loadAll } from '@/lib/api/endpoints';
import type { CourseLifecycle, CourseRole, CourseUpdate, Enrollment } from '@/lib/api/types';
import { formatDate } from '@/lib/i18n/messages';
import { PrerequisitesCard } from '@/components/progress/PrerequisitesCard';

const ROLES: CourseRole[] = ['student', 'instructor', 'non_editing_instructor', 'design_team'];
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const textareaClasses = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm';

type Section = CourseLifecycle['sections'][number];

export function CourseManager({ courseId }: { courseId: string }) {
  return <RequireAuth role="administrator">{() => <ManagerContent courseId={courseId} />}</RequireAuth>;
}

function ManagerContent({ courseId }: { courseId: string }) {
  const { t, locale } = useLocale();
  const c = t.courseAdmin;
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'missing' } | { status: 'error'; message: string } | { status: 'ready'; data: CourseLifecycle }>({
    status: 'loading',
  });

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', data: await api.getCourseLifecycle(courseId) });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState(isApiError(error, 404) || isApiError(error, 400) ? { status: 'missing' } : { status: 'error', message: describeApiError(error, locale) });
    }
  }, [courseId, handleUnauthorized, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') return <LoadingCards label={c.loading} count={3} />;
  if (state.status === 'missing') return <EmptyState titleAs="h1" title={c.notFoundTitle} description={c.notFoundDescription} />;
  if (state.status === 'error') {
    return (
      <Alert tone="error">
        {state.message}{' '}
        <button type="button" className="font-medium underline" onClick={() => void load()}>
          {t.common.retry}
        </button>
      </Alert>
    );
  }

  const { data } = state;
  const reload = () => void load();
  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: t.nav.adminOverview, href: '/admin' },
          { label: t.nav.coursesEnrollments, href: '/admin/courses' },
          { label: data.course.code },
        ]}
        breadcrumbLabel={t.common.breadcrumb}
        kicker={data.course.code}
        title={data.course.title}
        description={c.intro}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CourseStatusBadge status={data.course.status} />
            <Link href={`/courses/${data.course.id}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              {t.common.open}
            </Link>
            <Link href={`/courses/${data.course.id}/progress`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              {t.progress.studentProgress}
            </Link>
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <StatusCard data={data} onChanged={reload} />
        <DetailsForm data={data} onSaved={reload} />
      </div>
      <SectionsCard courseId={data.course.id} sections={data.sections} onChanged={reload} />
      <PrerequisitesCard key={data.sections.map((section) => section.id).join()} courseId={data.course.id} sections={data.sections} />
      <RosterCard courseId={data.course.id} counts={data.enrollmentCounts} onChanged={reload} />
    </div>
  );
}

function StatusCard({ data, onChanged }: { data: CourseLifecycle; onChanged: () => void }) {
  const { t, locale } = useLocale();
  const c = t.courseAdmin;
  const { run, pending, result } = useCsrfAction();
  const [confirming, setConfirming] = useState<'publish' | 'unpublish' | null>(null);
  const { course } = data;
  const activeStudents = data.enrollmentCounts.find((r) => r.role === 'student')?.active ?? 0;
  const explanation = course.status === 'published' ? c.statusPublished : course.status === 'draft' ? c.statusDraft : c.statusArchived;

  const transition = async (name: 'publish' | 'unpublish') => {
    const updated = await run(
      (csrf) => (name === 'publish' ? api.publishCourse(course.id, course.version, csrf) : api.unpublishCourse(course.id, course.version, csrf)),
      () => (name === 'publish' ? c.published : c.unpublished),
    );
    setConfirming(null);
    if (updated) onChanged();
  };

  return (
    <Card as="section" aria-labelledby="course-status-heading" className="space-y-4">
      <h2 id="course-status-heading" className="text-lg font-semibold text-brand-600">
        {c.statusTitle}
      </h2>
      <p className="text-sm text-slate-700">{explanation}</p>
      <ul className="space-y-1 text-sm text-slate-700">
        <li>{c.visibleToStudents(data.studentVisibleActivityCount)}</li>
        <li>{c.notApproved(data.unapprovedActivityCount)}</li>
        <li>{c.awaitingReview(data.awaitingReviewCount)}</li>
        <li>{c.activeStudents(activeStudents)}</li>
      </ul>
      <p className="text-xs text-slate-500">
        {c.term(data.term.code, formatDate(data.term.startsOn, locale), formatDate(data.term.endsOn, locale))}
        {data.template ? ` ${c.template(data.template.code, data.template.version)}` : ''}
      </p>
      {confirming ? (
        <div role="group" aria-labelledby="confirm-transition-heading" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <h3 id="confirm-transition-heading" className="font-semibold text-amber-900">
            {confirming === 'publish' ? c.confirmPublishTitle : c.confirmUnpublishTitle}
          </h3>
          <p className="text-sm text-amber-900">{confirming === 'publish' ? c.confirmPublish(data.studentVisibleActivityCount, activeStudents) : c.confirmUnpublish}</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending} onClick={() => void transition(confirming)}>
              {c.confirm}
            </Button>
            <Button variant="secondary" disabled={pending} onClick={() => setConfirming(null)}>
              {c.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {data.allowedTransitions.includes('publish') ? <Button onClick={() => setConfirming('publish')}>{c.publish}</Button> : null}
          {data.allowedTransitions.includes('unpublish') ? (
            <Button variant="secondary" onClick={() => setConfirming('unpublish')}>
              {c.unpublish}
            </Button>
          ) : null}
        </div>
      )}
      {result ? (
        <Alert tone={result.tone}>
          {result.message}
          {result.tone === 'error' ? (
            <>
              {' '}
              <button type="button" className="font-medium underline" onClick={onChanged}>
                {c.reload}
              </button>
            </>
          ) : null}
        </Alert>
      ) : null}
    </Card>
  );
}

function DetailsForm({ data, onSaved }: { data: CourseLifecycle; onSaved: () => void }) {
  const { t } = useLocale();
  const c = t.courseAdmin;
  const { run, pending, result } = useCsrfAction();
  const { course } = data;
  const [title, setTitle] = useState(course.title);
  const [code, setCode] = useState(course.code);
  const [description, setDescription] = useState(course.description ?? '');
  const [errors, setErrors] = useState<{ title?: string; code?: string }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const codeEditable = course.status === 'draft';

  // After a save (or another change) the course reloads with a new version: show the stored values
  // without remounting, so the confirmation message stays visible.
  useEffect(() => {
    setTitle(course.title);
    setCode(course.code);
    setDescription(course.description ?? '');
  }, [course.version, course.title, course.code, course.description]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(null);
    const found: typeof errors = {};
    if (!title.trim()) found.title = c.titleRequired;
    if (codeEditable && !CODE_PATTERN.test(code.trim())) found.code = c.codeInvalid;
    setErrors(found);
    if (Object.keys(found).length) return;
    const body: CourseUpdate = { version: course.version };
    if (title.trim() !== course.title) body.title = title.trim();
    if (codeEditable && code.trim() !== course.code) body.code = code.trim();
    if ((description.trim() || null) !== course.description) body.description = description.trim() || null;
    if (Object.keys(body).length === 1) return setNotice(c.noChanges);
    const updated = await run((csrf) => api.updateCourse(course.id, body, csrf), () => c.saved);
    if (updated) onSaved();
  };

  return (
    <Card as="section" aria-labelledby="course-details-heading">
      <form noValidate onSubmit={submit} className="space-y-4">
        <h2 id="course-details-heading" className="text-lg font-semibold text-brand-600">
          {c.detailsTitle}
        </h2>
        <TextField id="course-title" label={c.title} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} error={errors.title} />
        <TextField
          id="course-code"
          label={c.code}
          value={code}
          maxLength={32}
          disabled={!codeEditable}
          hint={codeEditable ? c.codeDraftHint : c.codeLockedHint}
          onChange={(e) => setCode(e.target.value)}
          error={errors.code}
        />
        <div>
          <label htmlFor="course-description" className="block text-sm font-medium text-slate-800">
            {c.description}
          </label>
          <textarea id="course-description" rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} className={textareaClasses} />
        </div>
        {notice ? <Alert tone="info">{notice}</Alert> : null}
        {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={pending}>
            {pending ? c.saving : c.save}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SectionsCard({ courseId, sections, onChanged }: { courseId: string; sections: Section[]; onChanged: () => void }) {
  const { t } = useLocale();
  const c = t.courseAdmin;
  const { run, pending, result } = useCsrfAction();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newHidden, setNewHidden] = useState(false);
  const [titleError, setTitleError] = useState<string | undefined>();

  const move = async (index: number, delta: -1 | 1) => {
    const ids = sections.map((s) => s.id);
    const target = index + delta;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    if (await run((csrf) => api.reorderSections(courseId, ids, csrf), () => c.orderSaved)) onChanged();
  };
  const update = async (section: Section, body: { title?: string; isVisible?: boolean }) => {
    const updated = await run((csrf) => api.updateSection(courseId, section.id, body, csrf), (value) => c.sectionSaved(value.title));
    if (updated) {
      setRenaming(null);
      onChanged();
    }
  };
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newTitle.trim()) return setTitleError(c.titleRequired);
    setTitleError(undefined);
    const created = await run((csrf) => api.createSection(courseId, { title: newTitle.trim(), isVisible: !newHidden }, csrf), (value) => c.sectionAdded(value.title));
    if (created) {
      setNewTitle('');
      setNewHidden(false);
      onChanged();
    }
  };

  return (
    <Card as="section" aria-labelledby="sections-heading" className="space-y-4">
      <div>
        <h2 id="sections-heading" className="text-lg font-semibold text-brand-600">
          {c.sectionsTitle}
        </h2>
        <p className="text-sm text-slate-600">{c.sectionsIntro}</p>
      </div>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      {sections.length === 0 ? (
        <p className="text-sm text-slate-600">{c.noSections}</p>
      ) : (
        <ol className="divide-y divide-slate-100 rounded-lg border border-slate-200" aria-label={c.sectionsTitle}>
          {sections.map((section, index) => (
            <li key={section.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                {renaming === section.id ? (
                  <form
                    noValidate
                    className="flex flex-col gap-2 sm:flex-row sm:items-end"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (renameValue.trim()) void update(section, { title: renameValue.trim() });
                    }}
                  >
                    <TextField id={`rename-${section.id}`} label={c.sectionTitle} value={renameValue} maxLength={200} onChange={(e) => setRenameValue(e.target.value)} />
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" disabled={pending || !renameValue.trim()}>
                        {c.saveTitle}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                        {c.cancel}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <p className="font-medium break-words text-slate-900">
                    <span className="text-slate-500">{c.position(index + 1)}</span> {section.title}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <Badge tone={section.isVisible ? 'success' : 'neutral'}>{section.isVisible ? c.visible : c.hidden}</Badge>
                  <span>{c.activities(section.activityCount, section.studentVisibleActivityCount)}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Button size="sm" variant="secondary" disabled={pending || index === 0} onClick={() => void move(index, -1)}>
                  {c.moveUp}
                  <span className="sr-only">: {section.title}</span>
                </Button>
                <Button size="sm" variant="secondary" disabled={pending || index === sections.length - 1} onClick={() => void move(index, 1)}>
                  {c.moveDown}
                  <span className="sr-only">: {section.title}</span>
                </Button>
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => void update(section, { isVisible: !section.isVisible })}>
                  {section.isVisible ? c.hide : c.show}
                  <span className="sr-only">: {section.title}</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setRenaming(section.id);
                    setRenameValue(section.title);
                  }}
                >
                  {c.rename}
                  <span className="sr-only">: {section.title}</span>
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <form noValidate onSubmit={add} aria-labelledby="add-section-heading" className="space-y-3 border-t border-slate-200 pt-4">
        <h3 id="add-section-heading" className="font-semibold text-slate-900">
          {c.addSectionTitle}
        </h3>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <TextField id="new-section-title" className="min-w-0 flex-1" label={c.newSectionTitle} value={newTitle} maxLength={200} onChange={(e) => setNewTitle(e.target.value)} error={titleError} />
          <Button type="submit" disabled={pending}>
            {c.addSection}
          </Button>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={newHidden} onChange={(e) => setNewHidden(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
          {c.addHidden}
        </label>
      </form>
    </Card>
  );
}

function RosterCard({ courseId, counts, onChanged }: { courseId: string; counts: CourseLifecycle['enrollmentCounts']; onChanged: () => void }) {
  const { t, locale } = useLocale();
  const c = t.courseAdmin;
  const { handleUnauthorized } = useSession();
  const { run, pending, result } = useCsrfAction();
  const [roster, setRoster] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: Enrollment[] }>({ status: 'loading' });
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<CourseRole>('student');
  const [emailError, setEmailError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      setRoster({ status: 'ready', items: await loadAll((page) => api.listEnrollments(courseId, page)) });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setRoster({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [courseId, handleUnauthorized, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    await load();
    onChanged();
  };
  const setStatus = async (enrollment: Enrollment, status: 'active' | 'inactive') => {
    if (await run((csrf) => api.updateEnrollment(courseId, enrollment.id, { status }, csrf), () => c.enrollmentUpdated(enrollment.user.email))) await refresh();
  };
  const remove = async (enrollment: Enrollment) => {
    const removed = await run(
      async (csrf) => {
        await api.deleteEnrollment(courseId, enrollment.id, csrf);
        return true;
      },
      () => c.enrollmentRemoved(enrollment.user.email),
    );
    setConfirmingRemoval(null);
    if (removed) await refresh();
  };
  const enroll = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!EMAIL_PATTERN.test(email.trim())) return setEmailError(c.emailInvalid);
    setEmailError(undefined);
    const created = await run((csrf) => api.createEnrollment(courseId, { email: email.trim(), role }, csrf), (value) => c.enrolled(value.user.email));
    if (created) {
      setEmail('');
      await refresh();
    }
  };

  return (
    <Card as="section" aria-labelledby="roster-heading" className="space-y-4">
      <div>
        <h2 id="roster-heading" className="text-lg font-semibold text-brand-600">
          {c.rosterTitle}
        </h2>
        <p className="text-sm text-slate-600">{c.rosterIntro}</p>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4" aria-label={c.roleCounts}>
        {counts.map((entry) => (
          <div key={entry.role} className="rounded-lg bg-slate-50 px-3 py-2">
            <dt className="font-medium text-slate-800">{t.roles[entry.role]}</dt>
            <dd className="text-slate-600">{c.activeInactive(entry.active, entry.inactive)}</dd>
          </div>
        ))}
      </dl>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      {roster.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          {t.common.loading}
        </p>
      ) : roster.status === 'error' ? (
        <Alert tone="error">{roster.message}</Alert>
      ) : roster.items.length === 0 ? (
        <p className="text-sm text-slate-600">{c.noEnrollments}</p>
      ) : (
        <div className={`${tableClasses.wrapper} relative`}>
          <table className={tableClasses.table}>
            <thead className={tableClasses.head}>
              <tr>
                <th scope="col" className={tableClasses.th}>{c.name}</th>
                <th scope="col" className={tableClasses.th}>{c.role}</th>
                <th scope="col" className={tableClasses.th}>{c.status}</th>
                <th scope="col" className={tableClasses.th}>{c.actions}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {roster.items.map((enrollment) => {
                const active = enrollment.status === 'active';
                return (
                  <tr key={enrollment.id} className={tableClasses.row}>
                    <td className={`${tableClasses.td} min-w-48`}>
                      <Link href={`/admin/users/${enrollment.user.id}`} className="font-medium text-brand-700 hover:underline">
                        {enrollment.user.givenName} {enrollment.user.familyName}
                      </Link>
                      <div className="text-xs break-all text-slate-500">{enrollment.user.email}</div>
                    </td>
                    <td className={`${tableClasses.td} whitespace-nowrap`}>{t.roles[enrollment.role]}</td>
                    <td className={tableClasses.td}>
                      <Badge tone={active ? 'success' : 'neutral'}>{active ? t.status.active : t.status.inactive}</Badge>
                    </td>
                    <td className={tableClasses.td}>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" className="whitespace-nowrap" disabled={pending} onClick={() => void setStatus(enrollment, active ? 'inactive' : 'active')}>
                          {active ? c.setInactive : c.setActive}
                          <span className="sr-only">: {enrollment.user.email}</span>
                        </Button>
                        {confirmingRemoval === enrollment.id ? (
                          <>
                            <Button size="sm" className="whitespace-nowrap" disabled={pending} onClick={() => void remove(enrollment)}>
                              {c.confirmRemove}
                              <span className="sr-only">: {enrollment.user.email}</span>
                            </Button>
                            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmingRemoval(null)}>
                              {c.cancel}
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="ghost" className="whitespace-nowrap" disabled={pending} onClick={() => setConfirmingRemoval(enrollment.id)}>
                            {c.remove}
                            <span className="sr-only">: {enrollment.user.email}</span>
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <form noValidate onSubmit={enroll} aria-labelledby="course-enroll-heading" className="grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
        <h3 id="course-enroll-heading" className="font-semibold text-slate-900 sm:col-span-3">
          {c.enrollTitle}
        </h3>
        <TextField id="course-enroll-email" label={c.email} type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={emailError} />
        <SelectField
          id="course-enroll-role"
          label={c.courseRole}
          value={role}
          onChange={(e) => setRole(e.target.value as CourseRole)}
          options={ROLES.map((value) => ({ value, label: t.roles[value] }))}
        />
        <Button type="submit" disabled={pending}>
          {c.enroll}
        </Button>
      </form>
    </Card>
  );
}
