'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { Button, buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

/** Unexpected rendering errors: a translated message with a retry, instead of the framework's English fallback. */
export default function RouteError({ error, retry }: { error: unknown; retry: () => void }) {
  const { t } = useLocale();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert">
      <EmptyState
        titleAs="h1"
        title={t.common.errorTitle}
        description={t.common.errorBody}
        action={
          <div className="flex flex-wrap justify-center gap-3">
            <Button onClick={() => retry()}>{t.common.retry}</Button>
            <Link href="/" className={buttonClasses({ variant: 'secondary' })}>
              {t.common.goHome}
            </Link>
          </div>
        }
      />
    </div>
  );
}
