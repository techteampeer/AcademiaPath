import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { LessonView } from '@/components/content/LessonView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('content');
}

export default async function LessonPage({ params }: { params: Promise<{ id: string; activityId: string }> }) {
  const { id, activityId } = await params;
  return <LessonView courseId={id} activityId={activityId} />;
}
