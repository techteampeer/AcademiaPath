'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';

type SectionLike = { id: string; title: string; isVisible: boolean };

/**
 * Administrator card: which sections each section requires. The API validates every change (same
 * course, no self-requirement, no cycles) and enforces the locks on all student content routes.
 */
export function PrerequisitesCard({ courseId, sections }: { courseId: string; sections: SectionLike[] }) {
  const { t, locale } = useLocale();
  const p = t.progress;
  const { handleUnauthorized } = useSession();
  const { run, pending, result } = useCsrfAction();
  const [required, setRequired] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; bySection: Record<string, string[]> }>({
    status: 'loading',
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const list = await api.sectionPrerequisites(courseId);
      setRequired({ status: 'ready', bySection: Object.fromEntries(list.items.map((item) => [item.sectionId, item.requiredSectionIds])) });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setRequired({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [courseId, handleUnauthorized, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const titleOf = (id: string) => sections.find((section) => section.id === id)?.title ?? id;
  const startEditing = (sectionId: string) => {
    setEditing(sectionId);
    setDraft(required.status === 'ready' ? (required.bySection[sectionId] ?? []) : []);
  };
  const save = async (sectionId: string) => {
    // Keep course order for the request (the API stores a set and answers in course order).
    const ordered = sections.map((section) => section.id).filter((id) => draft.includes(id));
    const saved = await run((csrf) => api.setSectionPrerequisites(courseId, sectionId, ordered, csrf), () => p.requirementsSaved(titleOf(sectionId)));
    if (saved) {
      setEditing(null);
      await load();
    }
  };

  return (
    <Card as="section" aria-labelledby="prerequisites-heading" className="space-y-4">
      <div>
        <h2 id="prerequisites-heading" className="text-lg font-semibold text-slate-900">
          {p.prerequisitesTitle}
        </h2>
        <p className="text-sm text-slate-600">{p.prerequisitesIntro}</p>
        <p className="mt-1 text-xs text-slate-500">{p.hiddenNote}</p>
      </div>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      {required.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          {p.loadingPrerequisites}
        </p>
      ) : required.status === 'error' ? (
        <Alert tone="error">{required.message}</Alert>
      ) : (
        <ol className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {sections.map((section, index) => {
            const current = required.bySection[section.id] ?? [];
            return (
              <li key={section.id} className="space-y-3 px-4 py-3" data-prerequisite-section={section.title}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">
                      <span className="mr-2 text-slate-400">{index + 1}.</span>
                      {section.title}
                      {section.isVisible ? null : (
                        <Badge tone="warning" className="ml-2">
                          {t.courses.hiddenFromStudents}
                        </Badge>
                      )}
                    </p>
                    <p className="text-sm text-slate-600">
                      {current.length ? `${p.requires}: ${current.map(titleOf).join(', ')}` : p.opensFreely}
                    </p>
                  </div>
                  {editing === section.id ? null : (
                    <Button size="sm" variant="secondary" disabled={pending} onClick={() => startEditing(section.id)}>
                      {p.editRequirements}
                      <span className="sr-only">: {section.title}</span>
                    </Button>
                  )}
                </div>
                {editing === section.id ? (
                  <fieldset className="space-y-2 rounded-lg bg-slate-50 p-3">
                    <legend className="text-sm font-semibold text-slate-900">{p.chooseRequired(section.title)}</legend>
                    {sections
                      .filter((other) => other.id !== section.id)
                      .map((other) => (
                        <label key={other.id} className="flex items-start gap-2 text-sm text-slate-800">
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 rounded border-slate-300"
                            checked={draft.includes(other.id)}
                            onChange={(event) =>
                              setDraft((value) => (event.target.checked ? [...value, other.id] : value.filter((id) => id !== other.id)))
                            }
                          />
                          <span>{other.title}</span>
                        </label>
                      ))}
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button size="sm" disabled={pending} onClick={() => void save(section.id)}>
                        {p.saveRequirements}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(null)}>
                        {p.cancel}
                      </Button>
                    </div>
                  </fieldset>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
