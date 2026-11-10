import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { MyCertificatesView } from '@/components/certificates/MyCertificatesView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('myCertificates');
}

export default function MyCertificatesPage() {
  return <MyCertificatesView />;
}
