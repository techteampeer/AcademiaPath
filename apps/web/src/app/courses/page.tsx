import type { Metadata } from 'next';
import { CourseList } from '@/components/courses/CourseList';

export const metadata: Metadata = { title: 'My courses' };

export default function CoursesPage() {
  return <CourseList />;
}
