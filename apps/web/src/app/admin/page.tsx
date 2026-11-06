import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { AdminOverview } from '@/components/admin/workspace/AdminOverview';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('administration');
}

export default function AdminPage() {
  return <AdminOverview />;
}
