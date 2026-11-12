import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { MESSAGES } from '@/lib/i18n/messages';
import { localizedTitle, serverLocale } from '@/lib/i18n/server';

/** Unknown addresses: rendered on the server in the interface language (the framework default is English only). */
export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('notFound');
}

export default async function NotFound() {
  const t = MESSAGES[await serverLocale()];
  return (
    <EmptyState
      titleAs="h1"
      title={t.common.notFoundTitle}
      description={t.common.notFoundBody}
      action={
        <Link href="/" className={buttonClasses({ variant: 'primary' })}>
          {t.common.goHome}
        </Link>
      }
    />
  );
}
