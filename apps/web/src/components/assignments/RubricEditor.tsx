'use client';

import { Button } from '@/components/ui/Button';

export type CriterionDraft = { title: string; maxPoints: string; description: string };
export const RUBRIC_LIMITS = { criteria: 20, title: 200, description: 1000, maxPoints: 100 } as const;
export const emptyCriterion = (): CriterionDraft => ({ title: '', maxPoints: '', description: '' });

/** Returns an error message, or null when every criterion is valid. */
export function validateRubric(criteria: CriterionDraft[]): string | null {
  if (!criteria.length) return 'Add at least one rubric criterion.';
  if (criteria.length > RUBRIC_LIMITS.criteria) return `Use at most ${RUBRIC_LIMITS.criteria} criteria.`;
  for (const [index, criterion] of criteria.entries()) {
    const label = `Criterion ${index + 1}`;
    if (!criterion.title.trim()) return `${label}: enter a title.`;
    if (criterion.title.length > RUBRIC_LIMITS.title) return `${label}: use at most ${RUBRIC_LIMITS.title} characters.`;
    const points = Number(criterion.maxPoints);
    if (!/^\d+$/.test(criterion.maxPoints.trim()) || points < 1 || points > RUBRIC_LIMITS.maxPoints) {
      return `${label}: maximum points must be a whole number from 1 to ${RUBRIC_LIMITS.maxPoints}.`;
    }
    if (criterion.description.length > RUBRIC_LIMITS.description) return `${label}: use at most ${RUBRIC_LIMITS.description} characters in the description.`;
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
  const update = (index: number, change: Partial<CriterionDraft>) =>
    onChange(criteria.map((criterion, i) => (i === index ? { ...criterion, ...change } : criterion)));
  return (
    <fieldset className="space-y-3" aria-describedby={error ? `${idPrefix}-rubric-error` : undefined}>
      <legend className="text-sm font-medium text-slate-800">Rubric criteria (points)</legend>
      {criteria.map((criterion, index) => (
        <div key={index} className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-[1fr_8rem]">
          <div>
            <label htmlFor={`${idPrefix}-criterion-${index}-title`} className="block text-xs font-medium text-slate-700">
              Criterion {index + 1} title
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
              Criterion {index + 1} max points
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
              Criterion {index + 1} description (optional)
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
                Remove<span className="sr-only"> criterion {index + 1}</span>
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      {criteria.length < RUBRIC_LIMITS.criteria ? (
        <Button variant="secondary" size="sm" onClick={() => onChange([...criteria, emptyCriterion()])}>
          Add criterion
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
