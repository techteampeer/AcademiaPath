import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { MyCalendarView } from '@/components/communications/CalendarViews';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('calendar');
}

export default function CalendarPage() {
  return <MyCalendarView />;
}
