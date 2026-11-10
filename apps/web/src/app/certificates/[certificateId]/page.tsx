import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { CertificateDetailView } from '@/components/certificates/CertificateDetailView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('certificate');
}

export default async function CertificatePage({ params }: { params: Promise<{ certificateId: string }> }) {
  const { certificateId } = await params;
  return <CertificateDetailView certificateId={certificateId} />;
}
