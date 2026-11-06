'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { StudentQuizAttemptSummary } from '@/lib/api/types';
import { formatDateTimeOrDash } from '@/lib/i18n/messages';

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; summary: StudentQuizAttemptSummary };

/** A student's own attempts for one quiz, and the button to start or resume one. No scores are shown. */
export function QuizStudentPanel({ courseId, quizId }: { courseId: string; quizId: string }) {
  const router = useRouter();
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const q = t.quiz.student;
  const [state, setState] = useState<State>({ status: 'loading' });
  const { run, pending, result } = useCsrfAction();

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', summary: await api.myQuizAttempts(courseId, quizId) });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [courseId, quizId, handleUnauthorized, locale]);

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
        {q.heading}
      </h2>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      {state.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          {q.loading}
        </p>
      ) : state.status === 'error' ? (
        <Alert tone="error">{state.message}</Alert>
      ) : (
        <>
          <p className="text-sm text-slate-700">
            {q.used(state.summary.attemptsUsed, state.summary.attemptLimit)}
          </p>
          {state.summary.activeAttemptId ? (
            <Link href={`/courses/${courseId}/attempts/${state.summary.activeAttemptId}`} className={buttonClasses({})}>
              {q.resume}
            </Link>
          ) : state.summary.attemptsUsed < state.summary.attemptLimit ? (
            <div className="space-y-2">
              {state.summary.timeLimitMinutes ? (
                <p className="text-sm text-slate-600">
                  {q.timed(state.summary.timeLimitMinutes)}
                </p>
              ) : null}
              <Button onClick={() => void start()} disabled={pending}>
                {pending ? q.starting : state.summary.attemptsUsed ? q.startNew : q.start}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-slate-600">{q.noneLeft}</p>
          )}
          {state.summary.items.length ? (
            <ul className="space-y-2 text-sm">
              {state.summary.items.map((attempt) => (
                <li key={attempt.id} className="rounded-lg border border-slate-200 p-3">
                  <span className="font-medium text-slate-900">{q.attemptN(attempt.attemptNumber)}</span>
                  {' — '}
                  {attempt.status === 'in_progress'
                    ? q.inProgress
                    : `${q.recorded(formatDateTimeOrDash(attempt.submittedAt, locale))}${attempt.closedByTimeLimit ? ` ${q.closedAtLimit}` : ''}`}
                </li>
              ))}
            </ul>
          ) : null}
          {state.summary.gradeReleased ? (
            <p className="text-sm text-slate-700">
              {q.released}{' '}
              <Link href={`/courses/${courseId}/grades`} className="font-medium text-brand-700 hover:underline">
                {q.seeGrades}
              </Link>
            </p>
          ) : state.summary.items.some((attempt) => attempt.status === 'submitted') ? (
            <p className="text-sm text-slate-600">{q.notReleased}</p>
          ) : null}
        </>
      )}
    </Card>
  );
}
