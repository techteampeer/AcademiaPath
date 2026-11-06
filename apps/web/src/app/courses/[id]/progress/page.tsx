import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { StudentProgressView } from '@/components/progress/StudentProgressView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('studentProgress');
}

export default async function StudentProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudentProgressView courseId={id} />;
}
