import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { MyAnnouncementsView } from '@/components/communications/AnnouncementViews';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('announcements');
}

export default function AnnouncementsPage() {
  return <MyAnnouncementsView />;
}
