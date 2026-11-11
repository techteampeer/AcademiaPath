'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { landingPathFor } from '@/components/session/WorkspaceProvider';
import { buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BrandMark, HeritageBanner, Icon } from '@/components/layout/Heritage';

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
  const icons = ['book', 'chart', 'users'] as const;
  return (
    <div className="space-y-8">
      <HeritageBanner className="min-h-[22rem] sm:min-h-[26rem]">
        <div className="max-w-xl py-4 sm:py-8">
          <div className="flex items-center gap-3">
            <BrandMark className="h-12 w-12 shrink-0" />
            <p className="text-sm font-semibold tracking-[0.14em] text-gold-200 uppercase">{t.login.tagline}</p>
          </div>
          <h1 className="mt-6 text-[2.1rem] leading-tight font-semibold text-ivory sm:text-5xl">{t.home.title}</h1>
          <div aria-hidden="true" className="heritage-rule mt-5 w-36" />
          <p className="mt-5 text-base text-ivory/90 sm:text-lg">{t.home.description}</p>
          <div className="mt-8">
            <Link href="/login" className={buttonClasses({ variant: 'light', size: 'lg' })}>
              {t.home.cta}
            </Link>
          </div>
        </div>
      </HeritageBanner>
      <ul className="grid gap-5 md:grid-cols-3">
        {t.home.features.map((feature, index) => (
          <li key={feature.title}>
            <Card className="h-full">
              <Icon name={icons[index] ?? 'dot'} className="h-7 w-7 text-gold-600" />
              <h2 className="mt-3 text-lg font-semibold">{feature.title}</h2>
              <p className="mt-2 text-sm text-slate-600">{feature.text}</p>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
