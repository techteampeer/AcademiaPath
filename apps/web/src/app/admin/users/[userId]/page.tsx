import type { Metadata } from 'next';
import { UserDetailView } from '@/components/admin/users/UserDetailView';

export const metadata: Metadata = { title: 'User' };

export default async function UserPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  return <UserDetailView userId={userId} />;
}
