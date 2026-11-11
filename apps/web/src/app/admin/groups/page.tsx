import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { AdminGroupsView } from '@/components/groups/GroupViews';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('studentGroups');
}

export default function AdminGroupsPage() {
  return <AdminGroupsView />;
}
