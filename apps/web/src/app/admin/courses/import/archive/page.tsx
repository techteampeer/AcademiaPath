import type { Metadata } from 'next';
import { CourseArchivePreview } from '@/components/admin/courses/CourseArchivePreview';
import { localizedTitle } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('courseArchivePreview');
}

export default function CourseArchivePreviewPage() {
  return <CourseArchivePreview />;
}
