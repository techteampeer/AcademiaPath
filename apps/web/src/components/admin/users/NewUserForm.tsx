'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { Alert } from '@/components/ui/Alert';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import type { CourseRole, UserCreateResult } from '@/lib/api/types';
import { api } from '@/lib/api/endpoints';
import { ActivationLinkPanel, COURSE_ROLES, courseLabel, EMAIL_PATTERN, useAllCourses, useUserAction } from './userShared';

type RoleRow = { key: number; courseId: string; role: CourseRole };
type Errors = Partial<Record<'givenName' | 'familyName' | 'email', string>> & { rows?: Record<number, string> };

export function NewUserForm() {
  return <RequireAuth role="administrator">{() => <NewUserContent />}</RequireAuth>;
}

function NewUserContent() {
  const { t } = useLocale();
  const { courses } = useAllCourses();
  const { run, pending, result, errorCode } = useUserAction();
  const [givenName, setGivenName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [email, setEmail] = useState('');
  const [preferredLocale, setPreferredLocale] = useState<'es' | 'en'>('es');
  const [systemRole, setSystemRole] = useState<'user' | 'administrator'>('user');
  const [rows, setRows] = useState<RoleRow[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [errors, setErrors] = useState<Errors>({});
  const [created, setCreated] = useState<UserCreateResult | null>(null);

  const validate = (): Errors => {
    const found: Errors = {};
    if (!givenName.trim()) found.givenName = t.users.givenNameRequired;
    if (!familyName.trim()) found.familyName = t.users.familyNameRequired;
    if (!EMAIL_PATTERN.test(email.trim())) found.email = t.users.emailInvalid;
    const rowErrors: Record<number, string> = {};
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.courseId) rowErrors[row.key] = t.users.courseRequired;
      else if (seen.has(row.courseId)) rowErrors[row.key] = t.users.duplicateCourse;
      seen.add(row.courseId);
    }
    if (Object.keys(rowErrors).length) found.rows = rowErrors;
    return found;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    const value = await run(
      (csrf) =>
        api.createUser(
          {
            email: email.trim(),
            givenName: givenName.trim(),
            familyName: familyName.trim(),
            systemRole,
            preferredLocale,
            enrollments: rows.map(({ courseId, role }) => ({ courseId, role })),
          },
          csrf,
        ),
      (value) => t.users.created(value.user.email),
    );
    if (value) setCreated(value);
  };

  const reset = () => {
    setCreated(null);
    setGivenName('');
    setFamilyName('');
    setEmail('');
    setSystemRole('user');
    setRows([]);
    setErrors({});
  };

  const header = (
    <PageHeader
      breadcrumbs={[
        { label: t.nav.adminOverview, href: '/admin' },
        { label: t.users.title, href: '/admin/users' },
        { label: t.users.newTitle },
      ]}
      breadcrumbLabel={t.common.breadcrumb}
      title={t.users.newTitle}
      description={t.users.newIntro}
    />
  );

  if (created) {
    return (
      <div className="space-y-6">
        {header}
        <Card className="space-y-4">
          {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
          {created.invitation ? (
            <ActivationLinkPanel invitation={created.invitation} />
          ) : (
            <Alert tone="info">{created.invitationStatus === 'disabled' ? t.users.linkDisabled : t.users.linkSyntheticOnly}</Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Link href={`/admin/users/${created.user.id}`} className={buttonClasses()}>
              {t.users.openUser}
            </Link>
            <Button variant="secondary" onClick={reset}>
              {t.users.createAnother}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const courseOptions = courses.status === 'ready' ? courses.items : [];
  return (
    <div className="space-y-6">
      {header}
      <Card>
        <form noValidate onSubmit={submit} aria-labelledby="new-user-heading" className="space-y-6">
          <h2 id="new-user-heading" className="sr-only">
            {t.users.newTitle}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField id="new-given-name" label={t.users.givenName} value={givenName} maxLength={100} autoComplete="off" onChange={(e) => setGivenName(e.target.value)} error={errors.givenName} />
            <TextField id="new-family-name" label={t.users.familyName} value={familyName} maxLength={100} autoComplete="off" onChange={(e) => setFamilyName(e.target.value)} error={errors.familyName} />
            <TextField
              id="new-email"
              className="sm:col-span-2"
              label={t.users.email}
              type="email"
              value={email}
              maxLength={254}
              autoComplete="off"
              onChange={(e) => setEmail(e.target.value)}
              error={errors.email ?? (errorCode === 'EMAIL_TAKEN' ? t.users.errors.EMAIL_TAKEN : undefined)}
            />
            <SelectField
              id="new-locale"
              label={t.users.preferredLanguage}
              value={preferredLocale}
              onChange={(e) => setPreferredLocale(e.target.value as 'es' | 'en')}
              options={[
                { value: 'es', label: t.users.languageEs },
                { value: 'en', label: t.users.languageEn },
              ]}
            />
            <SelectField
              id="new-system-role"
              label={t.users.systemRole}
              hint={t.users.systemRoleHint}
              value={systemRole}
              onChange={(e) => setSystemRole(e.target.value as 'user' | 'administrator')}
              options={[
                { value: 'user', label: t.roles.user },
                { value: 'administrator', label: t.roles.administrator },
              ]}
            />
          </div>

          <fieldset className="space-y-3 border-t border-slate-200 pt-4">
            <legend className="font-semibold text-slate-900">{t.users.initialRoles}</legend>
            <p className="text-sm text-slate-600">{t.users.initialRolesHint}</p>
            {courses.status === 'error' ? <Alert tone="error">{t.common.loadError}</Alert> : null}
            {rows.map((row, index) => (
              <div key={row.key} className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
                <SelectField
                  id={`new-course-${row.key}`}
                  label={`${t.users.course} ${index + 1}`}
                  value={row.courseId}
                  error={errors.rows?.[row.key]}
                  onChange={(e) => setRows((all) => all.map((r) => (r.key === row.key ? { ...r, courseId: e.target.value } : r)))}
                  options={[{ value: '', label: t.users.selectCourse }, ...courseOptions.map((course) => ({ value: course.id, label: courseLabel(course) }))]}
                />
                <SelectField
                  id={`new-role-${row.key}`}
                  label={`${t.users.courseRole} ${index + 1}`}
                  value={row.role}
                  onChange={(e) => setRows((all) => all.map((r) => (r.key === row.key ? { ...r, role: e.target.value as CourseRole } : r)))}
                  options={COURSE_ROLES.map((role) => ({ value: role, label: t.roles[role] }))}
                />
                <Button variant="ghost" onClick={() => setRows((all) => all.filter((r) => r.key !== row.key))}>
                  {t.users.removeCourseRole}
                  <span className="sr-only"> {index + 1}</span>
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              disabled={courses.status !== 'ready' || rows.length >= 20}
              onClick={() => {
                setRows((all) => [...all, { key: nextKey, courseId: '', role: 'student' }]);
                setNextKey((key) => key + 1);
              }}
            >
              {t.users.addCourseRole}
            </Button>
          </fieldset>

          {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={pending}>
              {pending ? t.users.creating : t.users.create}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
