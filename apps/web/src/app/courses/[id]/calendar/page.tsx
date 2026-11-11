import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { CourseCalendarView } from '@/components/communications/CalendarViews';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('calendar');
}

export default async function CourseCalendarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CourseCalendarView courseId={id} />;
}
