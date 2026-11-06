import type { Metadata } from 'next';
import { EnrollmentImport } from '@/components/admin/users/EnrollmentImport';

export const metadata: Metadata = { title: 'Bulk student enrollment' };

export default function EnrollmentImportPage() {
  return <EnrollmentImport />;
}
