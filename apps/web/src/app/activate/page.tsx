import type { Metadata } from 'next';
import { ActivateAccount } from '@/components/session/ActivateAccount';

export const metadata: Metadata = {
  title: 'Activate account',
  // The page is reached through single-use links; never index it or leak its URL as a referrer.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function ActivatePage() {
  return <ActivateAccount />;
}
