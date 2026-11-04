'use client';

import Link from 'next/link';
import { LanguageSwitcher, useLocale } from '@/components/i18n/LocaleProvider';
import { SessionControls } from '@/components/session/SessionControls';
import { useSession } from '@/components/session/SessionProvider';
import { landingPathFor } from '@/components/session/WorkspaceProvider';
import { Badge } from '@/components/ui/Badge';
import { MobileNav } from './MobileNav';

export function BrandMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-brand-600" />
      <path d="M9 23 16 8l7 15M11.5 18h9" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Header() {
  const { t } = useLocale();
  const { session } = useSession();
  const home = session.status === 'authenticated' ? landingPathFor(session.user) : '/';
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="relative flex h-16 items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        <Link href={home} className="flex min-w-0 items-center gap-2.5 rounded-lg" aria-label={`${t.common.appName} — ${t.nav.home}`}>
          <BrandMark />
          <span className="text-lg font-semibold tracking-tight text-brand-900">
            Academia<span className="text-brand-600">Path</span>
          </span>
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="hidden xl:block">
            <Badge tone="brand">{t.common.devPreview}</Badge>
          </span>
          <div className="hidden sm:block">
            <LanguageSwitcher />
          </div>
          <SessionControls />
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
