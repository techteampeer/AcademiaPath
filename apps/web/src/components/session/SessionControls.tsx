'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { Button, buttonClasses } from '@/components/ui/Button';
import type { CourseRole } from '@/lib/api/types';
import type { Messages } from '@/lib/i18n/messages';
import { useSession } from './SessionProvider';
import { useWorkspace } from './WorkspaceProvider';

const ROLE_ORDER: CourseRole[] = ['design_team', 'instructor', 'non_editing_instructor', 'student'];

/** System role for administrators, otherwise the course roles actually held (they differ per course). */
export function roleSummary(t: Messages, systemRole: 'administrator' | 'user', rolesHeld: Set<CourseRole>): string {
  if (systemRole === 'administrator') return t.roles.administrator;
  const held = ROLE_ORDER.filter((role) => rolesHeld.has(role)).map((role) => t.roles[role]);
  return held.length ? held.join(' · ') : t.roles.user;
}

/** Header identity and sign-out. Signing out ends the server session (HttpOnly cookie) and returns to login. */
export function SessionControls() {
  const { session, signOut } = useSession();
  const { rolesHeld } = useWorkspace();
  const { t } = useLocale();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  if (session.status === 'loading') return null;
  if (session.status === 'unauthenticated') {
    return (
      <Link href="/login" className={buttonClasses({ variant: 'inverse', size: 'sm' })}>
        {t.common.signIn}
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
      <div className="hidden items-center gap-2.5 md:flex">
        <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ivory font-serif text-sm font-semibold text-brand-600 ring-1 ring-gold-400">
          {`${user.givenName.charAt(0)}${user.familyName.charAt(0)}`.toUpperCase()}
        </span>
        <div className="text-right text-sm leading-tight">
          <p className="font-medium text-ivory">
            {user.givenName} {user.familyName}
          </p>
          <p className="text-xs text-gold-200">{roleSummary(t, user.systemRole, rolesHeld)}</p>
        </div>
      </div>
      <Button variant="inverse" size="sm" className="whitespace-nowrap" onClick={onSignOut} disabled={pending}>
        {pending ? t.common.signingOut : t.common.signOut}
      </Button>
      {failed ? (
        <span role="alert" className="sr-only">
          {t.common.loadError}
        </span>
      ) : null}
    </div>
  );
}

/** Identity line for the mobile navigation panel. */
export function SessionSummary() {
  const { session } = useSession();
  const { rolesHeld } = useWorkspace();
  const { t } = useLocale();
  if (session.status !== 'authenticated') return null;
  return (
    <p className="mb-4 border-b border-gold-400/30 px-3 pb-3 text-sm text-ivory/80">
      {t.session.signedInAs}{' '}
      <span className="font-medium text-ivory">
        {session.user.givenName} {session.user.familyName}
      </span>{' '}
      ({roleSummary(t, session.user.systemRole, rolesHeld)})
    </p>
  );
}
