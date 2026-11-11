import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { ForumTopicView } from '@/components/forums/ForumViews';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('forumTopic');
}

export default async function ForumTopicPage({ params }: { params: Promise<{ id: string; topicId: string }> }) {
  const { id, topicId } = await params;
  return <ForumTopicView courseId={id} topicId={topicId} />;
}
