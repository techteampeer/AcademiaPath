import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { ScormInspectionView } from '@/components/scorm/ScormInspectionView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('scormInspection');
}

export default async function ScormInspectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ScormInspectionView courseId={id} />;
}
