import type { Metadata } from 'next';
import { EnrollmentImport } from '@/components/admin/users/EnrollmentImport';
import { localizedTitle } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('bulkEnroll');
}

export default function EnrollmentImportPage() {
  return <EnrollmentImport />;
}
