import type { Metadata } from 'next';
import { UsersDirectory } from '@/components/admin/users/UsersDirectory';
import { localizedTitle } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('users');
}

export default function AdminUsersPage() {
  return <UsersDirectory />;
}
