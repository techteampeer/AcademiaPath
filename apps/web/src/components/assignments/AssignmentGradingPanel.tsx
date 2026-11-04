'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ReleaseGradesButton } from '@/components/grades/ReleaseGradesButton';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { AssignmentSubmissionDetail, AssignmentSubmissionSummary } from '@/lib/api/types';
import { formatDateTime, formatGrade20, GradeStatusBadge } from './assignmentDisplay';

type Load<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };
const FEEDBACK_LIMIT = 5000;

/** Submissions with grading status. Graders score each rubric criterion; the server computes the grade. */
export function AssignmentGradingPanel({ courseId, assignmentId, canGrade }: { courseId: string; assignmentId: string; canGrade: boolean }) {
  const { handleUnauthorized } = useSession();
  const [list, setList] = useState<Load<AssignmentSubmissionSummary[]>>({ status: 'loading' });
  const [selected, setSelected] = useState<Load<AssignmentSubmissionDetail> | null>(null);

  const fail = useCallback(
    (error: unknown) => {
      if (isApiError(error, 401)) handleUnauthorized();
      return describeApiError(error);
    },
    [handleUnauthorized],
  );

  const load = useCallback(async () => {
    try {
      setList({ status: 'ready', data: (await api.listSubmissions(courseId, assignmentId, { limit: 100 })).items });
    } catch (error) {
      setList({ status: 'error', message: fail(error) });
    }
  }, [courseId, assignmentId, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (submissionId: string) => {
    setSelected({ status: 'loading' });
    try {
      setSelected({ status: 'ready', data: await api.getSubmission(courseId, assignmentId, submissionId) });
    } catch (error) {
      setSelected({ status: 'error', message: fail(error) });
    }
  };

  return (
    <Card as="section" aria-labelledby="submissions-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="submissions-heading" className="text-lg font-semibold text-slate-900">
          Submissions
        </h2>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      <p className="text-sm text-slate-600">
        Grades are calculated by the server from the rubric and stay hidden from students until you release them.
      </p>
      {canGrade ? <ReleaseGradesButton courseId={courseId} activityId={assignmentId} label="Release assignment grades" onReleased={() => void load()} /> : null}
      {list.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          Loading submissions…
        </p>
      ) : list.status === 'error' ? (
        <Alert tone="error">{list.message}</Alert>
      ) : list.data.length === 0 ? (
        <p className="text-sm text-slate-600">No submissions yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">Student</th>
                <th scope="col" className="py-2 pr-4 font-medium">Submitted</th>
                <th scope="col" className="py-2 pr-4 font-medium">Grade</th>
                <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((row) => (
                <tr key={row.id} className="border-b border-slate-100">
                  <td className="py-2 pr-4">
                    <span className="block text-slate-900">
                      {row.student.givenName} {row.student.familyName}
                    </span>
                    <span className="block text-xs break-all text-slate-500">{row.student.email}</span>
                  </td>
                  <td className="py-2 pr-4">
                    {formatDateTime(row.submittedAt)}
                    {row.isLate ? <span className="ml-1 text-xs font-medium text-amber-700">(late)</span> : null}
                  </td>
                  <td className="py-2 pr-4 font-medium">
                    {row.grade ? `${row.grade.points} / ${row.grade.maxPoints} · ${formatGrade20(row.grade.grade20)}` : '—'}
                  </td>
                  <td className="py-2 pr-4">
                    <GradeStatusBadge status={row.status} />
                  </td>
                  <td className="py-2">
                    <Button variant="ghost" size="sm" onClick={() => void open(row.id)}>
                      {canGrade ? 'Grade' : 'View'}
                      <span className="sr-only"> submission of {row.student.email}</span>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected?.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          Loading submission…
        </p>
      ) : selected?.status === 'error' ? (
        <Alert tone="error">{selected.message}</Alert>
      ) : selected?.status === 'ready' ? (
        <GradingForm
          key={selected.data.id}
          courseId={courseId}
          assignmentId={assignmentId}
          submission={selected.data}
          canGrade={canGrade}
          onSaved={(saved) => {
            setSelected({ status: 'ready', data: saved });
            void load();
          }}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </Card>
  );
}

function GradingForm({
  courseId,
  assignmentId,
  submission,
  canGrade,
  onSaved,
  onClose,
}: {
  courseId: string;
  assignmentId: string;
  submission: AssignmentSubmissionDetail;
  canGrade: boolean;
  onSaved: (saved: AssignmentSubmissionDetail) => void;
  onClose: () => void;
}) {
  const initial = new Map(submission.scores.map((score) => [score.criterionId, String(score.points)]));
  const [points, setPoints] = useState<Record<string, string>>(Object.fromEntries(submission.rubric.map((c) => [c.id, initial.get(c.id) ?? ''])));
  const [feedback, setFeedback] = useState(submission.feedback ?? '');
  const [error, setError] = useState<string | null>(null);
  const { run, pending, result } = useCsrfAction();

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    for (const criterion of submission.rubric) {
      const value = points[criterion.id] ?? '';
      const n = Number(value);
      if (!/^\d+$/.test(value.trim()) || n > criterion.maxPoints) {
        setError(`"${criterion.title}": enter whole points from 0 to ${criterion.maxPoints}.`);
        return;
      }
    }
    if (feedback.length > FEEDBACK_LIMIT) {
      setError(`Feedback can have at most ${FEEDBACK_LIMIT} characters.`);
      return;
    }
    setError(null);
    const saved = await run(
      (csrf) =>
        api.gradeSubmission(
          courseId,
          assignmentId,
          submission.id,
          {
            scores: submission.rubric.map((criterion) => ({ criterionId: criterion.id, points: Number(points[criterion.id]) })),
            ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
          },
          csrf,
        ),
      (value) => `Grade saved: ${value.grade?.points ?? 0} / ${value.grade?.maxPoints ?? 0} (${formatGrade20(value.grade?.grade20 ?? null)}), calculated by the server.`,
    );
    if (saved) onSaved(saved);
  };

  return (
    <section aria-labelledby="grading-heading" className="space-y-4 border-t border-slate-200 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="grading-heading" className="font-semibold text-slate-900">
          {submission.student.givenName} {submission.student.familyName}
          {submission.grade ? ` — ${submission.grade.points} / ${submission.grade.maxPoints} (${formatGrade20(submission.grade.grade20)})` : ''}
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="text-xs text-slate-500">
        Submitted {formatDateTime(submission.submittedAt)}
        {submission.isLate ? ' (late)' : ''}
      </p>
      <div className="whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">{submission.body}</div>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      <form noValidate onSubmit={save} className="space-y-3">
        <fieldset className="space-y-2" disabled={!canGrade || pending}>
          <legend className="text-sm font-medium text-slate-800">Rubric</legend>
          {submission.rubric.map((criterion) => (
            <div key={criterion.id} className="flex flex-wrap items-center gap-3">
              <label htmlFor={`score-${criterion.id}`} className="min-w-0 flex-1 text-sm text-slate-800">
                {criterion.title} <span className="text-slate-500">(0–{criterion.maxPoints})</span>
              </label>
              <input
                id={`score-${criterion.id}`}
                inputMode="numeric"
                value={points[criterion.id] ?? ''}
                onChange={(event) => setPoints((current) => ({ ...current, [criterion.id]: event.target.value }))}
                className="w-24 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
              />
            </div>
          ))}
        </fieldset>
        <div>
          <label htmlFor="grading-feedback" className="block text-sm font-medium text-slate-800">
            Feedback for the student (optional)
          </label>
          <textarea
            id="grading-feedback"
            rows={4}
            maxLength={FEEDBACK_LIMIT}
            value={feedback}
            disabled={!canGrade || pending}
            onChange={(event) => setFeedback(event.target.value)}
            className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        {canGrade ? (
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save grade'}
          </Button>
        ) : (
          <p className="text-sm text-slate-600">Read only: only instructors and non-editing instructors of this course can grade.</p>
        )}
      </form>
    </section>
  );
}
