import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { CourseMessagesView } from '@/components/messaging/MessagingViews';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('messages');
}

export default async function CourseMessagesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CourseMessagesView courseId={id} />;
}
