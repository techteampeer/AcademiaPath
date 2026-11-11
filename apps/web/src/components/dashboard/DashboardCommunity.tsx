'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { Icon, type IconName } from '@/components/layout/Heritage';
import { useUnreadSummary } from '@/components/messaging/polling';
import { useSession } from '@/components/session/SessionProvider';
import { Card } from '@/components/ui/Card';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { AppNotification, Course } from '@/lib/api/types';
import { formatDateTime } from '@/lib/i18n/messages';

const FORUM_ROLES = new Set(['student', 'instructor', 'non_editing_instructor']);
const FORUMS_SHOWN = 4;
const ACTIVITY_SHOWN = 5;

function PanelHeading({ id, icon, children }: { id: string; icon: IconName; children: string }) {
  return (
    <h2 id={id} className="flex items-center gap-2 text-lg font-semibold text-brand-600">
      <Icon name={icon} className="h-5 w-5 shrink-0 text-gold-600" />
      {children}
    </h2>
  );
}

const rowLink = 'flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm font-medium text-slate-800 hover:bg-parchment hover:text-brand-700';

/**
 * Community panel (every role): unread messages and notifications plus shortcuts to the spaces the person
 * already has in the navigation (groups for students, course forums for course participants, certificates).
 * Display only: every destination is authorized by the API.
 */
export function DashboardCommunity({ courses, isStudent }: { courses: Course[]; isStudent: boolean }) {
  const { t } = useLocale();
  const d = t.dashboard;
  const { summary } = useUnreadSummary();
  const forums = courses.filter((course) => course.viewerRole && FORUM_ROLES.has(course.viewerRole)).slice(0, FORUMS_SHOWN);
  const count = (value: number) =>
    value ? <span className="rounded-full bg-brand-600 px-2 py-0.5 text-xs font-bold text-white">{value}</span> : null;
  return (
    <Card as="section" aria-labelledby="dashboard-community" className="space-y-3">
      <div>
        <PanelHeading id="dashboard-community" icon="users">
          {d.community}
        </PanelHeading>
        <p className="mt-1 text-sm text-slate-600">{d.communityIntro}</p>
      </div>
      {summary ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-dashboard-messaging>
          <Link href="/messages" className="font-medium text-brand-700 hover:underline" data-dashboard-unread-messages={summary.unreadMessages}>
            {t.messaging.dashboard.unreadMessages(summary.unreadMessages)}
          </Link>
          <Link href="/notifications" className="font-medium text-brand-700 hover:underline" data-dashboard-unread-notifications={summary.unreadNotifications}>
            {t.messaging.dashboard.unreadNotifications(summary.unreadNotifications)}
          </Link>
        </p>
      ) : null}
      <ul className="-mx-2 divide-y divide-slate-200/70">
        <li>
          <Link href="/messages" className={rowLink}>
            <span className="flex items-center gap-2.5">
              <Icon name="chat" className="h-4.5 w-4.5 text-gold-600" />
              {t.nav.messages}
            </span>
            {count(summary?.unreadMessages ?? 0)}
          </Link>
        </li>
        <li>
          <Link href="/notifications" className={rowLink}>
            <span className="flex items-center gap-2.5">
              <Icon name="bell" className="h-4.5 w-4.5 text-gold-600" />
              {t.nav.notifications}
            </span>
            {count(summary?.unreadNotifications ?? 0)}
          </Link>
        </li>
        {isStudent ? (
          <li>
            <Link href="/groups" className={rowLink}>
              <span className="flex items-center gap-2.5">
                <Icon name="users" className="h-4.5 w-4.5 text-gold-600" />
                {t.nav.myGroups}
              </span>
            </Link>
          </li>
        ) : null}
        <li>
          <Link href="/certificates" className={rowLink}>
            <span className="flex items-center gap-2.5">
              <Icon name="award" className="h-4.5 w-4.5 text-gold-600" />
              {t.nav.myCertificates}
            </span>
          </Link>
        </li>
      </ul>
      {forums.length ? (
        <div>
          <p className="text-xs font-semibold tracking-wide text-slate-600 uppercase">{d.courseForums}</p>
          <ul className="mt-1 -mx-2">
            {forums.map((course) => (
              <li key={course.id}>
                <Link href={`/courses/${course.id}/forum`} className={rowLink}>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Icon name="forum" className="h-4.5 w-4.5 shrink-0 text-gold-600" />
                    <span className="min-w-0 break-words">
                      {t.nav.forum} · {course.code}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

type ActivityState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: AppNotification[] };

/** Recent activity: the person's latest notifications (real events chosen by the API; read-only here). */
export function DashboardRecentActivity() {
  const { t, locale } = useLocale();
  const d = t.dashboard;
  const n = t.messaging.notifications;
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<ActivityState>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    api
      .myNotifications()
      .then((page) => active && setState({ status: 'ready', items: page.items.slice(0, ACTIVITY_SHOWN) }))
      .catch((error: unknown) => {
        if (isApiError(error, 401)) handleUnauthorized();
        if (active) setState({ status: 'error' });
      });
    return () => {
      active = false;
    };
  }, [handleUnauthorized]);
  return (
    <Card as="section" aria-labelledby="dashboard-activity" className="space-y-3" data-dashboard-activity>
      <PanelHeading id="dashboard-activity" icon="trend">
        {d.recentActivity}
      </PanelHeading>
      {state.status === 'loading' ? (
        <p className="text-sm text-slate-600">{t.common.loading}</p>
      ) : state.status === 'error' ? (
        <p className="text-sm text-slate-600">{t.common.loadError}</p>
      ) : state.items.length === 0 ? (
        <p className="text-sm text-slate-600">{d.noActivity}</p>
      ) : (
        <ol className="space-y-3 border-l border-gold-400/50 pl-4">
          {state.items.map((item) => (
            <li key={item.id} className="relative">
              <span aria-hidden="true" className={`absolute top-1.5 -left-[1.3rem] h-2 w-2 rounded-full ring-2 ring-white ${item.read ? 'bg-slate-300' : 'bg-brand-600'}`} />
              <Link href={item.link} className={`block text-sm break-words hover:text-brand-700 hover:underline ${item.read ? 'text-slate-700' : 'font-medium text-slate-900'}`}>
                {n.text[item.type](item.data)}
              </Link>
              <p className="text-xs text-slate-600">
                {formatDateTime(item.eventAt, locale)}
                {!item.read ? ` · ${n.unreadBadge}` : ''}
              </p>
            </li>
          ))}
        </ol>
      )}
      <Link href="/notifications" className="inline-block text-sm font-medium text-brand-700 hover:underline">
        {d.allNotifications}
      </Link>
    </Card>
  );
}
