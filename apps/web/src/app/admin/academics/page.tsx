import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AcademicHierarchy } from '@/components/admin/academics/AcademicHierarchy';

export const metadata: Metadata = {
  title: 'Academic structure',
};

export default function AcademicStructurePage() {
  // The hierarchy keeps its selection in the URL (search params), so it renders inside Suspense.
  return (
    <Suspense fallback={<p className="text-sm text-slate-600">Loading academic structure…</p>}>
      <AcademicHierarchy />
    </Suspense>
  );
}
