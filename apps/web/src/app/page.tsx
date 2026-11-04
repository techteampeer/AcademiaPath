'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { landingPathFor } from '@/components/session/WorkspaceProvider';
import { buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

/** Public entry point: signed-in users go straight to their workspace. */
export default function HomePage() {
  const { session } = useSession();
  const { t } = useLocale();
  const router = useRouter();

  useEffect(() => {
    if (session.status === 'authenticated') router.replace(landingPathFor(session.user));
  }, [session, router]);

  if (session.status !== 'unauthenticated') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {t.common.loading}
      </p>
    );
  }
  return (
    <Card padding="lg" className="bg-linear-to-br from-brand-50 to-white">
      <p className="text-sm font-semibold tracking-wider text-brand-600 uppercase">{t.login.tagline}</p>
      <h1 className="mt-3 max-w-3xl text-3xl font-bold tracking-tight text-brand-900 sm:text-4xl">{t.home.title}</h1>
      <p className="mt-4 max-w-2xl text-base text-slate-600 sm:text-lg">{t.home.description}</p>
      <div className="mt-6">
        <Link href="/login" className={buttonClasses()}>
          {t.home.cta}
        </Link>
      </div>
    </Card>
  );
}
