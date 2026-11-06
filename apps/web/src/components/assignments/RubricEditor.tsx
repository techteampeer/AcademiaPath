'use client';

import { useLocale } from '@/components/i18n/LocaleProvider';
import { Button } from '@/components/ui/Button';
import type { Messages } from '@/lib/i18n/messages';

export type CriterionDraft = { title: string; maxPoints: string; description: string };
export const RUBRIC_LIMITS = { criteria: 20, title: 200, description: 1000, maxPoints: 100 } as const;
export const emptyCriterion = (): CriterionDraft => ({ title: '', maxPoints: '', description: '' });

/** Returns an error message (in the interface language), or null when every criterion is valid. */
export function validateRubric(criteria: CriterionDraft[], r: Messages['assignments']['rubric']): string | null {
  if (!criteria.length) return r.atLeastOne;
  if (criteria.length > RUBRIC_LIMITS.criteria) return r.atMost(RUBRIC_LIMITS.criteria);
  for (const [index, criterion] of criteria.entries()) {
    const n = index + 1;
    if (!criterion.title.trim()) return r.enterTitle(n);
    if (criterion.title.length > RUBRIC_LIMITS.title) return r.titleLength(n, RUBRIC_LIMITS.title);
    const points = Number(criterion.maxPoints);
    if (!/^\d+$/.test(criterion.maxPoints.trim()) || points < 1 || points > RUBRIC_LIMITS.maxPoints) {
      return r.pointsRange(n, RUBRIC_LIMITS.maxPoints);
    }
    if (criterion.description.length > RUBRIC_LIMITS.description) return r.descriptionLength(n, RUBRIC_LIMITS.description);
  }
  return null;
}

/** Points-based rubric: a title and maximum points per criterion. */
export function RubricEditor({
  idPrefix,
  criteria,
  onChange,
  error,
}: {
  idPrefix: string;
  criteria: CriterionDraft[];
  onChange: (criteria: CriterionDraft[]) => void;
  error?: string;
}) {
  const { t } = useLocale();
  const r = t.assignments.rubric;
  const update = (index: number, change: Partial<CriterionDraft>) =>
    onChange(criteria.map((criterion, i) => (i === index ? { ...criterion, ...change } : criterion)));
  return (
    <fieldset className="space-y-3" aria-describedby={error ? `${idPrefix}-rubric-error` : undefined}>
      <legend className="text-sm font-medium text-slate-800">{r.legend}</legend>
      {criteria.map((criterion, index) => (
        <div key={index} className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-[1fr_8rem]">
          <div>
            <label htmlFor={`${idPrefix}-criterion-${index}-title`} className="block text-xs font-medium text-slate-700">
              {r.criterionTitle(index + 1)}
            </label>
            <input
              id={`${idPrefix}-criterion-${index}-title`}
              value={criterion.title}
              maxLength={RUBRIC_LIMITS.title}
              onChange={(event) => update(index, { title: event.target.value })}
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
            />
          </div>
          <div>
            <label htmlFor={`${idPrefix}-criterion-${index}-points`} className="block text-xs font-medium text-slate-700">
              {r.criterionPoints(index + 1)}
            </label>
            <input
              id={`${idPrefix}-criterion-${index}-points`}
              inputMode="numeric"
              value={criterion.maxPoints}
              onChange={(event) => update(index, { maxPoints: event.target.value })}
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${idPrefix}-criterion-${index}-description`} className="block text-xs font-medium text-slate-700">
              {r.criterionDescription(index + 1)}
            </label>
            <input
              id={`${idPrefix}-criterion-${index}-description`}
              value={criterion.description}
              maxLength={RUBRIC_LIMITS.description}
              onChange={(event) => update(index, { description: event.target.value })}
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
            />
          </div>
          {criteria.length > 1 ? (
            <div className="sm:col-span-2">
              <Button variant="ghost" size="sm" onClick={() => onChange(criteria.filter((_, i) => i !== index))}>
                {r.remove}
                <span className="sr-only"> {r.criterionN(index + 1)}</span>
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      {criteria.length < RUBRIC_LIMITS.criteria ? (
        <Button variant="secondary" size="sm" onClick={() => onChange([...criteria, emptyCriterion()])}>
          {r.add}
        </Button>
      ) : null}
      {error ? (
        <p id={`${idPrefix}-rubric-error`} className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
