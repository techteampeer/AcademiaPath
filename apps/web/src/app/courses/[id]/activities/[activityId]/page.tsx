import type { Metadata } from 'next';
import { LessonView } from '@/components/content/LessonView';

export const metadata: Metadata = {
  title: 'Lesson',
};

export default async function LessonPage({ params }: { params: Promise<{ id: string; activityId: string }> }) {
  const { id, activityId } = await params;
  return <LessonView courseId={id} activityId={activityId} />;
}
