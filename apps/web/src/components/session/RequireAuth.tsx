'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import type { CurrentUser } from '@/lib/api/types';
import { useSession } from './SessionProvider';

/**
 * UX guard for signed-in pages: redirects to /login when there is no session and hides
 * administrator screens from other users. The API independently enforces all access.
 */
export function RequireAuth({
  role,
  children,
}: {
  role?: CurrentUser['systemRole'];
  children: (user: CurrentUser) => ReactNode;
}) {
  const { session } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (session.status === 'unauthenticated') router.replace('/login');
  }, [session.status, router]);

  if (session.status !== 'authenticated') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {session.status === 'loading' ? 'Checking your session…' : 'Redirecting to sign in…'}
      </p>
    );
  }
  if (role && session.user.systemRole !== role) {
    return (
      <EmptyState
        titleAs="h1"
        title="Access restricted"
        description="This area is available to administrators only."
      />
    );
  }
  return <>{children(session.user)}</>;
}
