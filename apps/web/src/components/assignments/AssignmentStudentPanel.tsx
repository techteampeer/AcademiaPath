'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { StudentAssignmentStatus } from '@/lib/api/types';
import { formatDateTimeOrDash } from '@/lib/i18n/messages';
import { ReleasedGradeView } from './assignmentDisplay';

const BODY_LIMIT = 50000;
type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: StudentAssignmentStatus };

/** A student's own submission: text form, confirmation, and the grade only after release. */
export function AssignmentStudentPanel({ courseId, assignmentId }: { courseId: string; assignmentId: string }) {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const a = t.assignments.student;
  const [state, setState] = useState<State>({ status: 'loading' });
  const [body, setBody] = useState('');
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { run, pending, result } = useCsrfAction();

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', data: await api.myAssignmentStatus(courseId, assignmentId) });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [courseId, assignmentId, handleUnauthorized, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const review = () => {
    if (!body.trim()) return setBodyError(a.writeFirst);
    if (body.length > BODY_LIMIT) return setBodyError(t.errors.maxChars(BODY_LIMIT));
    setBodyError(null);
    setConfirming(true);
  };

  const submit = async () => {
    setConfirming(false);
    const submitted = await run((csrf) => api.submitAssignment(courseId, assignmentId, body, csrf), () => a.recorded);
    if (submitted) setBody('');
    await load();
  };

  return (
    <Card as="section" aria-labelledby="my-submission-heading" className="space-y-4">
      <h2 id="my-submission-heading" className="text-lg font-semibold text-slate-900">
        {a.heading}
      </h2>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      {state.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          {a.loading}
        </p>
      ) : state.status === 'error' ? (
        <Alert tone="error">{state.message}</Alert>
      ) : state.data.submission ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-emerald-800">
            {a.submittedAt(formatDateTimeOrDash(state.data.submission.submittedAt, locale), state.data.submission.isLate)}
          </p>
          <div className="whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">
            {state.data.submission.body}
          </div>
          <section aria-labelledby="my-grade-heading" className="space-y-2 border-t border-slate-200 pt-3">
            <h3 id="my-grade-heading" className="font-semibold text-slate-900">
              {a.grade}
            </h3>
            {state.data.submission.grade ? (
              <ReleasedGradeView grade={state.data.submission.grade} />
            ) : (
              <p className="text-sm text-slate-600">{a.pending}</p>
            )}
          </section>
        </div>
      ) : state.data.acceptingSubmissions ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {a.once} {state.data.lateUntil ? a.lateNote(formatDateTimeOrDash(state.data.dueAt, locale)) : ''}
          </p>
          <div>
            <label htmlFor="submission-body" className="block text-sm font-medium text-slate-800">
              {a.answer}
            </label>
            <textarea
              id="submission-body"
              rows={10}
              value={body}
              maxLength={BODY_LIMIT}
              onChange={(event) => setBody(event.target.value)}
              disabled={pending}
              aria-invalid={bodyError ? true : undefined}
              aria-describedby={`submission-body-hint${bodyError ? ' submission-body-error' : ''}`}
              className={`mt-1 block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ${bodyError ? 'border-red-500' : 'border-slate-300'}`}
            />
            <p id="submission-body-hint" className="mt-1 text-xs text-slate-500">
              {a.answerHint}
            </p>
            {bodyError ? (
              <p id="submission-body-error" className="mt-1 text-sm text-red-700">
                {bodyError}
              </p>
            ) : null}
          </div>
          {confirming ? (
            <Alert tone="info" className="space-y-3">
              <p>{a.confirm}</p>
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => void submit()} disabled={pending}>
                  {a.confirmSubmit}
                </Button>
                <Button variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
                  {a.keepEditing}
                </Button>
              </div>
            </Alert>
          ) : (
            <Button onClick={review} disabled={pending}>
              {pending ? a.submitting : a.submit}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-600">{a.closed}</p>
      )}
    </Card>
  );
}
