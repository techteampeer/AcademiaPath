'use client';

/**
 * Student groups and collaborative workspaces (AP-028). Presentation only: membership, who may see a group,
 * read or post in its discussions and manage it are decided by the API on every request; these views show
 * what it returns and hide controls the API would refuse anyway. Texts render as plain text.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { NewTopicForm, TopicRow } from '@/components/forums/ForumViews';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { AdminGroupOverview, CourseGroupList, ForumTopicPage, GroupDetail, GroupSummary } from '@/lib/api/types';
import { formatDateTime } from '@/lib/i18n/messages';

const fieldClasses = 'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm';

type Load<T> = { status: 'loading' } | { status: 'not-found' } | { status: 'forbidden' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

function useLoader<T>(fetcher: () => Promise<T>) {
  const { handleUnauthorized } = useSession();
  const { locale } = useLocale();
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', data: await fetcher() });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      else if (isApiError(error, 404) || isApiError(error, 400)) setState({ status: 'not-found' });
      else if (isApiError(error, 403)) setState({ status: 'forbidden' });
      else setState({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [fetcher, handleUnauthorized, locale]);
  useEffect(() => {
    void load();
  }, [load]);
  return { state, load, setState };
}

function Loading({ label }: { label: string }) {
  return (
    <p role="status" className="text-sm text-slate-600">
      {label}
    </p>
  );
}

function GroupCard({ group, showCourse = false }: { group: GroupSummary; showCourse?: boolean }) {
  const { t, locale } = useLocale();
  const l = t.groups.list;
  return (
    <li className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" data-group={group.id} data-group-name={group.name} data-unread={group.unreadCount} data-archived={String(group.archived)}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/groups/${group.id}`} className="font-medium break-words text-brand-700 hover:underline">
            {group.name}
          </Link>
          {group.isMember ? <Badge tone="brand">{l.member}</Badge> : null}
          {group.archived ? <Badge tone="neutral">{l.archived}</Badge> : null}
          {group.unreadCount > 0 ? (
            <Badge tone="warning">
              <span data-group-unread>{l.unread(group.unreadCount)}</span>
            </Badge>
          ) : null}
        </div>
        {group.description ? <p className="text-sm break-words text-slate-700">{group.description}</p> : null}
        <p className="text-xs text-slate-500">
          {showCourse ? `${group.course.code} · ` : ''}
          {l.members(group.memberCount)} · {l.topics(group.topicCount)}
          {group.lastActivityAt ? ` · ${formatDateTime(group.lastActivityAt, locale)}` : ''}
        </p>
      </div>
      <Link href={`/groups/${group.id}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
        {l.open}
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// /groups

export function MyGroupsView() {
  return <RequireAuth>{() => <MyGroups />}</RequireAuth>;
}

function MyGroups() {
  const { t } = useLocale();
  const l = t.groups.list;
  const fetcher = useCallback(() => api.myGroups(), []);
  const { state } = useLoader(fetcher);
  return (
    <div className="space-y-6">
      <PageHeader title={l.myTitle} description={l.myIntro} breadcrumbLabel={t.common.breadcrumb} breadcrumbs={[{ label: t.nav.dashboard, href: '/dashboard' }, { label: l.myTitle }]} />
      <Card as="section" aria-label={l.myTitle}>
        {state.status === 'loading' ? (
          <Loading label={l.loading} />
        ) : state.status === 'ready' ? (
          state.data.items.length === 0 ? (
            <EmptyState title={l.noneMine} description={l.noneMineHelp} />
          ) : (
            <ul className="divide-y divide-slate-100" data-my-groups>
              {state.data.items.map((group) => (
                <GroupCard key={group.id} group={group} showCourse />
              ))}
            </ul>
          )
        ) : (
          <Alert tone="error">{state.status === 'error' ? state.message : l.notFound}</Alert>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// /courses/[id]/groups

export function CourseGroupsView({ courseId }: { courseId: string }) {
  return <RequireAuth>{() => <CourseGroups courseId={courseId} />}</RequireAuth>;
}

function CourseGroups({ courseId }: { courseId: string }) {
  const { t } = useLocale();
  const l = t.groups.list;
  const fetcher = useCallback(() => api.courseGroups(courseId), [courseId]);
  const { state, load } = useLoader<CourseGroupList>(fetcher);
  if (state.status === 'loading') return <Loading label={l.loading} />;
  if (state.status === 'forbidden') return <EmptyState titleAs="h1" title={l.notAvailableTitle} description={l.notAvailable} />;
  if (state.status === 'not-found') return <EmptyState titleAs="h1" title={l.notFoundTitle} description={l.notFound} />;
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  const data = state.data;
  return (
    <div className="space-y-6" data-course-groups={courseId}>
      <PageHeader
        title={l.courseTitle}
        kicker={data.course.code}
        description={data.viewer.canViewAll ? l.courseIntroStaff : l.courseIntroStudent}
        breadcrumbLabel={t.common.breadcrumb}
        breadcrumbs={[{ label: t.nav.myCourses, href: '/courses' }, { label: data.course.title, href: `/courses/${courseId}` }, { label: l.courseTitle }]}
      />
      <Card as="section" aria-label={l.courseTitle}>
        {data.items.length === 0 ? (
          <EmptyState title={data.viewer.canViewAll ? l.noneCourse : l.noneMine} description={data.viewer.canViewAll ? undefined : l.noneMineHelp} />
        ) : (
          <ul className="divide-y divide-slate-100" data-group-list>
            {data.items.map((group) => (
              <GroupCard key={group.id} group={group} />
            ))}
          </ul>
        )}
      </Card>
      {data.viewer.canManage ? <CreateGroupForm courseId={courseId} onCreated={() => void load()} /> : null}
    </div>
  );
}

function CreateGroupForm({ courseId, onCreated }: { courseId: string; onCreated: () => void }) {
  const { t } = useLocale();
  const c = t.groups.create;
  const { run, pending, result } = useCsrfAction();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError(c.emptyName);
    setError(null);
    if (await run((csrf) => api.createGroup(courseId, { name, description: description.trim() || null }, csrf))) {
      setName('');
      setDescription('');
      onCreated();
    }
  };
  return (
    <Card as="section" aria-labelledby="create-group-heading" className="space-y-3">
      <h2 id="create-group-heading" className="font-semibold text-brand-600">
        {c.title}
      </h2>
      <form className="space-y-3" onSubmit={(event) => void submit(event)} data-create-group>
        <div>
          <label htmlFor="group-name" className="block text-sm font-medium text-slate-800">
            {c.name}
          </label>
          <input id="group-name" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} className={fieldClasses} />
        </div>
        <div>
          <label htmlFor="group-description" className="block text-sm font-medium text-slate-800">
            {c.description}
          </label>
          <textarea id="group-description" rows={2} maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} className={fieldClasses} />
        </div>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
        <Button type="submit" disabled={pending}>
          {pending ? c.submitting : c.submit}
        </Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------
// /groups/[groupId]

export function GroupWorkspaceView({ groupId }: { groupId: string }) {
  return <RequireAuth>{() => <GroupWorkspace groupId={groupId} />}</RequireAuth>;
}

function GroupWorkspace({ groupId }: { groupId: string }) {
  const { t, locale } = useLocale();
  const w = t.groups.workspace;
  const l = t.groups.list;
  const fetcher = useCallback(() => api.getGroup(groupId), [groupId]);
  const { state, load, setState } = useLoader<GroupDetail>(fetcher);
  const [topics, setTopics] = useState<ForumTopicPage | null>(null);
  const [topicsError, setTopicsError] = useState<string | null>(null);
  const canRead = state.status === 'ready' && state.data.viewer.canRead;
  const loadTopics = useCallback(async () => {
    try {
      setTopics(await api.groupTopics(groupId));
      setTopicsError(null);
    } catch (error) {
      setTopicsError(describeApiError(error, locale));
    }
  }, [groupId, locale]);
  useEffect(() => {
    if (canRead) void loadTopics();
  }, [canRead, loadTopics]);

  if (state.status === 'loading') return <Loading label={w.loading} />;
  if (state.status !== 'ready') {
    return state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : <EmptyState titleAs="h1" title={w.notFoundTitle} description={w.notFound} action={<Link href="/groups" className="text-sm text-brand-700 underline">{l.myTitle}</Link>} />;
  }
  const { group, viewer, members, recentTopics, membershipChanges, candidates } = state.data;
  const courseId = group.course.id;
  const refresh = () => {
    void load();
    if (viewer.canRead) void loadTopics();
  };

  return (
    <div className="space-y-6" data-group-workspace={group.id} data-archived={String(group.archived)} data-can-manage={String(viewer.canManage)} data-can-read={String(viewer.canRead)}>
      <PageHeader
        title={group.name}
        kicker={group.course.code}
        description={group.description ?? undefined}
        breadcrumbLabel={t.common.breadcrumb}
        breadcrumbs={[
          { label: t.nav.myCourses, href: '/courses' },
          { label: group.course.title, href: `/courses/${courseId}` },
          { label: l.courseTitle, href: `/courses/${courseId}/groups` },
          { label: group.name },
        ]}
      />
      {group.archived ? <Alert tone="info">{w.archivedNotice}</Alert> : null}
      {!viewer.canRead ? <Alert tone="info">{w.adminNotice}</Alert> : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          {viewer.canRead ? (
            <Card as="section" aria-labelledby="group-discussions-heading" className="space-y-3">
              <h2 id="group-discussions-heading" className="font-semibold text-brand-600">
                {w.discussionsTitle}
              </h2>
              {topicsError ? <Alert tone="error">{topicsError}</Alert> : null}
              {topics === null ? (
                <Loading label={t.common.loading} />
              ) : topics.items.length === 0 ? (
                <p className="text-sm text-slate-600">{w.noDiscussions}</p>
              ) : (
                <ul className="divide-y divide-slate-100" data-group-topics>
                  {topics.items.map((topic) => (
                    <TopicRow key={topic.id} courseId={courseId} topic={topic} />
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
          {viewer.canPost ? <NewTopicForm courseId={courseId} canAnnounce={false} groupId={group.id} heading={w.newTopic} /> : null}
          {viewer.canManage ? <ManageGroup detail={state.data} onChanged={(next) => (next ? setState({ status: 'ready', data: next }) : refresh())} /> : null}
        </div>
        <div className="min-w-0 space-y-6">
          <Card as="section" aria-labelledby="group-members-heading" className="space-y-3">
            <h2 id="group-members-heading" className="font-semibold text-brand-600">
              {w.membersTitle} <span className="text-sm font-normal text-slate-500">({members.length})</span>
            </h2>
            {members.length === 0 ? (
              <p className="text-sm text-slate-600">{w.noMembers}</p>
            ) : (
              <ul className="space-y-2" data-group-members>
                {members.map((member) => (
                  <MemberRow key={member.id} groupId={group.id} member={member} canRemove={viewer.canManage && !group.archived} onRemoved={refresh} />
                ))}
              </ul>
            )}
            {viewer.canManage && !group.archived ? <AddMembers groupId={group.id} candidates={candidates} onAdded={refresh} /> : null}
          </Card>
          {viewer.canRead ? (
            <Card as="section" aria-labelledby="group-activity-heading" className="space-y-2">
              <h2 id="group-activity-heading" className="font-semibold text-brand-600">
                {w.activityTitle}
              </h2>
              {recentTopics.length === 0 ? (
                <p className="text-sm text-slate-600">{w.noActivity}</p>
              ) : (
                <ul className="space-y-2 text-sm" data-group-activity>
                  {recentTopics.map((topic) => (
                    <li key={topic.id} className="break-words">
                      <Link href={`/courses/${courseId}/forum/${topic.id}`} className="text-brand-700 hover:underline">
                        {topic.title}
                      </Link>
                      <span className="block text-xs text-slate-500">
                        {w.replies(topic.replyCount)} · {formatDateTime(topic.lastActivityAt, locale)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
          {membershipChanges.length ? (
            <Card as="section" aria-labelledby="group-changes-heading" className="space-y-2">
              <h2 id="group-changes-heading" className="font-semibold text-brand-600">
                {w.changesTitle}
              </h2>
              <ul className="space-y-1 text-sm text-slate-700" data-membership-changes>
                {membershipChanges.map((change, index) => {
                  const actor = change.actor?.name ?? w.someone;
                  const person = change.person?.name ?? w.someone;
                  const text = change.kind === 'member_added' ? w.change.member_added(person, actor) : change.kind === 'member_removed' ? w.change.member_removed(person, actor) : w.change[change.kind](actor);
                  return (
                    <li key={`${change.kind}-${index}`} className="break-words" data-change={change.kind}>
                      {text}
                      <span className="block text-xs text-slate-500">{formatDateTime(change.at, locale)}</span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MemberRow({ groupId, member, canRemove, onRemoved }: { groupId: string; member: GroupDetail['members'][number]; canRemove: boolean; onRemoved: () => void }) {
  const { t } = useLocale();
  const w = t.groups.workspace;
  const { run, pending, result } = useCsrfAction();
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="space-y-1" data-member={member.name}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm break-words text-slate-900">{member.name}</span>
        {canRemove && !confirming ? (
          <button type="button" className="text-xs text-slate-600 underline" onClick={() => setConfirming(true)} aria-label={`${w.remove}: ${member.name}`} data-remove-member={member.name}>
            {w.remove}
          </button>
        ) : null}
      </div>
      {confirming ? (
        <div className="space-y-2 rounded border border-amber-200 bg-amber-50 p-2">
          <p className="text-xs text-amber-900">{w.removeConfirm(member.name)}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={pending}
              data-confirm-remove
              onClick={async () => {
                if (await run((csrf) => api.removeGroupMember(groupId, member.id, csrf))) onRemoved();
              }}
            >
              {w.confirmRemove}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
              {w.cancel}
            </Button>
          </div>
        </div>
      ) : null}
      {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
    </li>
  );
}

function AddMembers({ groupId, candidates, onAdded }: { groupId: string; candidates: GroupDetail['candidates']; onAdded: () => void }) {
  const { t } = useLocale();
  const w = t.groups.workspace;
  const { run, pending, result } = useCsrfAction();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  return (
    <form
      className="space-y-2 border-t border-slate-100 pt-3"
      data-add-members
      onSubmit={async (event) => {
        event.preventDefault();
        if (!selected.length) return setError(w.selectOne);
        setError(null);
        if (await run((csrf) => api.addGroupMembers(groupId, selected, csrf), (r) => w.added(r.added, r.alreadyMembers))) {
          setSelected([]);
          onAdded();
        }
      }}
    >
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium text-slate-800">{w.addTitle}</legend>
        <p className="text-xs text-slate-500">{w.addHint}</p>
        {candidates.length === 0 ? (
          <p className="text-sm text-slate-600">{w.noCandidates}</p>
        ) : (
          candidates.map((candidate) => (
            <label key={candidate.id} className="flex items-center gap-2 text-sm text-slate-800" data-candidate={candidate.name}>
              <input type="checkbox" checked={selected.includes(candidate.id)} onChange={() => toggle(candidate.id)} />
              <span className="break-words">{candidate.name}</span>
            </label>
          ))
        )}
      </fieldset>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      {candidates.length ? (
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? w.adding : w.add}
        </Button>
      ) : null}
    </form>
  );
}

function ManageGroup({ detail, onChanged }: { detail: GroupDetail; onChanged: (next?: GroupDetail) => void }) {
  const { t } = useLocale();
  const w = t.groups.workspace;
  const c = t.groups.create;
  const { group } = detail;
  const { run, pending, result } = useCsrfAction();
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? '');
  const [confirming, setConfirming] = useState(false);
  return (
    <Card as="section" aria-labelledby="manage-group-heading" className="space-y-3" data-manage-group>
      <h2 id="manage-group-heading" className="font-semibold text-brand-600">
        {w.manageTitle}
      </h2>
      {!group.archived ? (
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const next = await run((csrf) => api.updateGroup(group.id, { name, description: description.trim() || null }, csrf), () => w.saved);
            if (next) onChanged(next);
          }}
        >
          <div>
            <label htmlFor="edit-group-name" className="block text-sm font-medium text-slate-800">
              {c.name}
            </label>
            <input id="edit-group-name" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} className={fieldClasses} />
          </div>
          <div>
            <label htmlFor="edit-group-description" className="block text-sm font-medium text-slate-800">
              {c.description}
            </label>
            <textarea id="edit-group-description" rows={2} maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} className={fieldClasses} />
          </div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? w.saving : w.save}
          </Button>
        </form>
      ) : null}
      <div className="border-t border-slate-100 pt-3">
        {group.archived ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            data-restore-group
            onClick={async () => {
              const next = await run((csrf) => api.setGroupArchived(group.id, false, csrf));
              if (next) onChanged(next);
            }}
          >
            {w.restore}
          </Button>
        ) : confirming ? (
          <div className="space-y-2 rounded border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm text-amber-900">{w.archiveConfirm}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={pending}
                data-confirm-archive
                onClick={async () => {
                  const next = await run((csrf) => api.setGroupArchived(group.id, true, csrf));
                  if (next) {
                    setConfirming(false);
                    onChanged(next);
                  }
                }}
              >
                {w.confirmArchive}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
                {w.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setConfirming(true)} data-archive-group>
            {w.archive}
          </Button>
        )}
      </div>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------
// /admin/groups

export function AdminGroupsView() {
  return <RequireAuth role="administrator">{() => <AdminGroups />}</RequireAuth>;
}

function AdminGroups() {
  const { t } = useLocale();
  const a = t.groups.admin;
  const fetcher = useCallback(() => api.adminGroups(), []);
  const { state } = useLoader<AdminGroupOverview>(fetcher);
  return (
    <div className="space-y-6">
      <PageHeader title={a.title} description={a.intro} breadcrumbLabel={t.common.breadcrumb} breadcrumbs={[{ label: t.nav.administration, href: '/admin' }, { label: a.title }]} />
      <Card as="section" aria-label={a.title}>
        {state.status === 'loading' ? (
          <Loading label={t.common.loading} />
        ) : state.status !== 'ready' ? (
          <Alert tone="error">{state.status === 'error' ? state.message : t.errors.notAllowed}</Alert>
        ) : state.data.items.length === 0 ? (
          <p className="text-sm text-slate-600">{a.none}</p>
        ) : (
          <ul className="divide-y divide-slate-100" data-admin-groups>
            {state.data.items.map((row) => (
              <li key={row.course.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" data-admin-group-course={row.course.code}>
                <div className="min-w-0 space-y-1">
                  <p className="font-medium break-words text-slate-900">
                    {row.course.code} · {row.course.title}
                  </p>
                  <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                    {(
                      [
                        [a.active, row.activeGroups, 'active'],
                        [a.archived, row.archivedGroups, 'archived'],
                        [a.memberships, row.memberships, 'memberships'],
                        [a.withoutGroup, row.studentsWithoutGroup, 'without'],
                      ] as const
                    ).map(([label, value, key]) => (
                      <div key={key} className="flex gap-1" data-count={key}>
                        <dt>{label}:</dt>
                        <dd className="font-medium text-slate-800">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <Link href={`/courses/${row.course.id}/groups`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
                  {a.open}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
