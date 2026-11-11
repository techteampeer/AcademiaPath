'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { useWorkspace } from '@/components/session/WorkspaceProvider';
import { useUnreadSummary } from '@/components/messaging/polling';
import { cn } from '@/lib/cn';
import { buildNavigation, isActivePath } from './navigation';

export function NavLinks({ idPrefix, onNavigate }: { idPrefix: string; onNavigate?: () => void }) {
  const pathname = usePathname();
  const { session } = useSession();
  const { t } = useLocale();
  const { roleByCourse, managedPrograms } = useWorkspace();
  const { summary } = useUnreadSummary();
  // Unread counts beside the workspace Messages and Notifications links (AP-026).
  const badges: Record<string, number> = { '/messages': summary?.unreadMessages ?? 0, '/notifications': summary?.unreadNotifications ?? 0 };
  if (session.status === 'loading') return null;
  const user = session.status === 'authenticated' ? session.user : null;
  const sections = buildNavigation(t, user, pathname, roleByCourse, managedPrograms.length > 0);

  return (
    <div className="space-y-6">
      {sections.map((section) => {
        const headingId = `${idPrefix}-${section.id}`;
        return (
          <div key={section.id}>
            <p id={headingId} className="px-3 text-xs font-semibold tracking-wider text-slate-500 uppercase">
              {section.title}
            </p>
            <ul aria-labelledby={headingId} className="mt-2 space-y-1">
              {section.items.map((item) => {
                const active = isActivePath(pathname, item);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'block rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                        active ? 'bg-brand-50 text-brand-700' : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900',
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span>{item.label}</span>
                        {badges[item.href] ? (
                          <span className="rounded-full bg-brand-600 px-2 py-0.5 text-xs font-semibold text-white" data-nav-badge={item.href}>
                            {badges[item.href]}
                            <span className="sr-only"> {t.messaging.messages.unread(badges[item.href]!)}</span>
                          </span>
                        ) : null}
                      </span>
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
