import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { CourseGroupsView } from '@/components/groups/GroupViews';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('courseGroups');
}

export default async function CourseGroupsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CourseGroupsView courseId={id} />;
}
