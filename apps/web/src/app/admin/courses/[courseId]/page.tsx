import type { Metadata } from 'next';
import { CourseManager } from '@/components/admin/courses/CourseManager';
import { localizedTitle } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('manageCourse');
}

export default async function ManageCoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  return <CourseManager courseId={courseId} />;
}
