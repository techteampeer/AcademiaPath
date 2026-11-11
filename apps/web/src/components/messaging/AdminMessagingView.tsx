'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { AdminCourseConversationList } from '@/lib/api/types';
import { formatDateTimeOrDash } from '@/lib/i18n/messages';

type Row = AdminCourseConversationList['items'][number];

/** Administrators: course conversations' state and size, lock and unlock. Never message text. */
export function AdminMessagingView() {
  return <RequireAuth role="administrator">{() => <Content />}</RequireAuth>;
}

function Content() {
  const { t, locale } = useLocale();
  const a = t.messaging.admin;
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: Row[] }>({ status: 'loading' });
  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', items: (await api.adminCourseConversations()).items });
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
      <PageHeader
        title={a.title}
        description={a.intro}
        breadcrumbLabel={t.common.breadcrumb}
        breadcrumbs={[{ label: t.nav.administration, href: '/admin' }, { label: a.title }]}
      />
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
          <ul className="divide-y divide-slate-100" data-admin-conversations>
            {state.items.map((row) => (
              <AdminRow key={row.course.id} row={row} onChanged={() => void load()} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function AdminRow({ row, onChanged }: { row: Row; onChanged: () => void }) {
  const { t, locale } = useLocale();
  const a = t.messaging.admin;
  const { run, pending, result } = useCsrfAction();
  return (
    <li className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" data-admin-course={row.course.code}>
      <div className="min-w-0 space-y-1">
        <p className="font-medium break-words text-slate-900">
          {row.course.code} · {row.course.title}
        </p>
        <p className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          {!row.conversationId ? <Badge tone="neutral">{a.notStarted}</Badge> : row.locked ? <Badge tone="warning">{a.lockedLabel}</Badge> : <Badge tone="success">{a.open}</Badge>}
          <span>
            {a.messages}: {row.messageCount}
          </span>
          <span>
            {a.lastMessage}: {formatDateTimeOrDash(row.lastMessageAt, locale)}
          </span>
        </p>
        {result?.tone === 'error' ? <p className="text-xs text-red-700">{result.message}</p> : null}
      </div>
      {row.conversationId ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={async () => {
            if (await run((csrf) => api.setConversationLock(row.conversationId!, !row.locked, csrf))) onChanged();
          }}
        >
          {row.locked ? a.unlock : a.lock}
        </Button>
      ) : null}
    </li>
  );
}
