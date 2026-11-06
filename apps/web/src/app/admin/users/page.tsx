import type { Metadata } from 'next';
import { UsersDirectory } from '@/components/admin/users/UsersDirectory';

export const metadata: Metadata = { title: 'Users' };

export default function AdminUsersPage() {
  return <UsersDirectory />;
}
