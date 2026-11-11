'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { AppNotification } from '@/lib/api/types';
import { formatDateTime } from '@/lib/i18n/messages';
import { usePolling, useUnreadSummary } from './polling';

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: AppNotification[]; nextCursor: string | null };

/** /notifications: the caller's own notifications (the API decides which are visible). */
export function NotificationsView() {
  return <RequireAuth>{() => <Notifications />}</RequireAuth>;
}

function Notifications() {
  const { t, locale } = useLocale();
  const n = t.messaging.notifications;
  const router = useRouter();
  const { handleUnauthorized } = useSession();
  const { refresh } = useUnreadSummary();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [state, setState] = useState<State>({ status: 'loading' });
  const { run, pending, result } = useCsrfAction();

  const load = useCallback(async () => {
    try {
      const page = await api.myNotifications({ unread: unreadOnly });
      setState({ status: 'ready', items: page.items, nextCursor: page.nextCursor });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [unreadOnly, handleUnauthorized, locale]);
  useEffect(() => {
    setState({ status: 'loading' });
    void load();
  }, [load]);
  usePolling(load, 30_000);

  const more = async () => {
    if (state.status !== 'ready' || !state.nextCursor) return;
    const page = await api.myNotifications({ cursor: state.nextCursor, unread: unreadOnly });
    setState({ status: 'ready', items: [...state.items, ...page.items], nextCursor: page.nextCursor });
  };
  const markRead = async (item: AppNotification) => {
    if (!item.read && (await run((csrf) => api.markNotificationRead(item.id, csrf))) === null) return false;
    setState((current) => (current.status === 'ready' ? { ...current, items: current.items.map((x) => (x.id === item.id ? { ...x, read: true } : x)) } : current));
    void refresh();
    return true;
  };

  return (
    <div className="space-y-6">
      <PageHeader title={n.title} description={n.intro} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-800">
          <input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} />
          {n.unreadOnly}
        </label>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={async () => {
            if ((await run((csrf) => api.markAllNotificationsRead(csrf), (r) => n.markedAll(r.updated))) !== null) {
              await load();
              void refresh();
            }
          }}
        >
          {n.markAllRead}
        </Button>
      </div>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      <Card as="section" aria-label={n.title} className="space-y-2">
        {state.status === 'loading' ? (
          <p role="status" className="text-sm text-slate-600">
            {n.loading}
          </p>
        ) : state.status === 'error' ? (
          <Alert tone="error">{state.message}</Alert>
        ) : state.items.length === 0 ? (
          <EmptyState title={n.none} />
        ) : (
          <ul className="divide-y divide-slate-100" data-notification-list>
            {state.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-3" data-notification={item.type} data-read={String(item.read)}>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {!item.read ? <Badge tone="brand">{n.unreadBadge}</Badge> : null}
                    <span className="text-xs text-slate-500">{formatDateTime(item.eventAt, locale)}</span>
                  </div>
                  <p className={`text-sm break-words ${item.read ? 'text-slate-600' : 'font-medium text-slate-900'}`}>{n.text[item.type](item.data)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={item.link}
                    className="text-sm font-medium text-brand-700 hover:underline"
                    onClick={async (event) => {
                      event.preventDefault();
                      await markRead(item);
                      router.push(item.link);
                    }}
                  >
                    {n.open}
                  </Link>
                  {!item.read ? (
                    <button type="button" className="text-sm text-slate-600 underline" disabled={pending} onClick={() => void markRead(item)}>
                      {n.markRead}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {state.status === 'ready' && state.nextCursor ? (
          <Button variant="secondary" onClick={() => void more()}>
            {n.loadMore}
          </Button>
        ) : null}
      </Card>
    </div>
  );
}
