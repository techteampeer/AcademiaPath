import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { QuizAttemptView } from '@/components/quizzes/QuizAttemptView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('attempt');
}

export default async function QuizAttemptPage({ params }: { params: Promise<{ id: string; attemptId: string }> }) {
  const { id, attemptId } = await params;
  return <QuizAttemptView courseId={id} attemptId={attemptId} />;
}
