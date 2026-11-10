'use client';

import { useState } from 'react';
import { formatGrade20 } from '@/components/assignments/assignmentDisplay';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api/endpoints';
import type { CourseGrade, GradeSelectionRelease, GradeSelectionReleaseResult } from '@/lib/api/types';

/** "Final" or "Provisional", always with the reason available to assistive technology and on hover. */
export function CourseGradeStatusBadge({ status }: { status: CourseGrade['status'] }) {
  const { t } = useLocale();
  const g = t.gradebook;
  return (
    <span title={g.gradeStatusHelp[status]} data-grade-status={status}>
      <Badge tone={status === 'final' ? 'success' : 'warning'}>{g.gradeStatus[status]}</Badge>
      <span className="sr-only"> ({g.gradeStatusHelp[status]})</span>
    </span>
  );
}

/** A course grade as calculated by the server: 0–20, percentage, status and pending work. */
export function CourseGradeValue({ grade, compact = false }: { grade: CourseGrade; compact?: boolean }) {
  const { t } = useLocale();
  const g = t.gradebook;
  if (grade.grade20 === null) {
    return (
      <span className="block text-sm text-slate-600" data-course-grade="none">
        {g.noGradeYet} <CourseGradeStatusBadge status={grade.status} />
      </span>
    );
  }
  return (
    <span className="block" data-course-grade={grade.grade20}>
      <span className={compact ? 'font-semibold text-slate-900' : 'text-2xl font-bold text-slate-900'}>{formatGrade20(grade.grade20)}</span>{' '}
      {grade.percent !== null ? <span className="text-sm text-slate-600">({g.percent(grade.percent)})</span> : null}{' '}
      <CourseGradeStatusBadge status={grade.status} />
      {grade.pendingItems > 0 ? <span className="block text-xs text-slate-500">{g.pending(grade.pendingItems)}</span> : null}
    </span>
  );
}

/** Weighted category summaries (name, weight and percentage, or "none yet"). */
export function CategoryList({ grade }: { grade: CourseGrade }) {
  const { t } = useLocale();
  const g = t.gradebook;
  if (grade.method !== 'weighted' || !grade.categories.length) return null;
  return (
    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
      {grade.categories.map((category) => (
        <li key={category.categoryId} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" data-category={category.name}>
          <span className="block font-medium text-slate-900">{g.categoryWeight(category.name, category.weightPercent)}</span>
          <span className="block text-slate-600">{t.gradebook.student.categoryReleased(category.percent)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Releases a reviewed set of grades (each with the revision the instructor saw) after an explicit
 * confirmation. The server releases only what is still eligible and reports everything else.
 */
export function ReleaseSelection({
  courseId,
  items,
  label,
  onReleased,
  emptyLabel,
  size = 'sm',
}: {
  courseId: string;
  items: GradeSelectionRelease['items'];
  label: string;
  onReleased?: () => void;
  /** Shown instead of the button when nothing is left to release (the last result stays visible). */
  emptyLabel?: string;
  size?: 'sm' | 'md';
}) {
  const { t } = useLocale();
  const r = t.gradebook.release;
  const { run, pending, result } = useCsrfAction();
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<GradeSelectionReleaseResult | null>(null);
  const release = async () => {
    const value = await run((csrf) => api.releaseSelectedGrades(courseId, { items }, csrf));
    setConfirming(false);
    if (value) {
      setOutcome(value);
      onReleased?.();
    }
  };
  const skipped = outcome?.results.filter((item) => item.outcome !== 'released') ?? [];
  return (
    <div className="space-y-2">
      {confirming ? (
        <div role="alertdialog" aria-labelledby="release-confirm-title" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p id="release-confirm-title" className="font-medium text-slate-900">
            {r.confirmTitle(items.length)}
          </p>
          <p className="text-sm text-slate-700">{r.confirmBody}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void release()} disabled={pending}>
              {pending ? r.releasing : r.confirm}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
              {r.cancel}
            </Button>
          </div>
        </div>
      ) : !items.length && emptyLabel ? (
        <p className="text-sm text-slate-600">{emptyLabel}</p>
      ) : (
        <Button size={size} onClick={() => setConfirming(true)} disabled={!items.length || pending}>
          {label}
        </Button>
      )}
      {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
      {outcome ? (
        <Alert tone={skipped.length ? 'info' : 'success'}>
          <span data-release-summary={`${outcome.releasedCount}/${skipped.length}`}>{r.summary(outcome.releasedCount, skipped.length)}</span>
          {skipped.length ? (
            <ul className="mt-1 list-disc pl-5 text-sm">
              {[...new Set(skipped.map((item) => item.outcome))].map((kind) => (
                <li key={kind}>
                  {r.outcome[kind]}: {skipped.filter((item) => item.outcome === kind).length}
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
}

/** Downloads the server-built CSV (never built in the browser). */
export function ExportCsvButton({ courseId }: { courseId: string }) {
  const { t } = useLocale();
  const b = t.gradebook.toolbar;
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const download = async () => {
    setState('busy');
    try {
      const { blob, fileName } = await api.exportGradebookCsv(courseId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setState('idle');
    } catch {
      setState('failed');
    }
  };
  return (
    <span className="inline-flex flex-col gap-1">
      <Button variant="secondary" size="sm" onClick={() => void download()} disabled={state === 'busy'}>
        {state === 'busy' ? b.exporting : b.exportCsv}
      </Button>
      {state === 'failed' ? <Alert tone="error">{b.exportFailed}</Alert> : null}
    </span>
  );
}
