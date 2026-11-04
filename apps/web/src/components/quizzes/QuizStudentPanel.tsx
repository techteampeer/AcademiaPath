'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { StudentQuizAttemptSummary } from '@/lib/api/types';
import { formatDateTime } from './quizDisplay';

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; summary: StudentQuizAttemptSummary };

/** A student's own attempts for one quiz, and the button to start or resume one. No scores are shown. */
export function QuizStudentPanel({ courseId, quizId }: { courseId: string; quizId: string }) {
  const router = useRouter();
  const { handleUnauthorized } = useSession();
  const [state, setState] = useState<State>({ status: 'loading' });
  const { run, pending, result } = useCsrfAction();

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', summary: await api.myQuizAttempts(courseId, quizId) });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error', message: describeApiError(error) });
    }
  }, [courseId, quizId, handleUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const start = async () => {
    const attempt = await run((csrf) => api.startQuizAttempt(courseId, quizId, csrf));
    if (attempt) router.push(`/courses/${courseId}/attempts/${attempt.id}`);
    else void load();
  };

  return (
    <Card as="section" aria-labelledby="my-attempts-heading" className="space-y-4">
      <h2 id="my-attempts-heading" className="text-lg font-semibold text-slate-900">
        Your attempts
      </h2>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      {state.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          Loading your attempts…
        </p>
      ) : state.status === 'error' ? (
        <Alert tone="error">{state.message}</Alert>
      ) : (
        <>
          <p className="text-sm text-slate-700">
            Attempts used: {state.summary.attemptsUsed} of {state.summary.attemptLimit}
          </p>
          {state.summary.activeAttemptId ? (
            <Link href={`/courses/${courseId}/attempts/${state.summary.activeAttemptId}`} className={buttonClasses({})}>
              Resume attempt
            </Link>
          ) : state.summary.attemptsUsed < state.summary.attemptLimit ? (
            <div className="space-y-2">
              {state.summary.timeLimitMinutes ? (
                <p className="text-sm text-slate-600">
                  You will have {state.summary.timeLimitMinutes} minutes. The timer starts when you begin and is kept by the server.
                </p>
              ) : null}
              <Button onClick={() => void start()} disabled={pending}>
                {pending ? 'Starting…' : state.summary.attemptsUsed ? 'Start a new attempt' : 'Start quiz'}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-slate-600">You have used all attempts for this quiz.</p>
          )}
          {state.summary.items.length ? (
            <ul className="space-y-2 text-sm">
              {state.summary.items.map((attempt) => (
                <li key={attempt.id} className="rounded-lg border border-slate-200 p-3">
                  <span className="font-medium text-slate-900">Attempt {attempt.attemptNumber}</span>
                  {' — '}
                  {attempt.status === 'in_progress'
                    ? 'in progress'
                    : `recorded ${formatDateTime(attempt.submittedAt)}${attempt.closedByTimeLimit ? ' (closed at the time limit)' : ''}`}
                </li>
              ))}
            </ul>
          ) : null}
          {state.summary.gradeReleased ? (
            <p className="text-sm text-slate-700">
              Your grade for this quiz has been released (best attempt).{' '}
              <Link href={`/courses/${courseId}/grades`} className="font-medium text-brand-700 hover:underline">
                See my grades
              </Link>
            </p>
          ) : state.summary.items.some((attempt) => attempt.status === 'submitted') ? (
            <p className="text-sm text-slate-600">Results have not been released yet. Your instructor will publish them later.</p>
          ) : null}
        </>
      )}
    </Card>
  );
}
