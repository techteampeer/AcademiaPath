'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { StudentQuizAttempt } from '@/lib/api/types';
import { formatDateTimeOrDash } from '@/lib/i18n/messages';

type ViewState = { status: 'loading' } | { status: 'not-found' } | { status: 'error' } | { status: 'ready'; attempt: StudentQuizAttempt };
type Selections = Record<string, string[]>;

export function QuizAttemptView({ courseId, attemptId }: { courseId: string; attemptId: string }) {
  return <RequireAuth>{() => <AttemptContent courseId={courseId} attemptId={attemptId} />}</RequireAuth>;
}

function selectionsOf(attempt: StudentQuizAttempt): Selections {
  return Object.fromEntries(attempt.questions.map((question) => [question.questionId, question.selectedOptionIds]));
}

/** Display-only countdown. The server enforces the deadline regardless of the browser clock. */
function TimeRemaining({ deadlineAt }: { deadlineAt: string }) {
  const { t, locale } = useLocale();
  const a = t.quiz.attempt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((Date.parse(deadlineAt) - now) / 1000));
  const display = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <p className="text-sm text-slate-700">
      {a.submitBefore(formatDateTimeOrDash(deadlineAt, locale))} {a.remaining} <span role="timer">{display}</span>. {a.serverCloses}
    </p>
  );
}

function AttemptContent({ courseId, attemptId }: { courseId: string; attemptId: string }) {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const a = t.quiz.attempt;
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [selections, setSelections] = useState<Selections>({});
  const [confirming, setConfirming] = useState(false);
  const { run, pending, result } = useCsrfAction();

  const show = useCallback((attempt: StudentQuizAttempt) => {
    setState({ status: 'ready', attempt });
    setSelections(selectionsOf(attempt));
  }, []);

  const load = useCallback(async () => {
    try {
      show(await api.getQuizAttempt(courseId, attemptId));
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      else if (isApiError(error, 404) || isApiError(error, 400) || isApiError(error, 403)) setState({ status: 'not-found' });
      else setState({ status: 'error' });
    }
  }, [courseId, attemptId, handleUnauthorized, show]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {a.loading}
      </p>
    );
  }
  if (state.status === 'not-found') {
    const back = (
      <Link href={`/courses/${courseId}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
        {a.backToCourse}
      </Link>
    );
    return <EmptyState titleAs="h1" title={a.notAvailableTitle} description={a.notAvailableDescription} action={back} />;
  }
  if (state.status === 'error') {
    return (
      <Alert tone="error">
        {a.loadError}{' '}
        <button type="button" className="font-medium underline" onClick={() => void load()}>
          {t.common.retry}
        </button>
      </Alert>
    );
  }

  const { attempt } = state;
  const quizHref = `/courses/${courseId}/activities/${attempt.activityId}`;
  const answers = attempt.questions.map((question) => ({
    questionId: question.questionId,
    selectedOptionIds: selections[question.questionId] ?? [],
  }));

  const choose = (questionId: string, optionId: string, multiple: boolean, checked: boolean) =>
    setSelections((current) => {
      const previous = current[questionId] ?? [];
      const next = multiple
        ? checked
          ? [...previous.filter((id) => id !== optionId), optionId]
          : previous.filter((id) => id !== optionId)
        : [optionId];
      return { ...current, [questionId]: next };
    });

  const save = async () => {
    const saved = await run(
      (csrf) => api.saveQuizAnswers(courseId, attempt.id, { answers }, csrf),
      () => a.saved,
    );
    if (saved) show(saved);
    else void load(); // e.g. the time limit passed: the server has closed the attempt.
  };

  const submit = async () => {
    setConfirming(false);
    const submitted = await run((csrf) => api.submitQuizAttempt(courseId, attempt.id, { answers }, csrf));
    if (submitted) show(submitted);
    else void load();
  };

  const header = (
    <div>
      <Link href={quizHref} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
        {a.backToQuiz}
      </Link>
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{a.title(attempt.attemptNumber, attempt.attemptLimit)}</h1>
    </div>
  );

  if (attempt.status === 'submitted') {
    return (
      <div className="space-y-6">
        {header}
        <Card as="section" aria-labelledby="recorded-heading" className="space-y-3">
          <h2 id="recorded-heading" className="text-lg font-semibold text-emerald-800">
            {a.recordedHeading}
          </h2>
          <p className="text-sm text-slate-700">{a.recordedAt(formatDateTimeOrDash(attempt.submittedAt, locale))}</p>
          {attempt.closedByTimeLimit ? (
            <Alert tone="info">
              {a.closedByLimit}
            </Alert>
          ) : null}
          {attempt.resultsReleased ? (
            <p className="text-sm text-slate-700">
              {a.released}{' '}
              <Link href={`/courses/${courseId}/grades`} className="font-medium text-brand-700 hover:underline">
                {a.seeGrades}
              </Link>
            </p>
          ) : (
            <p className="text-sm text-slate-700">
              {a.graded}
            </p>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      {attempt.deadlineAt ? <TimeRemaining deadlineAt={attempt.deadlineAt} /> : null}
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setConfirming(true);
        }}
        className="space-y-4"
      >
        {attempt.questions.map((question, index) => {
          const multiple = question.type === 'multiple_choice';
          const selected = new Set(selections[question.questionId] ?? []);
          return (
            <Card key={question.questionId}>
              <fieldset className="space-y-2">
                <legend className="font-medium break-words text-slate-900">
                  {index + 1}. {question.prompt}
                </legend>
                <p className="text-xs text-slate-500">
                  {t.quiz.points(question.points)}
                  {multiple ? ` · ${a.selectAll}` : ''}
                </p>
                {question.options.map((option) => {
                  const inputId = `q-${question.questionId}-${option.id}`;
                  return (
                    <div key={option.id} className="flex items-center gap-2">
                      <input
                        id={inputId}
                        type={multiple ? 'checkbox' : 'radio'}
                        name={`q-${question.questionId}`}
                        checked={selected.has(option.id)}
                        onChange={(event) => choose(question.questionId, option.id, multiple, event.target.checked)}
                        disabled={pending}
                      />
                      <label htmlFor={inputId} className="text-sm text-slate-800">
                        {option.text}
                      </label>
                    </div>
                  );
                })}
              </fieldset>
            </Card>
          );
        })}
        {confirming ? (
          <Alert tone="info" className="space-y-3">
            <p>{a.confirm}</p>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => void submit()} disabled={pending}>
                {a.confirmSubmit}
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
                {a.keepWorking}
              </Button>
            </div>
          </Alert>
        ) : (
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => void save()} disabled={pending}>
              {pending ? a.saving : a.save}
            </Button>
            <Button type="submit" disabled={pending}>
              {a.submit}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}
