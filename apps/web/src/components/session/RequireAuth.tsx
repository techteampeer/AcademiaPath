'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { EmptyState } from '@/components/ui/EmptyState';
import type { CurrentUser } from '@/lib/api/types';
import { useSession } from './SessionProvider';

/**
 * UX guard for signed-in pages: redirects to /login (remembering the page, and whether the session
 * expired) and hides administrator screens from other users. Protected data is only requested after
 * this guard passes, and the API independently enforces all access.
 */
export function RequireAuth({
  role,
  children,
}: {
  role?: CurrentUser['systemRole'];
  children: (user: CurrentUser) => ReactNode;
}) {
  const { session } = useSession();
  const { t } = useLocale();
  const router = useRouter();

  useEffect(() => {
    if (session.status !== 'unauthenticated') return;
    const params = new URLSearchParams();
    if (session.reason !== 'signedOut') params.set('next', `${window.location.pathname}${window.location.search}`);
    if (session.reason === 'expired') params.set('expired', '1');
    const query = params.toString();
    router.replace(query ? `/login?${query}` : '/login');
  }, [session, router]);

  if (session.status !== 'authenticated') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {session.status === 'loading' ? t.session.checking : t.session.redirecting}
      </p>
    );
  }
  if (role && session.user.systemRole !== role) {
    return <EmptyState titleAs="h1" title={t.session.restricted} description={t.session.adminOnly} />;
  }
  return <>{children(session.user)}</>;
}
