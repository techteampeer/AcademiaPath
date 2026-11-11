import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { GroupWorkspaceView } from '@/components/groups/GroupViews';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('group');
}

export default async function GroupWorkspacePage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  return <GroupWorkspaceView groupId={groupId} />;
}
