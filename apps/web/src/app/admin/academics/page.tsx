import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { Suspense } from 'react';
import { AcademicHierarchy } from '@/components/admin/academics/AcademicHierarchy';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('academicStructure');
}

export default function AcademicStructurePage() {
  // The hierarchy keeps its selection in the URL (search params), so it renders inside Suspense.
  return (
    <Suspense fallback={<p className="text-sm text-slate-600">Loading academic structure…</p>}>
      <AcademicHierarchy />
    </Suspense>
  );
}
