import type { Metadata } from 'next';
import { StudyBriefView } from '@/components/documents/StudyBriefView';
import { localizedTitle } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('studyBrief');
}

export default async function StudyBriefPage({ params }: { params: Promise<{ id: string; activityId: string }> }) {
  const { id, activityId } = await params;
  return <StudyBriefView courseId={id} activityId={activityId} />;
}
