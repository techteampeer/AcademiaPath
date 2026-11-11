import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { AdminCommunicationsView } from '@/components/communications/AdminCommunicationsView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('institutionCommunications');
}

export default function AdminCommunicationsPage() {
  return <AdminCommunicationsView />;
}
