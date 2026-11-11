import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { AdminMessagingView } from '@/components/messaging/AdminMessagingView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('courseMessaging');
}

export default function AdminMessagingPage() {
  return <AdminMessagingView />;
}
