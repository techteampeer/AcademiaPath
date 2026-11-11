'use client';

import { useLocale } from '@/components/i18n/LocaleProvider';
import { NavLinks } from './NavLinks';

/**
 * Persistent navigation for large screens; hidden (and removed from the accessibility tree) below `lg`.
 * Forest green with a decorative collegiate line drawing at its base (never over the links).
 */
export function Sidebar() {
  const { t } = useLocale();
  return (
    <aside className="on-dark relative hidden w-64 shrink-0 bg-forest-900 lg:block">
      {/* One scrolling column: the drawing sits at the base when the links are few and follows the last link when
          they are many, so it never covers navigation. */}
      <div className="sticky top-16 flex h-[calc(100vh-4rem)] flex-col overflow-y-auto">
        <nav aria-label={t.nav.main} className="px-3 py-6">
          <NavLinks idPrefix="sidebar-nav" />
        </nav>
        {/* eslint-disable-next-line @next/next/no-img-element -- static decorative SVG */}
        <img src="/heritage/college-line.svg" alt="" aria-hidden="true" className="pointer-events-none mx-auto mt-auto mb-4 w-44 shrink-0 opacity-40" />
      </div>
    </aside>
  );
}
