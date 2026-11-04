'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api/endpoints';
import type { Activity, ActivityCreate } from '@/lib/api/types';
import { ActivityForm } from './ActivityForm';
import { ACTIVITY_TYPE_LABELS, ReviewStatusBadge, type ContentAbilities } from './contentDisplay';

export const lessonHref = (courseId: string, activityId: string) => `/courses/${courseId}/activities/${activityId}`;

/** Activities of one section, plus an "Add content" form for editors. */
export function SectionActivities({
  courseId,
  sectionId,
  sectionTitle,
  items,
  abilities,
  onChanged,
}: {
  courseId: string;
  sectionId: string;
  sectionTitle: string;
  items: Activity[];
  abilities: ContentAbilities;
  onChanged: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const { run, pending, result } = useCsrfAction();

  const create = async (value: ActivityCreate) => {
    const created = await run(
      (csrf) => api.createActivity(courseId, sectionId, value, csrf),
      (activity) => `"${activity.title}" saved as a draft.`,
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
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200" aria-label={`Content in ${sectionTitle}`}>
          {items.map((activity) => (
            <li key={activity.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <Link href={lessonHref(courseId, activity.id)} className="font-medium text-brand-700 hover:underline">
                  {activity.title}
                </Link>
                <span className="ml-2 text-xs text-slate-500">{ACTIVITY_TYPE_LABELS[activity.type]}</span>
              </div>
              {activity.review ? (
                <div className="flex items-center gap-2">
                  {activity.liveVersion && activity.review.status !== 'approved' ? <Badge tone="success">Live version published</Badge> : null}
                  <ReviewStatusBadge status={activity.review.status} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">No content yet.</p>
      )}

      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}

      {abilities.edit ? (
        adding ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <h4 className="mb-3 text-sm font-semibold text-slate-900">Add content to {sectionTitle}</h4>
            <ActivityForm
              idPrefix={`new-${sectionId}`}
              submitLabel="Save draft"
              pending={pending}
              onSubmit={create}
              onCancel={() => setAdding(false)}
            />
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            Add content
          </Button>
        )
      ) : null}
    </div>
  );
}
