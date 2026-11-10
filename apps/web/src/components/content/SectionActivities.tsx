'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api/endpoints';
import type { Activity, ActivityCreate, ActivityProgress } from '@/lib/api/types';
import { CompletionControl } from '@/components/progress/ProgressDisplay';
import { ActivityForm } from './ActivityForm';
import { ReviewStatusBadge, type ContentAbilities } from './contentDisplay';

export const lessonHref = (courseId: string, activityId: string) => `/courses/${courseId}/activities/${activityId}`;

/** Activities of one section, plus an "Add content" form for editors. */
export function SectionActivities({
  courseId,
  sectionId,
  sectionTitle,
  items,
  abilities,
  completion,
  onChanged,
}: {
  courseId: string;
  sectionId: string;
  sectionTitle: string;
  items: Activity[];
  abilities: ContentAbilities;
  /** The student's completion state per activity (students only; calculated by the API). */
  completion?: Record<string, ActivityProgress>;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [adding, setAdding] = useState(false);
  const { run, pending, result } = useCsrfAction();

  const create = async (value: ActivityCreate) => {
    const created = await run(
      (csrf) => api.createActivity(courseId, sectionId, value, csrf),
      (activity) => t.content.section.savedDraft(activity.title),
    );
    if (created) {
      setAdding(false);
      await onChanged();
    }
    return created !== null;
  };

  return (
    <div className="mt-3 space-y-3">
      {items.length ? (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200" aria-label={t.content.section.contentIn(sectionTitle)}>
          {items.map((activity) => {
            const state = completion?.[activity.id];
            return (
            <li key={activity.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3" data-completed={state ? String(state.completed) : undefined}>
              <div className="min-w-0">
                <Link href={lessonHref(courseId, activity.id)} className="font-medium text-brand-700 hover:underline">
                  {activity.title}
                </Link>
                <span className="ml-2 text-xs text-slate-500">{t.activityType[activity.type]}</span>
              </div>
              {activity.review ? (
                <div className="flex items-center gap-2">
                  {activity.liveVersion && activity.review.status !== 'approved' ? <Badge tone="success">{t.content.section.livePublished}</Badge> : null}
                  <ReviewStatusBadge status={activity.review.status} />
                </div>
              ) : null}
              {state ? (
                <CompletionControl
                  courseId={courseId}
                  activityId={activity.id}
                  title={activity.title}
                  completion={state.completion}
                  completed={state.completed}
                  onChanged={onChanged}
                />
              ) : null}
            </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">{t.content.section.empty}</p>
      )}

      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}

      {abilities.edit ? (
        adding ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <h4 className="mb-3 text-sm font-semibold text-slate-900">{t.content.section.addTo(sectionTitle)}</h4>
            <ActivityForm
              idPrefix={`new-${sectionId}`}
              submitLabel={t.content.section.saveDraft}
              pending={pending}
              onSubmit={create}
              onCancel={() => setAdding(false)}
            />
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            {t.content.section.addContent}
          </Button>
        )
      ) : null}
    </div>
  );
}
