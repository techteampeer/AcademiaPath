import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { CourseCertificatesView } from '@/components/certificates/CourseCertificatesView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('certificates');
}

export default async function CourseCertificatesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CourseCertificatesView courseId={id} />;
}
