'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useWorkspace } from '@/components/session/WorkspaceProvider';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { CourseEmblem } from '@/components/layout/Heritage';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingCards } from '@/components/ui/Skeleton';
import type { CourseRole, CurrentUser } from '@/lib/api/types';
import { LocalizedCourseStatusBadge as CourseStatusBadge } from '@/components/courses/LocalizedCourseStatusBadge';

const ROLES: CourseRole[] = ['student', 'instructor', 'non_editing_instructor', 'design_team'];

export function CourseList() {
  return <RequireAuth>{(user) => <CourseListContent user={user} />}</RequireAuth>;
}

/** Every course the API lets this user see, with their role in each (filtered on the client). */
function CourseListContent({ user }: { user: CurrentUser }) {
  const { t } = useLocale();
  const workspace = useWorkspace();
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const isAdmin = user.systemRole === 'administrator';

  const courses = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return workspace.courses.filter(
      (course) =>
        (!role || (role === 'none' ? course.viewerRole === null : course.viewerRole === role)) &&
        (!needle || course.code.toLowerCase().includes(needle) || course.title.toLowerCase().includes(needle)),
    );
  }, [workspace.courses, query, role]);

  const header = <PageHeader title={isAdmin ? t.courses.adminTitle : t.courses.title} description={isAdmin ? t.courses.adminIntro : t.courses.intro} />;
  if (workspace.status === 'loading' || workspace.status === 'idle') return <div className="space-y-6">{header}<LoadingCards label={t.common.loading} /></div>;
  if (workspace.status === 'error') {
    return (
      <div className="space-y-6">
        {header}
        <Alert tone="error">
          {t.common.loadError}{' '}
          <button type="button" className="font-medium underline" onClick={() => void workspace.reload()}>
            {t.common.retry}
          </button>
        </Alert>
      </div>
    );
  }
  const roleOptions = [
    { value: '', label: t.common.all },
    ...ROLES.filter((r) => workspace.rolesHeld.has(r)).map((r) => ({ value: r, label: t.roles[r] })),
    ...(isAdmin ? [{ value: 'none', label: t.roles.adminAccess }] : []),
  ];

  return (
    <div className="space-y-6">
      {header}
      {workspace.courses.length === 0 ? (
        <EmptyState title={t.dashboard.noCourses} description={t.dashboard.noCoursesHelp} />
      ) : (
        <>
          <Card className="grid gap-4 sm:grid-cols-2">
            <TextField id="courses-search" label={t.common.search} value={query} onChange={(e) => setQuery(e.target.value)} />
            <SelectField id="courses-role" label={t.courses.filterRole} value={role} onChange={(e) => setRole(e.target.value)} options={roleOptions} />
          </Card>
          <p className="text-sm text-slate-500" aria-live="polite">
            {t.common.showing(courses.length, workspace.courses.length)}
          </p>
          {courses.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-600">{t.courses.empty}</p>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {courses.map((course) => (
                <Card as="li" key={course.id} className="flex flex-col gap-3">
                  <div className="flex items-start gap-3">
                    <CourseEmblem code={course.code} className="h-14 w-12" />
                    <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h2 className="text-lg leading-snug font-semibold break-words text-brand-600">
                          <Link href={`/courses/${course.id}`} className="hover:text-brand-700 hover:underline">
                            {course.title}
                          </Link>
                        </h2>
                        <p className="mt-0.5 text-xs text-slate-600">{course.code}</p>
                      </div>
                      <CourseStatusBadge status={course.status} />
                    </div>
                  </div>
                  {course.description ? <p className="line-clamp-3 text-sm text-slate-600">{course.description}</p> : null}
                  <div className="mt-auto">
                    <Badge tone={course.viewerRole ? 'brand' : 'neutral'}>{course.viewerRole ? t.roles[course.viewerRole] : t.roles.adminAccess}</Badge>
                  </div>
                </Card>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
