import type { Metadata } from 'next';
import { CourseImport } from '@/components/admin/courses/CourseImport';
import { localizedTitle } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('courseImport');
}

export default function CourseImportPage() {
  return <CourseImport />;
}
