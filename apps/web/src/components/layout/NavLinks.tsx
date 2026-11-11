'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { useWorkspace } from '@/components/session/WorkspaceProvider';
import { useUnreadSummary } from '@/components/messaging/polling';
import { cn } from '@/lib/cn';
import { Icon, navIconFor } from './Heritage';
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
            <p id={headingId} className="px-3 text-[0.7rem] font-semibold tracking-[0.14em] text-gold-300 uppercase">
              {section.title}
            </p>
            <ul aria-labelledby={headingId} className="mt-2 space-y-0.5">
              {section.items.map((item) => {
                const active = isActivePath(pathname, item);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'block rounded-md border-l-2 px-3 py-2 text-sm font-medium transition-colors',
                        active
                          ? 'border-gold-400 bg-brand-600 text-ivory shadow-sm'
                          : 'border-transparent text-ivory/85 hover:bg-white/8 hover:text-ivory',
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-3">
                          <Icon name={navIconFor(item.href)} className={cn('h-[1.15rem] w-[1.15rem] shrink-0', active ? 'text-gold-200' : 'text-gold-300')} />
                          <span className="min-w-0 break-words">{item.label}</span>
                        </span>
                        {badges[item.href] ? (
                          <span className="rounded-full bg-gold-400 px-2 py-0.5 text-xs font-bold text-slate-900" data-nav-badge={item.href}>
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
