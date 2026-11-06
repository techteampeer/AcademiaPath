import type { Metadata } from 'next';
import { UserDetailView } from '@/components/admin/users/UserDetailView';
import { localizedTitle } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('user');
}

export default async function UserPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  return <UserDetailView userId={userId} />;
}
