import type { Metadata } from 'next';
import { AcademicWorkspace } from '@/components/academic/AcademicWorkspace';
import { localizedTitle } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('academicManagement');
}

export default function AcademicManagementPage() {
  return <AcademicWorkspace />;
}
