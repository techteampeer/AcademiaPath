'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { AdminForumCourseList } from '@/lib/api/types';
import { formatDateTime } from '@/lib/i18n/messages';

type Row = AdminForumCourseList['items'][number];

/** Administrators: each published course forum's activity and moderation state (counts only), with a link to moderate it. */
export function AdminForumsView() {
  return <RequireAuth role="administrator">{() => <Content />}</RequireAuth>;
}

function Content() {
  const { t, locale } = useLocale();
  const a = t.forums.admin;
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: Row[] }>({ status: 'loading' });
  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', items: (await api.adminForumCourses()).items });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [handleUnauthorized, locale]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="space-y-6">
      <PageHeader title={a.title} description={a.intro} breadcrumbLabel={t.common.breadcrumb} breadcrumbs={[{ label: t.nav.administration, href: '/admin' }, { label: a.title }]} />
      <Card as="section" aria-label={a.title}>
        {state.status === 'loading' ? (
          <p role="status" className="text-sm text-slate-600">
            {t.common.loading}
          </p>
        ) : state.status === 'error' ? (
          <Alert tone="error">{state.message}</Alert>
        ) : state.items.length === 0 ? (
          <p className="text-sm text-slate-600">{a.none}</p>
        ) : (
          <ul className="divide-y divide-slate-100" data-admin-forums>
            {state.items.map((row) => (
              <li key={row.course.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" data-admin-forum={row.course.code}>
                <div className="min-w-0 space-y-1">
                  <p className="font-medium break-words text-slate-900">
                    {row.course.code} · {row.course.title}
                  </p>
                  <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                    {(
                      [
                        [a.topics, row.topicCount, 'topics'],
                        [a.replies, row.replyCount, 'replies'],
                        [a.locked, row.lockedTopicCount, 'locked'],
                        [a.hidden, row.hiddenTopicCount + row.hiddenReplyCount, 'hidden'],
                      ] as const
                    ).map(([label, value, key]) => (
                      <div key={key} className="flex gap-1" data-count={key}>
                        <dt>{label}:</dt>
                        <dd className="font-medium text-slate-800">{value}</dd>
                      </div>
                    ))}
                    <div className="flex gap-1">
                      <dt>{a.lastActivity}:</dt>
                      <dd>{row.lastActivityAt ? formatDateTime(row.lastActivityAt, locale) : a.never}</dd>
                    </div>
                  </dl>
                </div>
                <Link href={`/courses/${row.course.id}/forum`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
                  {a.open}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
