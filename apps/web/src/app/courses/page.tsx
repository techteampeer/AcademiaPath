import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { CourseList } from '@/components/courses/CourseList';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('myCourses');
}

export default function CoursesPage() {
  return <CourseList />;
}
