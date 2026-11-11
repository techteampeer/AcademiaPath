import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { MyGroupsView } from '@/components/groups/GroupViews';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('myGroups');
}

export default function MyGroupsPage() {
  return <MyGroupsView />;
}
