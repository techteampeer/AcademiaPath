import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { CoursesAdmin } from '@/components/admin/workspace/CoursesAdmin';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('coursesEnrollments');
}

export default function AdminCoursesPage() {
  return <CoursesAdmin />;
}
