'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { StudentAssignmentStatus } from '@/lib/api/types';
import { formatDateTime, ReleasedGradeView } from './assignmentDisplay';

const BODY_LIMIT = 50000;
type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: StudentAssignmentStatus };

/** A student's own submission: text form, confirmation, and the grade only after release. */
export function AssignmentStudentPanel({ courseId, assignmentId }: { courseId: string; assignmentId: string }) {
  const { handleUnauthorized } = useSession();
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
      setState({ status: 'error', message: describeApiError(error) });
    }
  }, [courseId, assignmentId, handleUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const review = () => {
    if (!body.trim()) return setBodyError('Write your answer before submitting.');
    if (body.length > BODY_LIMIT) return setBodyError(`Use at most ${BODY_LIMIT} characters.`);
    setBodyError(null);
    setConfirming(true);
  };

  const submit = async () => {
    setConfirming(false);
    const submitted = await run((csrf) => api.submitAssignment(courseId, assignmentId, body, csrf), () => 'Your submission was recorded.');
    if (submitted) setBody('');
    await load();
  };

  return (
    <Card as="section" aria-labelledby="my-submission-heading" className="space-y-4">
      <h2 id="my-submission-heading" className="text-lg font-semibold text-slate-900">
        Your submission
      </h2>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      {state.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          Loading your submission…
        </p>
      ) : state.status === 'error' ? (
        <Alert tone="error">{state.message}</Alert>
      ) : state.data.submission ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-emerald-800">
            Submitted {formatDateTime(state.data.submission.submittedAt)}
            {state.data.submission.isLate ? ' (late)' : ''}. This is your final submission.
          </p>
          <div className="whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">
            {state.data.submission.body}
          </div>
          <section aria-labelledby="my-grade-heading" className="space-y-2 border-t border-slate-200 pt-3">
            <h3 id="my-grade-heading" className="font-semibold text-slate-900">
              Grade
            </h3>
            {state.data.submission.grade ? (
              <ReleasedGradeView grade={state.data.submission.grade} />
            ) : (
              <p className="text-sm text-slate-600">Pending. Your instructor has not released grades for this assignment yet.</p>
            )}
          </section>
        </div>
      ) : state.data.acceptingSubmissions ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            You can submit once. {state.data.lateUntil ? `Work submitted after ${formatDateTime(state.data.dueAt)} is marked late.` : ''}
          </p>
          <div>
            <label htmlFor="submission-body" className="block text-sm font-medium text-slate-800">
              Your answer
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
              Plain text. The server records the submission time.
            </p>
            {bodyError ? (
              <p id="submission-body-error" className="mt-1 text-sm text-red-700">
                {bodyError}
              </p>
            ) : null}
          </div>
          {confirming ? (
            <Alert tone="info" className="space-y-3">
              <p>Submit now? You cannot change your submission afterwards.</p>
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => void submit()} disabled={pending}>
                  Confirm submission
                </Button>
                <Button variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
                  Keep editing
                </Button>
              </div>
            </Alert>
          ) : (
            <Button onClick={review} disabled={pending}>
              {pending ? 'Submitting…' : 'Submit assignment'}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-600">Submissions are closed for this assignment.</p>
      )}
    </Card>
  );
}
