import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { AdminForumsView } from '@/components/forums/AdminForumsView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('courseForums');
}

export default function AdminForumsPage() {
  return <AdminForumsView />;
}
