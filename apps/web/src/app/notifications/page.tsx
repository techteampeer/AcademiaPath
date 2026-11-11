import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { NotificationsView } from '@/components/messaging/NotificationsView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('notifications');
}

export default function NotificationsPage() {
  return <NotificationsView />;
}
