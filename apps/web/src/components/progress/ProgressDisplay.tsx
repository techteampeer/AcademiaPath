'use client';

import { useLocale } from '@/components/i18n/LocaleProvider';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api/endpoints';
import type { ProgressState } from '@/lib/api/types';

/** Counts and percentage exactly as calculated by the API (the browser never computes progress). */
export type ProgressFigures = { completedCount: number; totalCount: number; percent: number | null; state: ProgressState };

/**
 * Progress bar with its figures in words. Without eligible activities no percentage is shown (the API
 * reports `percent: null`), so nothing is invented.
 */
export function ProgressBar({ figures, label, compact = false }: { figures: ProgressFigures; label: string; compact?: boolean }) {
  const { t } = useLocale();
  const p = t.progress;
  if (figures.percent === null) {
    return <p className="text-sm text-slate-600">{p.noActivities}</p>;
  }
  const status =
    figures.state === 'completed' ? p.allDone : figures.state === 'not_started' ? p.notStarted : p.remaining(figures.totalCount - figures.completedCount);
  return (
    <div className="space-y-1">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={figures.percent}
        aria-valuetext={`${p.activitiesCompleted(figures.completedCount, figures.totalCount)} (${p.percentComplete(figures.percent)})`}
        className={`w-full overflow-hidden rounded-full bg-slate-100 ${compact ? 'h-1.5' : 'h-2.5'}`}
      >
        <div
          className={`h-full rounded-full ${figures.state === 'completed' ? 'bg-emerald-500' : 'bg-brand-600'}`}
          style={{ width: `${figures.percent}%` }}
        />
      </div>
      <p className={`flex flex-wrap justify-between gap-x-3 text-slate-600 ${compact ? 'text-xs' : 'text-sm'}`}>
        <span>{p.activitiesCompleted(figures.completedCount, figures.totalCount)}</span>
        <span className="font-medium text-slate-800">
          {p.percentComplete(figures.percent)}
          {compact ? null : <span className="font-normal text-slate-500"> · {status}</span>}
        </span>
      </p>
    </div>
  );
}

/**
 * Completion state of one activity for its student. Lessons, links and documents can be marked by the
 * student; quizzes and assignments complete on submission (the API refuses manual marks for them).
 */
export function CompletionControl({
  courseId,
  activityId,
  title,
  completion,
  completed,
  onChanged,
}: {
  courseId: string;
  activityId: string;
  title: string;
  completion: 'manual' | 'automatic';
  completed: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useLocale();
  const p = t.progress;
  const { run, pending, result } = useCsrfAction();
  const toggle = async () => {
    const done = await run(
      (csrf) => (completed ? api.markIncomplete(courseId, activityId, csrf) : api.markComplete(courseId, activityId, csrf)),
      (value) => (value.completed ? p.markedComplete(title) : p.markedIncomplete(title)),
    );
    if (done) await onChanged();
  };
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className="flex flex-wrap items-center gap-2">
        {completed ? <Badge tone="success">✓ {p.completed}</Badge> : <Badge tone="neutral">{p.notCompleted}</Badge>}
        {completion === 'manual' ? (
          <Button size="sm" variant={completed ? 'ghost' : 'secondary'} disabled={pending} onClick={() => void toggle()} aria-pressed={completed}>
            {completed ? p.markIncomplete : p.markComplete}
            <span className="sr-only">: {title}</span>
          </Button>
        ) : completed ? null : (
          <span className="text-xs text-slate-500">{p.completesOnSubmit}</span>
        )}
      </div>
      {result ? (
        <div role="status" className="w-full">
          <Alert tone={result.tone}>{result.message}</Alert>
        </div>
      ) : null}
    </div>
  );
}

/** Why a section is locked: the visible sections it requires, with their state. */
export function LockedNotice({ requiredSections }: { requiredSections: Array<{ sectionId: string; title: string; completed: boolean }> }) {
  const { t } = useLocale();
  const p = t.progress;
  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-medium">
        <span aria-hidden="true">🔒 </span>
        {p.lockedRequires}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {requiredSections.map((section) => (
          <li key={section.sectionId}>
            {section.title} <span className="text-xs text-amber-800">({section.completed ? p.requiredDone : p.requiredPending})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
