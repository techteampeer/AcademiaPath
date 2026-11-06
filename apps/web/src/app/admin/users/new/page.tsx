import type { Metadata } from 'next';
import { NewUserForm } from '@/components/admin/users/NewUserForm';
import { localizedTitle } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('newUser');
}

export default function NewUserPage() {
  return <NewUserForm />;
}
