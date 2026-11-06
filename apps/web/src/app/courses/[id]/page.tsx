import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { CourseDetail } from '@/components/courses/CourseDetail';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('course');
}

export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CourseDetail courseId={id} />;
}
