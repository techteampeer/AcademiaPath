import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { VerifyCertificateView } from '@/components/certificates/VerifyCertificateView';

export async function generateMetadata(): Promise<Metadata> {
  return {
    ...(await localizedTitle('verifyCertificate')),
    // Verification links are shared on purpose, but never indexed or leaked as a referrer.
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

export default async function VerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <VerifyCertificateView token={token} />;
}
