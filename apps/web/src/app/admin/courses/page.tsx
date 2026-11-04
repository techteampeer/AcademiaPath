import type { Metadata } from 'next';
import { CoursesAdmin } from '@/components/admin/workspace/CoursesAdmin';

export const metadata: Metadata = { title: 'Courses & enrollments' };

export default function AdminCoursesPage() {
  return <CoursesAdmin />;
}
