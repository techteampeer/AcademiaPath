import type { Metadata } from 'next';
import { ActivateAccount } from '@/components/session/ActivateAccount';
import { localizedTitle } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return {
    ...(await localizedTitle('activate')),
    // The page is reached through single-use links; never index it or leak its URL as a referrer.
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

export default function ActivatePage() {
  return <ActivateAccount />;
}
