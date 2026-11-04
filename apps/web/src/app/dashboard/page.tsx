import type { Metadata } from 'next';
import { RoleDashboard } from '@/components/dashboard/RoleDashboard';

export const metadata: Metadata = {
  title: 'Dashboard',
};

export default function DashboardPage() {
  return <RoleDashboard />;
}
