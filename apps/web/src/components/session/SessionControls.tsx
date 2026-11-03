'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, buttonClasses } from '@/components/ui/Button';
import { SYSTEM_ROLE_LABELS, useSession } from './SessionProvider';

/** Header sign-in / sign-out controls with the signed-in user's name and system role. */
export function SessionControls() {
  const { session, signOut } = useSession();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  if (session.status === 'loading') return null;

  if (session.status === 'unauthenticated') {
    return (
      <Link href="/login" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
        Sign in
      </Link>
    );
  }

  const { user } = session;
  const onSignOut = async () => {
    setPending(true);
    setFailed(false);
    try {
      await signOut();
      router.push('/login');
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right text-sm leading-tight sm:block">
        <p className="font-medium text-slate-900">
          {user.givenName} {user.familyName}
        </p>
        <p className="text-xs text-slate-500">{SYSTEM_ROLE_LABELS[user.systemRole]}</p>
      </div>
      <Button variant="secondary" size="sm" onClick={onSignOut} disabled={pending}>
        {pending ? 'Signing out…' : 'Sign out'}
      </Button>
      {failed ? (
        <span role="alert" className="sr-only">
          Sign-out failed. Please try again.
        </span>
      ) : null}
    </div>
  );
}

/** Compact identity line for the mobile navigation panel. */
export function SessionSummary() {
  const { session } = useSession();
  if (session.status !== 'authenticated') return null;
  return (
    <p className="mb-4 border-b border-slate-200 px-3 pb-3 text-sm text-slate-600">
      Signed in as{' '}
      <span className="font-medium text-slate-900">
        {session.user.givenName} {session.user.familyName}
      </span>{' '}
      ({SYSTEM_ROLE_LABELS[session.user.systemRole]})
    </p>
  );
}
