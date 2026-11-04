import type { Metadata } from 'next';
import { TutorView } from '@/components/tutor/TutorView';

export const metadata: Metadata = {
  title: 'Tutor',
};

export default async function TutorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TutorView courseId={id} />;
}
