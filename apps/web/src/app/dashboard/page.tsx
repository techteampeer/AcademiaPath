import type { Metadata } from 'next';
import { CourseDashboard } from '@/components/courses/CourseDashboard';

export const metadata: Metadata = {
  title: 'Dashboard',
};

export default function DashboardPage() {
  return <CourseDashboard />;
}
