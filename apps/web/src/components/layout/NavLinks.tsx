'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { isActivePath, navSections } from './navigation';

export function NavLinks({ idPrefix, onNavigate }: { idPrefix: string; onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="space-y-6">
      {navSections.map((section) => {
        const headingId = `${idPrefix}-${section.title.toLowerCase().replace(/\s+/g, '-')}`;
        return (
          <div key={section.title}>
            <p id={headingId} className="px-3 text-xs font-semibold tracking-wider text-slate-500 uppercase">
              {section.title}
            </p>
            <ul aria-labelledby={headingId} className="mt-2 space-y-1">
              {section.items.map((item) => {
                const active = isActivePath(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'block rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                        active
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900',
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
