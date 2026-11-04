import type { Metadata } from 'next';
import { GradesView } from '@/components/grades/GradesView';

export const metadata: Metadata = {
  title: 'Grades',
};

export default async function GradesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GradesView courseId={id} />;
}
