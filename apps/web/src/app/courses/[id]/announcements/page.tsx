import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { CourseAnnouncementsView } from '@/components/communications/AnnouncementViews';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('announcements');
}

export default async function CourseAnnouncementsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CourseAnnouncementsView courseId={id} />;
}
