import type { Metadata } from 'next';
import { QuizAttemptView } from '@/components/quizzes/QuizAttemptView';

export const metadata: Metadata = {
  title: 'Quiz attempt',
};

export default async function QuizAttemptPage({ params }: { params: Promise<{ id: string; attemptId: string }> }) {
  const { id, attemptId } = await params;
  return <QuizAttemptView courseId={id} attemptId={attemptId} />;
}
