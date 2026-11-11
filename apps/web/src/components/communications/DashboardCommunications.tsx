'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/layout/Heritage';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { AnnouncementPage, Calendar, CurrentUser, UnreadCount } from '@/lib/api/types';
import { SourceLabel, announcementDate, formatEventWhen, formatInZone } from './communicationDisplay';

const UPCOMING_DAYS = 14;
const SHOWN = 5;

type Data = { feed: AnnouncementPage; unread: UnreadCount; calendar: Calendar };
type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: Data };

/**
 * Dashboard panel (every role): the newest announcements the caller may read, the unread count and the next
 * two weeks of events and due dates. Everything is filtered by the API; this only displays it.
 */
export function DashboardCommunications({ user }: { user: CurrentUser }) {
  const { t, locale } = useLocale();
  const d = t.communications.dashboard;
  const c = t.communications.calendar;
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    const now = new Date();
    Promise.all([
      api.myAnnouncements({ limit: SHOWN }),
      api.myUnreadCount(),
      api.myCalendar({ from: now.toISOString(), to: new Date(now.getTime() + UPCOMING_DAYS * 86_400_000).toISOString() }),
    ])
      .then(([feed, unread, calendar]) => active && setState({ status: 'ready', data: { feed, unread, calendar } }))
      .catch((error: unknown) => {
        if (isApiError(error, 401)) handleUnauthorized();
        if (active) setState({ status: 'error' });
      });
    return () => {
      active = false;
    };
  }, [handleUnauthorized]);

  const upcoming =
    state.status === 'ready'
      ? [
          ...state.data.calendar.events.map((event) => ({ key: event.id, at: event.startsAt, title: event.title, source: event.course?.code ?? c.institution, when: formatEventWhen(event, locale, c.allDay), cancelled: event.status === 'cancelled' })),
          ...state.data.calendar.dueDates.map((due) => ({ key: `due-${due.activityId}`, at: due.dueAt, title: c.dueLabel(due.title), source: due.course?.code ?? '', when: formatInZone(due.dueAt, state.data.calendar.timeZone, locale), cancelled: false })),
        ]
          .sort((a, b) => a.at.localeCompare(b.at))
          .slice(0, SHOWN)
      : [];

  return (
    <section aria-labelledby="communications-heading" className="space-y-3" data-dashboard-communications>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="communications-heading" className="text-[1.4rem] font-semibold text-brand-600">
          {d.heading}
        </h2>
        {user.systemRole === 'administrator' ? (
          <Link href="/admin/communications" className="text-sm font-medium text-brand-700 hover:underline">
            {d.institutionTools}
          </Link>
        ) : null}
      </div>
      <div aria-hidden="true" className="heritage-rule w-24" />
      <div className="grid gap-4 md:grid-cols-2">
        <Card as="section" aria-labelledby="recent-announcements" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="recent-announcements" className="flex items-center gap-2 text-lg font-semibold text-brand-600">
              <Icon name="megaphone" className="h-5 w-5 shrink-0 text-gold-600" />
              {d.recent}
            </h3>
            <span data-dashboard-unread={state.status === 'ready' ? state.data.unread.unreadCount : ''}>
              {state.status === 'ready' ? (
                <Badge tone={state.data.unread.unreadCount ? 'warning' : 'neutral'}>{t.communications.announcements.unread(state.data.unread.unreadCount)}</Badge>
              ) : null}
            </span>
          </div>
          {state.status === 'loading' ? (
            <p className="text-sm text-slate-600">{t.common.loading}</p>
          ) : state.status === 'error' ? (
            <p className="text-sm text-slate-600">{t.common.loadError}</p>
          ) : state.data.feed.items.length === 0 ? (
            <p className="text-sm text-slate-600">{d.noAnnouncements}</p>
          ) : (
            <ul className="divide-y divide-slate-200/70">
              {state.data.feed.items.map((item) => (
                <li key={item.id} className="py-2" data-dashboard-announcement={item.title}>
                  <div className="flex flex-wrap items-center gap-2">
                    <SourceLabel item={item} />
                    {item.pinned ? <Badge tone="brand">{t.communications.announcements.pinned}</Badge> : null}
                    {!item.read ? <Badge tone="warning">{t.communications.announcements.unreadBadge}</Badge> : null}
                  </div>
                  <Link href={`/announcements/${item.id}`} className="block font-medium break-words text-slate-900 hover:text-brand-700 hover:underline">
                    {item.title}
                  </Link>
                  <p className="text-xs text-slate-500">{announcementDate(item, locale)}</p>
                </li>
              ))}
            </ul>
          )}
          <Link href="/announcements" className="text-sm font-medium text-brand-700 hover:underline">
            {d.viewAll}
          </Link>
        </Card>
        <Card as="section" aria-labelledby="upcoming-events" className="space-y-3">
          <h3 id="upcoming-events" className="flex items-center gap-2 text-lg font-semibold text-brand-600">
            <Icon name="calendar" className="h-5 w-5 shrink-0 text-gold-600" />
            {d.upcoming}
          </h3>
          {state.status === 'loading' ? (
            <p className="text-sm text-slate-600">{t.common.loading}</p>
          ) : state.status === 'error' ? (
            <p className="text-sm text-slate-600">{t.common.loadError}</p>
          ) : upcoming.length === 0 ? (
            <p className="text-sm text-slate-600">{d.noEvents}</p>
          ) : (
            <ul className="divide-y divide-slate-200/70">
              {upcoming.map((entry) => (
                <li key={entry.key} className="border-l-2 border-gold-400/70 py-2 pl-3" data-dashboard-upcoming={entry.title}>
                  <p className="text-xs font-semibold text-olive">
                    {entry.source}
                    {entry.cancelled ? ` · ${c.cancelled}` : ''}
                  </p>
                  <p className={`font-medium break-words text-slate-900 ${entry.cancelled ? 'line-through' : ''}`}>{entry.title}</p>
                  <p className="text-xs text-slate-500">{entry.when}</p>
                </li>
              ))}
            </ul>
          )}
          <Link href="/calendar" className="text-sm font-medium text-brand-700 hover:underline">
            {d.viewAll}
          </Link>
        </Card>
      </div>
    </section>
  );
}
