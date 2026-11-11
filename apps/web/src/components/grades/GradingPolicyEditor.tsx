'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { contentAbilities } from '@/components/content/contentDisplay';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextField } from '@/components/ui/Field';
import { Breadcrumbs } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Course, CurrentUser, Gradebook, GradingPolicy } from '@/lib/api/types';

type Ready = { course: Course; policy: GradingPolicy; columns: Gradebook['columns'] };
type Load = { status: 'loading' } | { status: 'not-found' } | { status: 'error'; message: string } | { status: 'ready'; data: Ready };
type Draft = { key: number; name: string; weight: string; activityIds: string[] };

let nextKey = 1;
const toDraft = (policy: GradingPolicy): Draft[] =>
  policy.categories.map((category) => ({ key: nextKey++, name: category.name, weight: String(category.weightPercent), activityIds: category.activityIds }));

export function GradingPolicyEditor({ courseId }: { courseId: string }) {
  return <RequireAuth>{(user) => <Content courseId={courseId} user={user} />}</RequireAuth>;
}

/**
 * Grade categories and weights. The browser only edits a draft of the whole policy: the API validates
 * names, memberships and the 100 % total, applies it atomically and rejects outdated versions.
 */
function Content({ courseId, user }: { courseId: string; user: CurrentUser }) {
  const { handleUnauthorized } = useSession();
  const { t, locale } = useLocale();
  const e = t.gradebook.editor;
  const b = t.assignments.book;
  const [state, setState] = useState<Load>({ status: 'loading' });
  const [categories, setCategories] = useState<Draft[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const { run, pending, result } = useCsrfAction();

  const load = useCallback(async () => {
    try {
      const [course, policy, book] = await Promise.all([api.getCourse(courseId), api.getGradingPolicy(courseId), api.getGradebook(courseId, { limit: 1 })]);
      setState({ status: 'ready', data: { course, policy, columns: book.columns } });
      setCategories(toDraft(policy));
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      else if (isApiError(error, 404) || isApiError(error, 400)) setState({ status: 'not-found' });
      else setState({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [courseId, handleUnauthorized, locale]);
  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {e.loading}
      </p>
    );
  }
  if (state.status === 'not-found') return <EmptyState titleAs="h1" title={b.notAvailableTitle} description={b.notAvailableDescription} />;
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;

  const { course, policy, columns } = state.data;
  const canEdit = contentAbilities(user, course.viewerRole).configureGrading;
  const total = categories.reduce((sum, category) => sum + (Number.parseInt(category.weight, 10) || 0), 0);
  const ownerOf = (activityId: string) => categories.find((category) => category.activityIds.includes(activityId));
  const unassigned = columns.filter((column) => !ownerOf(column.activityId)).length;
  const update = (key: number, change: Partial<Draft>) => setCategories((list) => list.map((category) => (category.key === key ? { ...category, ...change } : category)));
  const toggle = (key: number, activityId: string, checked: boolean) =>
    setCategories((list) =>
      list.map((category) =>
        category.key === key
          ? { ...category, activityIds: checked ? [...category.activityIds, activityId] : category.activityIds.filter((id) => id !== activityId) }
          : category,
      ),
    );

  const save = async (status: 'draft' | 'published') => {
    const problems: string[] = [];
    const names = new Set<string>();
    categories.forEach((category, index) => {
      const name = category.name.trim();
      const weight = Number(category.weight);
      if (!name) problems.push(e.nameRequired(index + 1));
      if (!Number.isInteger(weight) || weight < 1 || weight > 100) problems.push(e.weightRange(index + 1));
      if (names.has(name.toLocaleLowerCase())) problems.push(e.duplicateName);
      names.add(name.toLocaleLowerCase());
    });
    if (status === 'published' && (total !== 100 || !categories.length)) problems.push(e.totalNot(total));
    setErrors([...new Set(problems)]);
    if (problems.length) return;
    const saved = await run(
      (csrf) =>
        api.saveGradingPolicy(
          courseId,
          {
            expectedVersion: policy.version,
            status,
            categories: categories.map((category) => ({ name: category.name.trim(), weightPercent: Number(category.weight), activityIds: category.activityIds })),
          },
          csrf,
        ),
      (value) => e.saved(value.status),
    );
    if (saved) {
      setState({ status: 'ready', data: { ...state.data, policy: saved } });
      setCategories(toDraft(saved));
    }
  };

  const statusLabel = t.gradebook.policyStatus[policy.status];
  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs
          label={t.common.breadcrumb}
          items={[
            { label: t.nav.myCourses, href: '/courses' },
            { label: course.title, href: `/courses/${courseId}` },
            { label: b.gradebook, href: `/courses/${courseId}/grades` },
            { label: e.title },
          ]}
        />
        <h1 className="mt-4 text-[1.75rem] leading-tight font-semibold text-brand-600 sm:text-[2.1rem]">{e.title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">{e.intro}</p>
        <p className="mt-2 text-sm" data-policy-status={policy.status}>
          <Badge wrap tone={policy.status === 'published' ? 'success' : policy.status === 'draft' ? 'warning' : 'neutral'}>{e.statusNow(statusLabel)}</Badge>
          {policy.version ? <span className="ml-2 text-xs text-slate-500">{e.version(policy.version)}</span> : null}
        </p>
      </div>
      {!canEdit ? <Alert tone="info">{e.readOnly}</Alert> : null}
      {columns.length === 0 ? <Alert tone="info">{e.noActivities}</Alert> : null}
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save('published');
        }}
      >
        <fieldset disabled={!canEdit || pending} className="space-y-4">
          <legend className="sr-only">{e.title}</legend>
          {categories.map((category, index) => (
            <Card as="section" key={category.key} aria-label={e.categoryN(index + 1)} className="space-y-3" data-category-index={index}>
              <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
                <TextField id={`category-${category.key}-name`} label={`${e.categoryN(index + 1)}: ${e.name}`} value={category.name} maxLength={80} onChange={(event) => update(category.key, { name: event.target.value })} />
                <TextField
                  id={`category-${category.key}-weight`}
                  label={e.weight}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100}
                  step={1}
                  value={category.weight}
                  onChange={(event) => update(category.key, { weight: event.target.value })}
                />
              </div>
              <fieldset>
                <legend className="text-sm font-medium text-slate-800">{e.activities}</legend>
                <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                  {columns.map((column) => {
                    const owner = ownerOf(column.activityId);
                    const elsewhere = owner !== undefined && owner.key !== category.key;
                    return (
                      <li key={column.activityId}>
                        <label className="flex items-start gap-2 text-sm text-slate-700">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={category.activityIds.includes(column.activityId)}
                            disabled={elsewhere}
                            onChange={(event) => toggle(category.key, column.activityId, event.target.checked)}
                          />
                          <span>
                            {column.title}{' '}
                            <span className="text-xs text-slate-500">
                              ({column.type === 'quiz' ? b.quiz : b.assignment} · {b.pts(column.maxPoints)})
                            </span>
                            {elsewhere ? <span className="block text-xs text-slate-500">{owner.name || e.categoryN(categories.indexOf(owner) + 1)}</span> : null}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
              <Button type="button" variant="secondary" size="sm" onClick={() => setCategories((list) => list.filter((item) => item.key !== category.key))}>
                {e.remove}
              </Button>
            </Card>
          ))}
          <Button type="button" variant="secondary" onClick={() => setCategories((list) => [...list, { key: nextKey++, name: '', weight: '', activityIds: [] }])}>
            {e.addCategory}
          </Button>
        </fieldset>
        <div className="space-y-1 text-sm" aria-live="polite">
          <p className="font-medium text-slate-900" data-total={total}>
            {e.total(total)}
          </p>
          <p className={total === 100 ? 'text-emerald-700' : 'text-amber-700'}>{total === 100 ? e.totalOk : e.totalNot(total)}</p>
          {unassigned > 0 && categories.length ? <p className="text-slate-600">{e.unassigned(unassigned)}</p> : null}
        </div>
        {errors.length ? (
          <Alert tone="error">
            <ul className="list-disc pl-5">
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? e.saving : e.publish}
            </Button>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => void save('draft')}>
              {policy.status === 'published' ? e.unpublish : e.saveDraft}
            </Button>
          </div>
        ) : null}
      </form>
      <Link href={`/courses/${courseId}/grades`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
        {e.back}
      </Link>
    </div>
  );
}
