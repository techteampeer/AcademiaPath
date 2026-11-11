'use client';

import Link from 'next/link';
import { LanguageSwitcher, useLocale } from '@/components/i18n/LocaleProvider';
import { useUnreadSummary } from '@/components/messaging/polling';
import { SessionControls } from '@/components/session/SessionControls';
import { useSession } from '@/components/session/SessionProvider';
import { landingPathFor } from '@/components/session/WorkspaceProvider';
import { BrandMark, Icon } from './Heritage';
import { MobileNav } from './MobileNav';

export { BrandMark };

/** Bell linking to the notification centre, with the caller's unread count (AP-026 data; display only). */
function NotificationBell() {
  const { t } = useLocale();
  const { session } = useSession();
  const { summary } = useUnreadSummary();
  if (session.status !== 'authenticated') return null;
  const unread = summary?.unreadNotifications ?? 0;
  return (
    <Link
      href="/notifications"
      className="relative inline-flex h-10 w-10 items-center justify-center rounded-md text-ivory/90 hover:bg-white/10 hover:text-ivory"
      data-header-notifications={unread}
    >
      <Icon name="bell" className="h-5 w-5" />
      <span className="sr-only">
        {t.nav.notifications}
        {unread ? ` (${t.messaging.dashboard.unreadNotifications(unread)})` : ''}
      </span>
      {unread ? (
        <span aria-hidden="true" className="absolute top-1.5 right-1.5 min-w-4 rounded-full bg-gold-400 px-1 text-center text-[0.65rem] leading-4 font-bold text-slate-900">
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </Link>
  );
}

export function Header() {
  const { t } = useLocale();
  const { session } = useSession();
  const home = session.status === 'authenticated' ? landingPathFor(session.user) : '/';
  return (
    <header className="on-dark sticky top-0 z-40 bg-brand-600 text-ivory shadow-[0_1px_0_0_rgb(185_154_97/0.55)]">
      <div className="relative flex h-16 items-center justify-between gap-2 px-3 sm:gap-3 sm:px-6 lg:px-8">
        <Link href={home} className="flex min-w-0 items-center gap-2.5 rounded-md" aria-label={`${t.common.appName} — ${t.nav.home}`}>
          <BrandMark className="h-9 w-9 shrink-0" />
          {/* Wordmark hidden on very narrow screens so the language toggle, sign-out and menu fit. */}
          <span className="hidden font-serif text-xl font-semibold tracking-wide text-ivory min-[440px]:inline">AcademiaPath</span>
        </Link>
        <div className="flex items-center gap-1.5 sm:gap-3">
          <span className="hidden rounded-full border border-gold-400/60 px-2.5 py-0.5 text-xs font-medium text-gold-200 xl:block">{t.common.devPreview}</span>
          <LanguageSwitcher />
          <NotificationBell />
          <SessionControls />
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
