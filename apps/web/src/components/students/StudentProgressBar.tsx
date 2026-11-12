'use client';

import { useLocale } from '@/components/i18n/LocaleProvider';
import { cn } from '@/lib/cn';

/** Converts any number to a whole percentage in 0–100. Non-finite values (NaN, Infinity) become 0. */
export function toPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)));
}

export type StudentProgressBarProps = {
  /** Progress from 0 to 100; values outside the range are clamped. */
  value: number;
  /** Visible label. Defaults to "Progress" in the interface language. */
  label?: string;
  /** Screen-reader name when the visible label is not specific enough, e.g. "Progress in ITIL Fundamentals". */
  accessibleLabel?: string;
  className?: string;
};

export function StudentProgressBar({ value, label, accessibleLabel, className }: StudentProgressBarProps) {
  const { t } = useLocale();
  const percent = toPercent(value);
  const visibleLabel = label ?? t.preview.progress;
  const complete = percent === 100;

  return (
    <div className={cn('w-full', className)}>
      {/* Visual label only; the progressbar below exposes the same information to assistive technology. */}
      <div className="mb-1.5 flex items-center justify-between text-sm" aria-hidden="true">
        <span className="text-slate-600">{visibleLabel}</span>
        <span className="font-medium text-slate-900 tabular-nums">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={accessibleLabel ?? visibleLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={t.progress.percentComplete(percent)}
        className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
      >
        <div
          className={cn('h-full rounded-full', complete ? 'bg-emerald-600' : 'bg-brand-600')}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
