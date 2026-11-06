import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { AcademicSetup } from '@/components/admin/AcademicSetup';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('courseSetup');
}

export default function AcademicSetupPage() {
  return <AcademicSetup />;
}
