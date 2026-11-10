'use client';

import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { PageHeader } from '@/components/ui/PageHeader';
import { AnnouncementManager } from './AnnouncementViews';
import { EventCalendar } from './CalendarViews';

/** Administrators: institution-wide announcements and events (course content is managed in each course). */
export function AdminCommunicationsView() {
  return <RequireAuth role="administrator">{() => <Content />}</RequireAuth>;
}

function Content() {
  const { t } = useLocale();
  return (
    <div className="space-y-8">
      <PageHeader
        title={t.nav.institutionCommunications}
        breadcrumbLabel={t.common.breadcrumb}
        breadcrumbs={[{ label: t.nav.administration, href: '/admin' }, { label: t.nav.institutionCommunications }]}
      />
      <AnnouncementManager target={{ kind: 'institution' }} canManage />
      <EventCalendar target={{ kind: 'institution' }} staff canManage />
    </div>
  );
}
