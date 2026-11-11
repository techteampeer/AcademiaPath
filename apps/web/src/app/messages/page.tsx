import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { MyMessagesView } from '@/components/messaging/MessagingViews';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('messages');
}

export default function MessagesPage() {
  return <MyMessagesView />;
}
