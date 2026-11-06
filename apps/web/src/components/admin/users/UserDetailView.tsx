'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingCards } from '@/components/ui/Skeleton';
import { tableClasses } from '@/components/ui/table';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { AccountInvitation, CourseRole, CurrentUser, UserDetail, UserEnrollment, UserUpdate } from '@/lib/api/types';
import { formatDateTime } from '@/lib/i18n/messages';
import {
  AccountStatusBadge,
  ActivationBadge,
  ActivationLinkPanel,
  COURSE_ROLES,
  courseLabel,
  EMAIL_PATTERN,
  SystemRoleBadge,
  useAllCourses,
  useErrorMessage,
  useUserAction,
} from './userShared';

export function UserDetailView({ userId }: { userId: string }) {
  return <RequireAuth role="administrator">{(viewer) => <DetailContent userId={userId} viewer={viewer} />}</RequireAuth>;
}

function DetailContent({ userId, viewer }: { userId: string; viewer: CurrentUser }) {
  const { t } = useLocale();
  const { handleUnauthorized } = useSession();
  const errorMessage = useErrorMessage();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'missing' } | { status: 'error'; message: string } | { status: 'ready'; user: UserDetail }>({
    status: 'loading',
  });

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', user: await api.getUser(userId) });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState(isApiError(error, 404) || isApiError(error, 400) ? { status: 'missing' } : { status: 'error', message: errorMessage(error) });
    }
  }, [userId, handleUnauthorized, errorMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  const crumbs = [
    { label: t.nav.adminOverview, href: '/admin' },
    { label: t.users.title, href: '/admin/users' },
  ];
  if (state.status === 'loading') return <LoadingCards label={t.users.loadingUser} count={3} />;
  if (state.status === 'missing') return <EmptyState titleAs="h1" title={t.users.notFoundTitle} description={t.users.notFoundDescription} />;
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

  const user = state.user;
  const isSelf = user.id === viewer.id;
  const setUser = (next: UserDetail) => setState({ status: 'ready', user: next });
  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[...crumbs, { label: `${user.givenName} ${user.familyName}` }]}
        breadcrumbLabel={t.common.breadcrumb}
        title={`${user.givenName} ${user.familyName}`}
        description={<span className="break-all">{user.email}</span>}
        actions={
          <div className="flex flex-wrap gap-1">
            <SystemRoleBadge role={user.systemRole} />
            <AccountStatusBadge isActive={user.isActive} />
            <ActivationBadge state={user.activationState} />
          </div>
        }
      />
      {isSelf ? <Alert tone="info">{t.users.ownAccount}</Alert> : null}
      <div className="grid gap-6 lg:grid-cols-2">
        <DetailsForm key={user.updatedAt} user={user} isSelf={isSelf} onSaved={setUser} />
        <div className="space-y-6">
          <StatusCard user={user} isSelf={isSelf} onChanged={setUser} />
          <ActivationCard user={user} onIssued={() => void load()} />
        </div>
      </div>
      <EnrollmentsCard user={user} onChanged={() => void load()} />
    </div>
  );
}

function DetailsForm({ user, isSelf, onSaved }: { user: UserDetail; isSelf: boolean; onSaved: (user: UserDetail) => void }) {
  const { t } = useLocale();
  const { run, pending, result, errorCode } = useUserAction();
  const [givenName, setGivenName] = useState(user.givenName);
  const [familyName, setFamilyName] = useState(user.familyName);
  const [email, setEmail] = useState(user.email);
  const [preferredLocale, setPreferredLocale] = useState(user.preferredLocale);
  const [systemRole, setSystemRole] = useState(user.systemRole);
  const [errors, setErrors] = useState<Partial<Record<'givenName' | 'familyName' | 'email', string>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const emailEditable = user.activationState === 'pending';

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(null);
    const found: typeof errors = {};
    if (!givenName.trim()) found.givenName = t.users.givenNameRequired;
    if (!familyName.trim()) found.familyName = t.users.familyNameRequired;
    if (emailEditable && !EMAIL_PATTERN.test(email.trim())) found.email = t.users.emailInvalid;
    setErrors(found);
    if (Object.keys(found).length) return;
    const changes: UserUpdate = {};
    if (givenName.trim() !== user.givenName) changes.givenName = givenName.trim();
    if (familyName.trim() !== user.familyName) changes.familyName = familyName.trim();
    if (emailEditable && email.trim().toLowerCase() !== user.email) changes.email = email.trim();
    if (preferredLocale !== user.preferredLocale) changes.preferredLocale = preferredLocale;
    if (!isSelf && systemRole !== user.systemRole) changes.systemRole = systemRole;
    if (Object.keys(changes).length === 0) return setNotice(t.users.noChanges);
    const updated = await run((csrf) => api.updateUser(user.id, changes, csrf), () => t.users.saved);
    if (updated) onSaved(updated);
  };

  return (
    <Card as="section" aria-labelledby="details-heading">
      <form noValidate onSubmit={submit} className="space-y-4">
        <h2 id="details-heading" className="text-lg font-semibold text-slate-900">
          {t.users.detailsTitle}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField id="edit-given-name" label={t.users.givenName} value={givenName} maxLength={100} onChange={(e) => setGivenName(e.target.value)} error={errors.givenName} />
          <TextField id="edit-family-name" label={t.users.familyName} value={familyName} maxLength={100} onChange={(e) => setFamilyName(e.target.value)} error={errors.familyName} />
        </div>
        <TextField
          id="edit-email"
          label={t.users.email}
          type="email"
          value={email}
          maxLength={254}
          disabled={!emailEditable}
          hint={emailEditable ? t.users.emailPendingHint : t.users.emailLockedHint}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email ?? (errorCode === 'EMAIL_TAKEN' ? t.users.errors.EMAIL_TAKEN : undefined)}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="edit-locale"
            label={t.users.preferredLanguage}
            value={preferredLocale}
            onChange={(e) => setPreferredLocale(e.target.value as 'es' | 'en')}
            options={[
              { value: 'es', label: t.users.languageEs },
              { value: 'en', label: t.users.languageEn },
            ]}
          />
          <SelectField
            id="edit-system-role"
            label={t.users.systemRole}
            value={systemRole}
            disabled={isSelf}
            hint={t.users.systemRoleHint}
            onChange={(e) => setSystemRole(e.target.value as 'user' | 'administrator')}
            options={[
              { value: 'user', label: t.roles.user },
              { value: 'administrator', label: t.roles.administrator },
            ]}
          />
        </div>
        {notice ? <Alert tone="info">{notice}</Alert> : null}
        {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={pending}>
            {pending ? t.users.saving : t.users.saveChanges}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function StatusCard({ user, isSelf, onChanged }: { user: UserDetail; isSelf: boolean; onChanged: (user: UserDetail) => void }) {
  const { t } = useLocale();
  const { run, pending, result } = useUserAction();
  const [confirming, setConfirming] = useState(false);
  const name = `${user.givenName} ${user.familyName}`;

  const deactivate = async () => {
    const updated = await run((csrf) => api.deactivateUser(user.id, csrf), () => t.users.deactivated);
    setConfirming(false);
    if (updated) onChanged(updated);
  };
  const reactivate = async () => {
    const updated = await run((csrf) => api.reactivateUser(user.id, csrf), () => t.users.reactivated);
    if (updated) onChanged(updated);
  };

  return (
    <Card as="section" aria-labelledby="status-heading" className="space-y-3">
      <h2 id="status-heading" className="text-lg font-semibold text-slate-900">
        {t.users.accountTitle}
      </h2>
      <p className="text-sm text-slate-700">{user.isActive ? t.users.activeExplanation : t.users.inactiveExplanation}</p>
      {user.isActive ? (
        confirming ? (
          <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-sm text-red-800">{t.users.deactivateWarning(name)}</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void deactivate()} disabled={pending}>
                {t.users.confirmDeactivate}
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="secondary" disabled={isSelf || pending} onClick={() => setConfirming(true)}>
            {t.users.deactivate}
          </Button>
        )
      ) : (
        <Button variant="secondary" disabled={pending} onClick={() => void reactivate()}>
          {t.users.reactivate}
        </Button>
      )}
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
    </Card>
  );
}

function ActivationCard({ user, onIssued }: { user: UserDetail; onIssued: () => void }) {
  const { t, locale } = useLocale();
  const { run, pending, result } = useUserAction();
  const [invitation, setInvitation] = useState<AccountInvitation | null>(null);
  const { activation } = user;
  const invite = async () => {
    const issued = await run((csrf) => api.issueInvitation(user.id, csrf));
    if (issued) {
      setInvitation(issued);
      onIssued();
    }
  };

  let text: string;
  if (activation.state === 'activated') text = t.users.activatedOn(formatDateTime(activation.activatedAt ?? user.createdAt, locale));
  else if (!activation.pendingInvitation) text = t.users.pendingNoLink;
  else if (activation.pendingInvitation.expired) text = t.users.pendingExpired(formatDateTime(activation.pendingInvitation.expiresAt, locale));
  else text = t.users.pendingLink(formatDateTime(activation.pendingInvitation.expiresAt, locale));

  return (
    <Card as="section" aria-labelledby="activation-heading" className="space-y-3">
      <h2 id="activation-heading" className="text-lg font-semibold text-slate-900">
        {t.users.activationTitle}
      </h2>
      <p className="text-sm text-slate-700">{text}</p>
      {activation.state === 'pending' ? (
        user.isActive ? (
          <div className="space-y-1">
            <Button variant="secondary" disabled={pending} onClick={() => void invite()}>
              {t.users.newLink}
            </Button>
            <p className="text-xs text-slate-500">{t.users.newLinkHint}</p>
          </div>
        ) : (
          <p className="text-sm text-slate-600">{t.users.inactiveNoLink}</p>
        )
      ) : null}
      {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
      {invitation ? <ActivationLinkPanel invitation={invitation} /> : null}
    </Card>
  );
}

function EnrollmentsCard({ user, onChanged }: { user: UserDetail; onChanged: () => void }) {
  const { t } = useLocale();
  const { courses } = useAllCourses();
  const add = useUserAction();
  const [courseId, setCourseId] = useState('');
  const [role, setRole] = useState<CourseRole>('student');
  const available = useMemo(() => {
    const taken = new Set(user.enrollments.map((e) => e.courseId));
    return courses.status === 'ready' ? courses.items.filter((course) => !taken.has(course.id)) : [];
  }, [courses, user.enrollments]);

  const enroll = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const course = available.find((c) => c.id === courseId);
    if (!course) return;
    const created = await add.run((csrf) => api.createEnrollment(course.id, { userId: user.id, role }, csrf), () => t.users.enrolled(course.code));
    if (created) {
      setCourseId('');
      onChanged();
    }
  };

  return (
    <Card as="section" aria-labelledby="enrollments-heading" className="space-y-4">
      <div>
        <h2 id="enrollments-heading" className="text-lg font-semibold text-slate-900">
          {t.users.enrollmentsTitle}
        </h2>
        <p className="text-sm text-slate-600">{t.users.initialRolesHint}</p>
      </div>
      {user.enrollments.length === 0 ? (
        <p className="text-sm text-slate-600">{t.users.noEnrollments}</p>
      ) : (
        // `relative` keeps the visually hidden labels inside the scroll container on narrow screens.
        <div className={`${tableClasses.wrapper} relative`}>
          <table className={tableClasses.table}>
            <thead className={tableClasses.head}>
              <tr>
                <th scope="col" className={tableClasses.th}>{t.users.course}</th>
                <th scope="col" className={tableClasses.th}>{t.users.term}</th>
                <th scope="col" className={tableClasses.th}>{t.users.role}</th>
                <th scope="col" className={tableClasses.th}>{t.users.enrollmentStatus}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {user.enrollments.map((enrollment) => (
                <EnrollmentRow key={`${enrollment.id}-${enrollment.role}-${enrollment.status}`} enrollment={enrollment} onChanged={onChanged} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form noValidate onSubmit={enroll} aria-labelledby="add-enrollment-heading" className="grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
        <h3 id="add-enrollment-heading" className="font-semibold text-slate-900 sm:col-span-3">
          {t.users.addEnrollmentTitle}
        </h3>
        {courses.status === 'ready' && available.length === 0 ? (
          <p className="text-sm text-slate-600 sm:col-span-3">{t.users.allEnrolled}</p>
        ) : (
          <>
            <SelectField
              id="add-enrollment-course"
              label={t.users.course}
              value={courseId}
              disabled={!user.isActive}
              onChange={(e) => setCourseId(e.target.value)}
              options={[{ value: '', label: t.users.selectCourse }, ...available.map((course) => ({ value: course.id, label: courseLabel(course) }))]}
            />
            <SelectField
              id="add-enrollment-role"
              label={t.users.courseRole}
              value={role}
              disabled={!user.isActive}
              onChange={(e) => setRole(e.target.value as CourseRole)}
              options={COURSE_ROLES.map((value) => ({ value, label: t.roles[value] }))}
            />
            <Button type="submit" disabled={add.pending || !courseId || !user.isActive}>
              {t.users.enroll}
            </Button>
          </>
        )}
        {add.result ? (
          <div className="sm:col-span-3">
            <Alert tone={add.result.tone}>{add.result.message}</Alert>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

function EnrollmentRow({ enrollment, onChanged }: { enrollment: UserEnrollment; onChanged: () => void }) {
  const { t } = useLocale();
  const { run, pending, result } = useUserAction();
  const [role, setRole] = useState<CourseRole>(enrollment.role);
  const save = async (body: { role?: CourseRole; status?: 'active' | 'inactive' }) => {
    const updated = await run((csrf) => api.updateEnrollment(enrollment.courseId, enrollment.id, body, csrf), () => t.users.enrollmentSaved(enrollment.courseCode));
    if (updated) onChanged();
  };
  const active = enrollment.status === 'active';
  return (
    <tr className={tableClasses.row}>
      <td className={`${tableClasses.td} min-w-36`}>
        <div className="font-medium text-slate-900">{enrollment.courseCode}</div>
        <div className="text-xs text-slate-500">{enrollment.courseTitle}</div>
      </td>
      <td className={`${tableClasses.td} whitespace-nowrap`}>{enrollment.termCode}</td>
      <td className={tableClasses.td}>
        <div className="flex flex-wrap items-end gap-2">
          <SelectField
            id={`role-${enrollment.id}`}
            label={t.users.roleFor(enrollment.courseCode)}
            className="min-w-40 [&>label]:sr-only"
            value={role}
            onChange={(e) => setRole(e.target.value as CourseRole)}
            options={COURSE_ROLES.map((value) => ({ value, label: t.roles[value] }))}
          />
          <Button size="sm" variant="secondary" className="whitespace-nowrap" disabled={pending || role === enrollment.role} onClick={() => void save({ role })}>
            {t.users.saveRole}
            <span className="sr-only"> {enrollment.courseCode}</span>
          </Button>
        </div>
        {result?.tone === 'error' ? <p className="mt-1 text-sm text-red-700" role="alert">{result.message}</p> : null}
      </td>
      <td className={tableClasses.td}>
        <div className="flex flex-col items-start gap-2">
          <Badge tone={active ? 'success' : 'neutral'}>{active ? t.status.active : t.status.inactive}</Badge>
          <Button size="sm" variant="ghost" className="whitespace-nowrap" disabled={pending} onClick={() => void save({ status: active ? 'inactive' : 'active' })}>
            {active ? t.users.setInactive : t.users.setActive}
            <span className="sr-only"> {enrollment.courseCode}</span>
          </Button>
        </div>
      </td>
    </tr>
  );
}
