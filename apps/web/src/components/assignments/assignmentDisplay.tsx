import { Badge, type BadgeTone } from '@/components/ui/Badge';
import type { AssignmentContent, GradeStatus, ReleasedGrade } from '@/lib/api/types';

/** `datetime-local` value (browser time zone) for an ISO timestamp. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** ISO timestamp for a `datetime-local` value, or null when empty or invalid. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

/** Displays a server-calculated 0–20 grade. Formatting only: grades are never calculated in the browser. */
export function formatGrade20(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} / 20`;
}

const STATUS_DISPLAY: Record<GradeStatus, { label: string; tone: BadgeTone }> = {
  not_submitted: { label: 'Not submitted', tone: 'neutral' },
  needs_grading: { label: 'Needs grading', tone: 'warning' },
  unreleased: { label: 'Graded, not released', tone: 'brand' },
  released: { label: 'Released', tone: 'success' },
  changed_since_release: { label: 'Changed since release', tone: 'warning' },
};

export function GradeStatusBadge({ status }: { status: GradeStatus }) {
  const display = STATUS_DISPLAY[status];
  return (
    <Badge tone={display.tone}>
      <span className="sr-only">Grade status: </span>
      {display.label}
    </Badge>
  );
}

/** Instructions, deadline, late policy and rubric. Text is rendered as text, never HTML. */
export function AssignmentSummary({ content }: { content: AssignmentContent }) {
  return (
    <div className="space-y-4">
      <p className="whitespace-pre-wrap break-words text-slate-800">{content.instructions}</p>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Due</dt>
          <dd className="font-medium text-slate-900">{formatDateTime(content.dueAt)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Late submissions</dt>
          <dd className="font-medium text-slate-900">
            {content.lateUntil ? `Accepted until ${formatDateTime(content.lateUntil)} and marked late` : 'Not accepted'}
          </dd>
        </div>
      </dl>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="mb-2 text-left font-semibold text-slate-900">Rubric ({content.totalPoints} points)</caption>
          <thead className="border-b border-slate-200 text-slate-500">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">Criterion</th>
              <th scope="col" className="py-2 font-medium">Points</th>
            </tr>
          </thead>
          <tbody>
            {content.rubric.map((criterion) => (
              <tr key={criterion.id} className="border-b border-slate-100">
                <td className="py-2 pr-4">
                  <span className="block text-slate-900">{criterion.title}</span>
                  {criterion.description ? <span className="block text-xs text-slate-500">{criterion.description}</span> : null}
                </td>
                <td className="py-2">{criterion.maxPoints}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A grade exactly as released to the student. */
export function ReleasedGradeView({ grade }: { grade: ReleasedGrade }) {
  return (
    <div className="space-y-3">
      <p className="text-lg font-semibold text-slate-900">
        {formatGrade20(grade.grade20)}{' '}
        <span className="text-sm font-normal text-slate-600">
          ({grade.points} of {grade.maxPoints} points · released {formatDateTime(grade.releasedAt)})
        </span>
      </p>
      {grade.criteria.length ? (
        <ul className="space-y-1 text-sm text-slate-700">
          {grade.criteria.map((criterion) => (
            <li key={criterion.criterionId}>
              {criterion.title}: {criterion.points} / {criterion.maxPoints}
            </li>
          ))}
        </ul>
      ) : null}
      {grade.feedback ? (
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Feedback</h3>
          <p className="whitespace-pre-wrap break-words text-sm text-slate-800">{grade.feedback}</p>
        </div>
      ) : null}
    </div>
  );
}
