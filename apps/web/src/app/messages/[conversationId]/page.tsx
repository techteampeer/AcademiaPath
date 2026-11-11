import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { ConversationView } from '@/components/messaging/MessagingViews';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('conversation');
}

export default async function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  return <ConversationView conversationId={conversationId} />;
}
