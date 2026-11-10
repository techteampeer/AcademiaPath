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
import { Badge } from '@/components/ui/Badge';
import type { QuizFeedback, StudentQuizAttemptSummary } from '@/lib/api/types';
import { formatDateTimeOrDash } from '@/lib/i18n/messages';

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; summary: StudentQuizAttemptSummary };

/**
 * A student's correctness review of one released attempt (AP-022). The API decides availability; the
 * answer key is never part of the response, so only the student's own selections are shown.
 */
function AttemptFeedback({ courseId, attemptId }: { courseId: string; attemptId: string }) {
  const { t, locale } = useLocale();
  const a = t.assessment;
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; feedback: QuizFeedback }>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    api
      .quizFeedback(courseId, attemptId)
      .then((feedback) => !cancelled && setState({ status: 'ready', feedback }))
      .catch((error: unknown) => !cancelled && setState({ status: 'error', message: describeApiError(error, locale) }));
    return () => {
      cancelled = true;
    };
  }, [courseId, attemptId, locale]);
  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {a.loadingFeedback}
      </p>
    );
  }
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  const { feedback } = state;
  return (
    <section aria-label={a.feedbackHeading(feedback.attemptNumber)} className="mt-3 space-y-3 border-t border-slate-200 pt-3">
      <p className="text-xs text-slate-500">{a.feedbackNote}</p>
      <p className="font-medium text-slate-900">
        {a.points(feedback.score, feedback.maxScore)}
        {feedback.passed === null ? null : (
          <Badge tone={feedback.passed ? 'success' : 'warning'} className="ml-2">
            {feedback.passed ? a.passed : a.notPassed}
          </Badge>
        )}
      </p>
      <ol className="space-y-2">
        {feedback.questions.map((question, index) => {
          const chosen = question.options.filter((option) => question.selectedOptionIds.includes(option.id)).map((option) => option.text);
          return (
            <li key={question.questionId} className="rounded-md bg-slate-50 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-medium break-words text-slate-900">
                  {index + 1}. {question.prompt}
                </p>
                <Badge tone={question.isCorrect ? 'success' : 'warning'}>{question.isCorrect ? `✓ ${a.correct}` : `✗ ${a.incorrect}`}</Badge>
              </div>
              <p className="mt-1 text-slate-700">
                {a.yourAnswer} {chosen.length ? chosen.join(', ') : a.noAnswer}
              </p>
              <p className="text-xs text-slate-500">{a.points(question.awardedPoints, question.points)}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** A student's own attempts for one quiz, and the button to start or resume one. No scores are shown before release. */
export function QuizStudentPanel({ courseId, quizId }: { courseId: string; quizId: string }) {
  const router = useRouter();
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const q = t.quiz.student;
  const [state, setState] = useState<State>({ status: 'loading' });
  const [reviewing, setReviewing] = useState<string | null>(null);
  const { run, pending, result } = useCsrfAction();
  const as = t.assessment;

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
            {state.summary.attemptsRemaining > 0 ? <span className="text-slate-500"> · {as.remaining(state.summary.attemptsRemaining)}</span> : null}
          </p>
          {state.summary.passed !== null && state.summary.passingScorePercent !== null ? (
            <p className="text-sm font-medium text-slate-900" data-passed={String(state.summary.passed)}>
              <Badge tone={state.summary.passed ? 'success' : 'warning'} className="mr-2">
                {state.summary.passed ? as.passed : as.notPassed}
              </Badge>
              {as.passedLine(state.summary.passed, state.summary.passingScorePercent)}
            </p>
          ) : null}
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
            <p className="text-sm text-slate-600">{as.exhausted}</p>
          )}
          {state.summary.items.length ? (
            <ul className="space-y-2 text-sm">
              {state.summary.items.map((attempt) => (
                <li key={attempt.id} className="rounded-lg border border-slate-200 p-3" data-attempt={attempt.attemptNumber}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium text-slate-900">{q.attemptN(attempt.attemptNumber)}</span>
                      {' — '}
                      {attempt.status === 'in_progress'
                        ? q.inProgress
                        : `${q.recorded(formatDateTimeOrDash(attempt.submittedAt, locale))}${attempt.closedByTimeLimit ? ` ${q.closedAtLimit}` : ''}`}
                    </span>
                    {attempt.feedbackAvailable ? (
                      <Button size="sm" variant="secondary" aria-expanded={reviewing === attempt.id} onClick={() => setReviewing(reviewing === attempt.id ? null : attempt.id)}>
                        {reviewing === attempt.id ? as.hideFeedback : as.reviewFeedback}
                        <span className="sr-only">: {q.attemptN(attempt.attemptNumber)}</span>
                      </Button>
                    ) : null}
                  </div>
                  {reviewing === attempt.id ? <AttemptFeedback courseId={courseId} attemptId={attempt.id} /> : null}
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
