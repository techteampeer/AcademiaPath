import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { CourseEmailView } from '@/components/communications/CourseEmailView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('courseEmail');
}

export default async function CourseEmailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CourseEmailView courseId={id} />;
}
