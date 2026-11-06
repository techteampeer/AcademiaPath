import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { RoleDashboard } from '@/components/dashboard/RoleDashboard';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('dashboard');
}

export default function DashboardPage() {
  return <RoleDashboard />;
}
