import type { Metadata } from 'next';
import { NewUserForm } from '@/components/admin/users/NewUserForm';

export const metadata: Metadata = { title: 'New user' };

export default function NewUserPage() {
  return <NewUserForm />;
}
