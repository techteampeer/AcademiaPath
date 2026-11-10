import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { AnnouncementDetailView } from '@/components/communications/AnnouncementViews';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('announcement');
}

export default async function AnnouncementPage({ params }: { params: Promise<{ announcementId: string }> }) {
  const { announcementId } = await params;
  return <AnnouncementDetailView announcementId={announcementId} />;
}
