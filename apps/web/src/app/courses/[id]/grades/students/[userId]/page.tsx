import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { StudentGradebookView } from '@/components/grades/StudentGradebookView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('studentGrades');
}

export default async function StudentGradesPage({ params }: { params: Promise<{ id: string; userId: string }> }) {
  const { id, userId } = await params;
  return <StudentGradebookView courseId={id} userId={userId} />;
}
