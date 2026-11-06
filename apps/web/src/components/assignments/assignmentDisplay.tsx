'use client';

import { useLocale } from '@/components/i18n/LocaleProvider';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import type { AssignmentContent, GradeStatus, ReleasedGrade } from '@/lib/api/types';
import { formatDateTimeOrDash } from '@/lib/i18n/messages';

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

/** Displays a server-calculated 0–20 grade. Formatting only: grades are never calculated in the browser. */
export function formatGrade20(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} / 20`;
}

const STATUS_TONES: Record<GradeStatus, BadgeTone> = {
  not_submitted: 'neutral',
  needs_grading: 'warning',
  unreleased: 'brand',
  released: 'success',
  changed_since_release: 'warning',
};

export function GradeStatusBadge({ status }: { status: GradeStatus }) {
  const { t } = useLocale();
  return (
    <Badge tone={STATUS_TONES[status]}>
      <span className="sr-only">{t.assignments.gradeStatusLabel}: </span>
      {t.assignments.gradeStatus[status]}
    </Badge>
  );
}

/** Instructions, deadline, late policy and rubric. Text is rendered as text, never HTML. */
export function AssignmentSummary({ content }: { content: AssignmentContent }) {
  const { t, locale } = useLocale();
  const s = t.assignments.summary;
  return (
    <div className="space-y-4">
      <p className="whitespace-pre-wrap break-words text-slate-800">{content.instructions}</p>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">{s.due}</dt>
          <dd className="font-medium text-slate-900">{formatDateTimeOrDash(content.dueAt, locale)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{s.late}</dt>
          <dd className="font-medium text-slate-900">
            {content.lateUntil ? s.lateAccepted(formatDateTimeOrDash(content.lateUntil, locale)) : s.lateNotAccepted}
          </dd>
        </div>
      </dl>
      <div className="relative overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="mb-2 text-left font-semibold text-slate-900">{s.rubricCaption(content.totalPoints)}</caption>
          <thead className="border-b border-slate-200 text-slate-500">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">
                {s.criterion}
              </th>
              <th scope="col" className="py-2 font-medium">
                {s.points}
              </th>
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
  const { t, locale } = useLocale();
  return (
    <div className="space-y-3">
      <p className="text-lg font-semibold text-slate-900">
        {formatGrade20(grade.grade20)}{' '}
        <span className="text-sm font-normal text-slate-600">
          {t.assignments.released.detail(grade.points, grade.maxPoints, formatDateTimeOrDash(grade.releasedAt, locale))}
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
          <h3 className="text-sm font-semibold text-slate-900">{t.assignments.released.feedback}</h3>
          <p className="whitespace-pre-wrap break-words text-sm text-slate-800">{grade.feedback}</p>
        </div>
      ) : null}
    </div>
  );
}
