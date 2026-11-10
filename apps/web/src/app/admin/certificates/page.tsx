import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { AdminCertificatesView } from '@/components/certificates/AdminCertificatesView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('certificates');
}

export default function AdminCertificatesPage() {
  return <AdminCertificatesView />;
}
