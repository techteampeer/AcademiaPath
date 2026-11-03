import type { Metadata } from 'next';
import { AcademicSetup } from '@/components/admin/AcademicSetup';

export const metadata: Metadata = {
  title: 'Academic setup',
};

export default function AcademicSetupPage() {
  return <AcademicSetup />;
}
