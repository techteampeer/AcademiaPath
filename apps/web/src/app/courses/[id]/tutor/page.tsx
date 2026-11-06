import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { TutorView } from '@/components/tutor/TutorView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('tutor');
}

export default async function TutorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TutorView courseId={id} />;
}
