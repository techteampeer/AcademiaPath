import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { CourseForumView } from '@/components/forums/ForumViews';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('forum');
}

export default async function CourseForumPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CourseForumView courseId={id} />;
}
