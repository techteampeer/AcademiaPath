import type { Metadata } from 'next';
import { localizedTitle, serverLocale } from '@/lib/i18n/server';
import { MESSAGES } from '@/lib/i18n/messages';
import { Suspense } from 'react';
import { AcademicHierarchy } from '@/components/admin/academics/AcademicHierarchy';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('academicStructure');
}

export default async function AcademicStructurePage() {
  const t = MESSAGES[await serverLocale()];
  // The hierarchy keeps its selection in the URL (search params), so it renders inside Suspense.
  return (
    <Suspense
      fallback={
        <p role="status" className="text-sm text-slate-600">
          {t.common.loading}
        </p>
      }
    >
      <AcademicHierarchy />
    </Suspense>
  );
}
