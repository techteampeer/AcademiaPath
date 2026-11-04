'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { LocalizedCourseStatusBadge as CourseStatusBadge } from '@/components/courses/LocalizedCourseStatusBadge';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingCards } from '@/components/ui/Skeleton';
import { tableClasses } from '@/components/ui/table';
import { isApiError } from '@/lib/api/client';
import { api, loadAll } from '@/lib/api/endpoints';
import type { Course, CourseRole, Enrollment } from '@/lib/api/types';
import { useAdminRecords } from './AdminOverview';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES: CourseRole[] = ['student', 'instructor', 'non_editing_instructor', 'design_team'];

export function CoursesAdmin() {
  return <RequireAuth role="administrator">{() => <CoursesContent />}</RequireAuth>;
}

function CoursesContent() {
  const { t } = useLocale();
  const { state, load } = useAdminRecords();
  const [termId, setTermId] = useState('');
  const [programId, setProgramId] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Course | null>(null);

  const header = (
    <PageHeader
      breadcrumbs={[{ label: t.nav.adminOverview, href: '/admin' }, { label: t.admin.coursesTitle }]}
      breadcrumbLabel={t.common.breadcrumb}
      title={t.admin.coursesTitle}
      description={t.admin.coursesIntro}
      actions={
        <Link href="/admin/setup" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
          {t.admin.setup}
        </Link>
      }
    />
  );

  const data = state.status === 'ready' ? state.data : null;
  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    return data.courses.filter(
      (course) =>
        (!termId || course.termId === termId) &&
        (!programId || course.programId === programId) &&
        (!status || course.status === status) &&
        (!needle || course.code.toLowerCase().includes(needle) || course.title.toLowerCase().includes(needle)),
    );
  }, [data, termId, programId, status, query]);

  if (state.status === 'loading') return <div className="space-y-6">{header}<LoadingCards label={t.common.loading} /></div>;
  if (state.status === 'error' || !data) {
    return (
      <div className="space-y-6">
        {header}
        <Alert tone="error">
          {t.common.loadError}{' '}
          <button type="button" className="font-medium underline" onClick={() => void load()}>
            {t.common.retry}
          </button>
        </Alert>
      </div>
    );
  }
  const termCode = (id: string) => data.terms.find((term) => term.id === id)?.code ?? '—';
  const programName = (id: string | null) => data.programs.find((program) => program.id === id)?.name ?? '—';

  return (
    <div className="space-y-6">
      {header}
      <Card className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField id="course-search" label={t.common.search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ITIL" />
        <SelectField
          id="course-term"
          label={t.admin.filterTerm}
          value={termId}
          onChange={(e) => setTermId(e.target.value)}
          options={[{ value: '', label: t.common.all }, ...[...data.terms].sort((a, b) => b.code.localeCompare(a.code)).map((term) => ({ value: term.id, label: term.code }))]}
        />
        <SelectField
          id="course-program"
          label={t.admin.filterProgram}
          value={programId}
          onChange={(e) => setProgramId(e.target.value)}
          options={[{ value: '', label: t.common.all }, ...data.programs.map((program) => ({ value: program.id, label: program.name }))]}
        />
        <SelectField
          id="course-status"
          label={t.admin.filterStatus}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: '', label: t.common.all },
            { value: 'published', label: t.status.published },
            { value: 'draft', label: t.status.draft },
            { value: 'archived', label: t.status.archived },
          ]}
        />
      </Card>
      <p className="text-sm text-slate-500" aria-live="polite">
        {t.common.showing(filtered.length, data.courses.length)}
      </p>
      {filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-600">{t.admin.noCourses}</p>
      ) : (
        <div className={tableClasses.wrapper}>
          <table className={tableClasses.table}>
            <thead className={tableClasses.head}>
              <tr>
                <th scope="col" className={tableClasses.th}>{t.admin.code}</th>
                <th scope="col" className={tableClasses.th}>{t.admin.titleCol}</th>
                <th scope="col" className={tableClasses.th}>{t.admin.term}</th>
                <th scope="col" className={tableClasses.th}>{t.admin.program}</th>
                <th scope="col" className={tableClasses.th}>{t.admin.status}</th>
                <th scope="col" className={tableClasses.th}>{t.admin.actions}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((course) => (
                <tr key={course.id} className={tableClasses.row}>
                  <td className={`${tableClasses.td} font-medium whitespace-nowrap text-slate-900`}>{course.code}</td>
                  <td className={tableClasses.td}>{course.title}</td>
                  <td className={`${tableClasses.td} whitespace-nowrap`}>{termCode(course.termId)}</td>
                  <td className={tableClasses.td}>{programName(course.programId)}</td>
                  <td className={tableClasses.td}>
                    <CourseStatusBadge status={course.status} />
                  </td>
                  <td className={tableClasses.td}>
                    <div className="flex flex-wrap gap-2">
                      <Link href={`/courses/${course.id}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
                        {t.common.open}
                        <span className="sr-only"> {course.code}</span>
                      </Link>
                      <Button variant={selected?.id === course.id ? 'primary' : 'ghost'} size="sm" onClick={() => setSelected(course)}>
                        {t.admin.enrollments}
                        <span className="sr-only"> {course.code}</span>
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected ? <EnrollmentPanel key={selected.id} course={selected} /> : null}
    </div>
  );
}

/** Existing enrollment API: list the roster and enroll an existing account by email with a course role. */
function EnrollmentPanel({ course }: { course: Course }) {
  const { t } = useLocale();
  const { handleUnauthorized } = useSession();
  const [roster, setRoster] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: Enrollment[] }>({ status: 'loading' });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<CourseRole>('student');
  const [emailError, setEmailError] = useState<string | undefined>();
  const { run, pending, result } = useCsrfAction();

  const load = useCallback(async () => {
    try {
      setRoster({ status: 'ready', items: await loadAll((page) => api.listEnrollments(course.id, page)) });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setRoster({ status: 'error', message: describeApiError(error) });
    }
  }, [course.id, handleUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const enroll = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!EMAIL_PATTERN.test(email.trim())) return setEmailError(t.admin.emailInvalid);
    setEmailError(undefined);
    const created = await run((csrf) => api.createEnrollment(course.id, { email: email.trim(), role }, csrf), (e) => t.admin.enrolled(e.user.email));
    if (created) {
      setEmail('');
      await load();
    }
  };

  return (
    <Card as="section" aria-labelledby="enrollments-heading" className="space-y-4">
      <h2 id="enrollments-heading" className="text-lg font-semibold text-slate-900">
        {t.admin.enrollmentsFor(course.code)}
      </h2>
      {roster.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          {t.common.loading}
        </p>
      ) : roster.status === 'error' ? (
        <Alert tone="error">{roster.message}</Alert>
      ) : roster.items.length === 0 ? (
        <p className="text-sm text-slate-600">{t.admin.noEnrollments}</p>
      ) : (
        <div className={tableClasses.wrapper}>
          <table className={tableClasses.table}>
            <thead className={tableClasses.head}>
              <tr>
                <th scope="col" className={tableClasses.th}>{t.admin.name}</th>
                <th scope="col" className={tableClasses.th}>{t.login.email}</th>
                <th scope="col" className={tableClasses.th}>{t.admin.role}</th>
                <th scope="col" className={tableClasses.th}>{t.admin.status}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {roster.items.map((enrollment) => (
                <tr key={enrollment.id}>
                  <td className={tableClasses.td}>
                    {enrollment.user.givenName} {enrollment.user.familyName}
                  </td>
                  <td className={`${tableClasses.td} break-all`}>{enrollment.user.email}</td>
                  <td className={tableClasses.td}>{t.roles[enrollment.role]}</td>
                  <td className={tableClasses.td}>{enrollment.status === 'active' ? t.status.active : t.status.inactive}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form noValidate onSubmit={enroll} className="grid gap-4 border-t border-slate-200 pt-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end" aria-labelledby="enroll-heading">
        <h3 id="enroll-heading" className="font-semibold text-slate-900 sm:col-span-3">
          {t.admin.enrollUser}
        </h3>
        <TextField id="enroll-email" label={t.admin.userEmail} type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={emailError} />
        <SelectField
          id="enroll-role"
          label={t.admin.courseRole}
          value={role}
          onChange={(e) => setRole(e.target.value as CourseRole)}
          options={ROLES.map((value) => ({ value, label: t.roles[value] }))}
        />
        <Button type="submit" disabled={pending}>
          {pending ? t.common.loading : t.admin.enroll}
        </Button>
        {result ? (
          <div className="sm:col-span-3">
            <Alert tone={result.tone}>{result.message}</Alert>
          </div>
        ) : null}
      </form>
    </Card>
  );
}
