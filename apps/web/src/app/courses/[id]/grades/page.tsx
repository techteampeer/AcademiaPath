import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { GradesView } from '@/components/grades/GradesView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('grades');
}

export default async function GradesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GradesView courseId={id} />;
}
