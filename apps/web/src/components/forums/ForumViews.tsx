'use client';

/**
 * Course discussion forum views (AP-027). Presentation only: who may read, post, edit and moderate, what is
 * hidden, and every limit are decided by the API on each request; these views show what it returns. All
 * texts are rendered as plain text (React escapes them), never as HTML.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { newClientMessageId } from '@/components/messaging/polling';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { ForumPost, ForumPostPage, ForumThreadItem, ForumTopic, ForumTopicAction, ForumTopicPage, ForumTopicSummary } from '@/lib/api/types';
import { formatDateTime } from '@/lib/i18n/messages';

const TITLE_MAX = 200;
const BODY_MAX = 10_000;
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

// ---------------------------------------------------------------------------------------------------------
// /courses/[id]/forum

export function CourseForumView({ courseId }: { courseId: string }) {
  return <RequireAuth>{() => <CourseForum courseId={courseId} />}</RequireAuth>;
}

function CourseForum({ courseId }: { courseId: string }) {
  const { t, locale } = useLocale();
  const f = t.forums.forum;
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const fetcher = useCallback(() => api.forumTopics(courseId, { q: active }), [courseId, active]);
  const { state, setState } = useLoader<ForumTopicPage>(fetcher);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  if (state.status === 'loading') return <Loading label={f.loading} />;
  if (state.status === 'forbidden') return <EmptyState titleAs="h1" title={f.notAvailableTitle} description={f.notAvailable} />;
  if (state.status === 'not-found') return <EmptyState titleAs="h1" title={f.notFoundTitle} description={f.notFound} />;
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  const data = state.data;

  const loadMore = async () => {
    if (!data.nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await api.forumTopics(courseId, { q: active, cursor: data.nextCursor });
      setState({ status: 'ready', data: { ...next, items: [...data.items, ...next.items.filter((item) => !data.items.some((known) => known.id === item.id))] } });
    } catch (error) {
      setMoreError(describeApiError(error, locale));
    } finally {
      setLoadingMore(false);
    }
  };
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setActive(search.trim() || null);
  };

  return (
    <div className="space-y-6" data-forum={courseId} data-forum-role={data.viewer.role ?? 'administrator'}>
      <PageHeader
        title={f.title}
        kicker={data.course.code}
        description={f.intro}
        breadcrumbLabel={t.common.breadcrumb}
        breadcrumbs={[{ label: t.nav.myCourses, href: '/courses' }, { label: data.course.title, href: `/courses/${courseId}` }, { label: f.title }]}
      />
      {data.viewer.role === null ? <Alert tone="info">{f.moderatorOnly}</Alert> : null}
      <Card as="section" aria-labelledby="forum-topics-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="forum-topics-heading" className="font-semibold text-slate-900">
            {t.nav.forum}
          </h2>
          <form role="search" className="flex w-full flex-wrap items-end gap-2 sm:w-auto" onSubmit={submitSearch}>
            <div className="min-w-0 flex-1 sm:w-64 sm:flex-none">
              <label htmlFor="forum-search" className="block text-xs font-medium text-slate-700">
                {f.searchLabel}
              </label>
              <input id="forum-search" type="search" maxLength={100} value={search} onChange={(event) => setSearch(event.target.value)} className={fieldClasses} />
            </div>
            <Button type="submit" size="sm" variant="secondary">
              {f.search}
            </Button>
            {active ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSearch('');
                  setActive(null);
                }}
              >
                {f.clearSearch}
              </Button>
            ) : null}
          </form>
        </div>
        {data.items.length === 0 ? (
          active ? (
            <p className="text-sm text-slate-600">{f.noResults}</p>
          ) : (
            <EmptyState title={f.none} description={data.viewer.canPost ? f.noneHelp : undefined} />
          )
        ) : (
          <ul className="divide-y divide-slate-100" data-forum-topics>
            {data.items.map((topic) => (
              <TopicRow key={topic.id} courseId={courseId} topic={topic} />
            ))}
          </ul>
        )}
        {moreError ? <Alert tone="error">{moreError}</Alert> : null}
        {data.nextCursor ? (
          <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void loadMore()} data-load-more-topics>
            {loadingMore ? f.loadingMore : f.loadMore}
          </Button>
        ) : null}
      </Card>
      {data.viewer.canPost ? <NewTopicForm courseId={courseId} canAnnounce={data.viewer.canModerate} /> : null}
    </div>
  );
}

export function TopicRow({ courseId, topic }: { courseId: string; topic: ForumTopicSummary }) {
  const { t, locale } = useLocale();
  const f = t.forums.forum;
  return (
    <li className="space-y-1 py-3" data-topic={topic.id} data-pinned={String(topic.pinned)} data-locked={String(topic.locked)} data-hidden={String(topic.hidden)}>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/courses/${courseId}/forum/${topic.id}`} className="font-medium break-words text-brand-700 hover:underline">
          {topic.title}
        </Link>
        {topic.pinned ? <Badge tone="brand">{f.pinned}</Badge> : null}
        {topic.locked ? <Badge tone="warning">{f.locked}</Badge> : null}
        {topic.hidden ? <Badge tone="neutral">{f.hidden}</Badge> : null}
      </div>
      <p className="text-sm break-words text-slate-700">{topic.excerpt}</p>
      <p className="text-xs text-slate-500">
        {f.startedBy(topic.mine ? t.forums.topic.you : topic.author.name, formatDateTime(topic.createdAt, locale))} · <span data-reply-count={topic.replyCount}>{f.replies(topic.replyCount)}</span>
        {topic.lastReply ? ` · ${f.lastReply(topic.lastReply.authorName, formatDateTime(topic.lastReply.createdAt, locale))}` : ''}
      </p>
    </li>
  );
}

/**
 * One idempotency key per topic: a retried submission never creates a second topic. With `groupId`, the topic
 * goes to that group's private workspace (AP-028).
 */
export function NewTopicForm({ courseId, canAnnounce, groupId, heading }: { courseId: string; canAnnounce: boolean; groupId?: string; heading?: string }) {
  const { t } = useLocale();
  const f = t.forums.forum;
  const router = useRouter();
  const { run, pending, result } = useCsrfAction();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [announce, setAnnounce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newClientMessageId());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return setError(f.emptyTitle);
    if (!body.trim()) return setError(f.emptyBody);
    setError(null);
    const input = { title, body, clientRequestId: key.current, announce: groupId ? false : announce };
    const topic = await run((csrf) => (groupId ? api.createGroupTopic(groupId, input, csrf) : api.createForumTopic(courseId, input, csrf)));
    if (topic) router.push(`/courses/${courseId}/forum/${topic.id}`);
  };
  return (
    <Card as="section" aria-labelledby="new-topic-heading" className="space-y-3">
      <h2 id="new-topic-heading" className="font-semibold text-slate-900">
        {heading ?? f.newTopic}
      </h2>
      <form className="space-y-3" onSubmit={(event) => void submit(event)} data-new-topic>
        <div>
          <label htmlFor="topic-title" className="block text-sm font-medium text-slate-800">
            {f.titleLabel}
          </label>
          <input id="topic-title" maxLength={TITLE_MAX} value={title} onChange={(event) => setTitle(event.target.value)} className={fieldClasses} />
        </div>
        <div>
          <label htmlFor="topic-body" className="block text-sm font-medium text-slate-800">
            {f.bodyLabel}
          </label>
          <textarea id="topic-body" rows={5} maxLength={BODY_MAX} value={body} onChange={(event) => setBody(event.target.value)} aria-describedby="topic-body-hint" className={fieldClasses} />
          <p id="topic-body-hint" className="mt-1 text-xs text-slate-500">
            {f.bodyHint(BODY_MAX)}
          </p>
        </div>
        {canAnnounce && !groupId ? (
          <div className="flex items-start gap-2">
            <input id="topic-announce" type="checkbox" className="mt-1" checked={announce} onChange={(event) => setAnnounce(event.target.checked)} aria-describedby="topic-announce-hint" />
            <div>
              <label htmlFor="topic-announce" className="text-sm font-medium text-slate-800">
                {f.announce}
              </label>
              <p id="topic-announce-hint" className="text-xs text-slate-500">
                {f.announceHint}
              </p>
            </div>
          </div>
        ) : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
        <Button type="submit" disabled={pending}>
          {pending ? f.creating : f.create}
        </Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------
// /courses/[id]/forum/[topicId]

export function ForumTopicView({ courseId, topicId }: { courseId: string; topicId: string }) {
  return <RequireAuth>{() => <TopicPage courseId={courseId} topicId={topicId} />}</RequireAuth>;
}

function TopicPage({ courseId, topicId }: { courseId: string; topicId: string }) {
  const { t, locale } = useLocale();
  const f = t.forums.forum;
  const p = t.forums.topic;
  const fetcher = useCallback(() => api.getForumTopic(topicId), [topicId]);
  const { state, setState } = useLoader<ForumTopic>(fetcher);
  const [posts, setPosts] = useState<ForumPostPage | null>(null);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  /** Loads replies again, keeping at least as many pages as were already shown. */
  const reloadPosts = useCallback(
    async (keep = 0) => {
      try {
        let page = await api.forumPosts(topicId);
        let items = page.items;
        while (page.nextCursor !== null && items.length < keep) {
          page = await api.forumPosts(topicId, page.nextCursor);
          items = [...items, ...page.items];
        }
        setPosts({ ...page, items });
        setPostsError(null);
      } catch (error) {
        setPostsError(describeApiError(error, locale));
      }
    },
    [topicId, locale],
  );
  useEffect(() => {
    void reloadPosts();
  }, [reloadPosts]);
  // Opening a topic clears its unread notification (best effort: the page works without it).
  const { getCsrfToken } = useSession();
  const loaded = state.status === 'ready';
  useEffect(() => {
    if (!loaded) return;
    void getCsrfToken()
      .then((csrf) => api.markForumTopicRead(topicId, csrf))
      .catch(() => undefined);
  }, [loaded, topicId, getCsrfToken]);

  if (state.status === 'loading') return <Loading label={p.loading} />;
  if (state.status === 'not-found' || state.status === 'forbidden') return <EmptyState titleAs="h1" title={p.notFoundTitle} description={p.notFound} action={<Link href={`/courses/${courseId}/forum`} className="text-sm text-brand-700 underline">{p.back}</Link>} />;
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  const topic = state.data;

  const refresh = async () => {
    try {
      setState({ status: 'ready', data: await api.getForumTopic(topicId) });
    } catch {
      setState({ status: 'not-found' });
      return;
    }
    await reloadPosts(posts?.items.length ?? 0);
  };
  const loadMore = async () => {
    if (!posts?.nextCursor) return;
    setLoadingMore(true);
    try {
      const next = await api.forumPosts(topicId, posts.nextCursor);
      setPosts({ ...next, items: [...posts.items, ...next.items] });
    } catch (error) {
      setPostsError(describeApiError(error, locale));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-6" data-forum-topic={topic.id} data-locked={String(topic.locked)} data-hidden={String(topic.hidden)} data-pinned={String(topic.pinned)}>
      <PageHeader
        title={topic.title}
        kicker={topic.course.code}
        breadcrumbLabel={t.common.breadcrumb}
        breadcrumbs={[
          { label: t.nav.myCourses, href: '/courses' },
          { label: topic.course.title, href: `/courses/${courseId}` },
          ...(topic.group
            ? [
                { label: t.groups.list.courseTitle, href: `/courses/${courseId}/groups` },
                { label: topic.group.name, href: `/groups/${topic.group.id}` },
              ]
            : [{ label: f.title, href: `/courses/${courseId}/forum` }]),
          { label: topic.title },
        ]}
      />
      {topic.group ? (
        <p className="text-sm text-slate-600" data-topic-group={topic.group.id}>
          <Badge tone="brand">{t.forums.topic.groupBadge(topic.group.name)}</Badge>
        </p>
      ) : null}
      {topic.group?.archived ? <Alert tone="info">{t.groups.workspace.archivedNotice}</Alert> : null}
      {topic.hidden ? <Alert tone="info">{p.hiddenNotice}</Alert> : null}
      {topic.locked ? <Alert tone="info">{p.lockedNotice}</Alert> : null}
      <Card as="article" aria-labelledby="topic-opening" className="space-y-3">
        <h2 id="topic-opening" className="sr-only">
          {topic.title}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {topic.pinned ? <Badge tone="brand">{f.pinned}</Badge> : null}
          {topic.locked ? <Badge tone="warning">{f.locked}</Badge> : null}
          {topic.hidden ? <Badge tone="neutral">{f.hidden}</Badge> : null}
        </div>
        <TopicBody topic={topic} onSaved={(updated) => setState({ status: 'ready', data: updated })} />
        {topic.canModerate ? <TopicModeration topic={topic} onChanged={(updated) => { setState({ status: 'ready', data: updated }); void reloadPosts(posts?.items.length ?? 0); }} /> : null}
      </Card>
      <Card as="section" aria-labelledby="replies-heading" className="space-y-4">
        <h2 id="replies-heading" className="font-semibold text-slate-900">
          {p.repliesTitle} <span className="text-sm font-normal text-slate-500">({posts?.total ?? topic.replyCount})</span>
        </h2>
        {postsError ? <Alert tone="error">{postsError}</Alert> : null}
        {posts === null ? (
          <Loading label={t.common.loading} />
        ) : posts.items.length === 0 ? (
          <p className="text-sm text-slate-600">{p.noReplies}</p>
        ) : (
          <ol className="space-y-4" data-forum-replies>
            {posts.items.map((post) => (
              <ThreadEntry key={post.id} post={post} topic={topic} onChanged={() => void refresh()} />
            ))}
          </ol>
        )}
        {posts?.nextCursor ? (
          <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void loadMore()} data-load-more-replies>
            {loadingMore ? f.loadingMore : p.loadMore}
          </Button>
        ) : null}
      </Card>
      {topic.canReply ? (
        <Card as="section" aria-labelledby="reply-heading" className="space-y-3">
          <h2 id="reply-heading" className="font-semibold text-slate-900">
            {p.replyTitle}
          </h2>
          <ReplyForm topicId={topic.id} label={p.replyLabel} inputId="reply-body" onPosted={() => void refresh()} />
        </Card>
      ) : null}
    </div>
  );
}

function Byline({ name, mine, role, createdAt, editedAt }: { name: string; mine: boolean; role: ForumPost['author']['role']; createdAt: string; editedAt: string | null }) {
  const { t, locale } = useLocale();
  const p = t.forums.topic;
  return (
    <p className="text-xs text-slate-500">
      <span className="font-medium text-slate-700">{mine ? p.you : name}</span>
      {role ? ` · ${t.messaging.messages.roles[role]}` : ''} · {formatDateTime(createdAt, locale)}
      {editedAt ? <span data-edited> · {p.edited}</span> : null}
    </p>
  );
}

function TopicBody({ topic, onSaved }: { topic: ForumTopic; onSaved: (topic: ForumTopic) => void }) {
  const { t, locale } = useLocale();
  const p = t.forums.topic;
  const f = t.forums.forum;
  const { run, pending, result } = useCsrfAction();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(topic.title);
  const [body, setBody] = useState(topic.body);
  if (editing) {
    return (
      <form
        className="space-y-3"
        data-edit-topic
        onSubmit={async (event) => {
          event.preventDefault();
          const updated = await run((csrf) => api.updateForumTopic(topic.id, { title, body }, csrf));
          if (updated) {
            onSaved(updated);
            setEditing(false);
          }
        }}
      >
        <div>
          <label htmlFor="edit-topic-title" className="block text-sm font-medium text-slate-800">
            {f.titleLabel}
          </label>
          <input id="edit-topic-title" maxLength={TITLE_MAX} value={title} onChange={(event) => setTitle(event.target.value)} className={fieldClasses} />
        </div>
        <div>
          <label htmlFor="edit-topic-body" className="block text-sm font-medium text-slate-800">
            {f.bodyLabel}
          </label>
          <textarea id="edit-topic-body" rows={5} maxLength={BODY_MAX} value={body} onChange={(event) => setBody(event.target.value)} className={fieldClasses} />
        </div>
        {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? p.saving : p.save}
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)}>
            {p.cancel}
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="space-y-2">
      <Byline name={topic.author.name} mine={topic.mine} role={topic.author.role} createdAt={topic.createdAt} editedAt={topic.editedAt} />
      <p className="text-sm break-words whitespace-pre-wrap text-slate-900" data-topic-body>
        {topic.body}
      </p>
      {topic.canEdit && topic.editableUntil ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setTitle(topic.title);
              setBody(topic.body);
              setEditing(true);
            }}
            data-edit-topic-button
          >
            {p.edit}
          </Button>
          <span className="text-xs text-slate-500">{p.editUntil(formatDateTime(topic.editableUntil, locale))}</span>
        </div>
      ) : null}
    </div>
  );
}

function TopicModeration({ topic, onChanged }: { topic: ForumTopic; onChanged: (topic: ForumTopic) => void }) {
  const { t } = useLocale();
  const p = t.forums.topic;
  const { run, pending, result } = useCsrfAction();
  const [confirming, setConfirming] = useState(false);
  const act = async (action: ForumTopicAction) => {
    const updated = await run((csrf) => api.moderateForumTopic(topic.id, action, csrf));
    if (updated) {
      setConfirming(false);
      onChanged(updated);
    }
  };
  return (
    <div className="space-y-2 border-t border-slate-100 pt-3" role="group" aria-label={p.moderation} data-topic-moderation>
      <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{p.moderation}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => void act(topic.pinned ? 'unpin' : 'pin')} data-moderate={topic.pinned ? 'unpin' : 'pin'}>
          {topic.pinned ? p.unpin : p.pin}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => void act(topic.locked ? 'unlock' : 'lock')} data-moderate={topic.locked ? 'unlock' : 'lock'}>
          {topic.locked ? p.unlock : p.lock}
        </Button>
        {topic.hidden ? (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => void act('restore')} data-moderate="restore">
            {p.restore}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => setConfirming(true)} data-moderate="hide">
            {p.hide}
          </Button>
        )}
      </div>
      {confirming ? (
        <div className="space-y-2 rounded border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-900">{p.hideTopicConfirm}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={() => void act('hide')} data-confirm-hide>
              {p.confirmHide}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
              {p.cancel}
            </Button>
          </div>
        </div>
      ) : null}
      {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
    </div>
  );
}

function ThreadEntry({ post, topic, onChanged }: { post: ForumThreadItem; topic: ForumTopic; onChanged: () => void }) {
  const { t } = useLocale();
  const p = t.forums.topic;
  const [replying, setReplying] = useState(false);
  return (
    <li className="space-y-3" data-post={post.number}>
      <PostItem post={post} topic={topic} onChanged={onChanged} />
      {post.replies.length ? (
        <ol className="ml-3 space-y-3 border-l-2 border-slate-100 pl-3 sm:ml-6 sm:pl-4" aria-label={p.repliesTitle}>
          {post.replies.map((child) => (
            <li key={child.id} data-post={child.number} data-parent={post.number}>
              <PostItem post={child} topic={topic} onChanged={onChanged} />
            </li>
          ))}
        </ol>
      ) : null}
      {topic.canReply && !post.hidden ? (
        replying ? (
          <div className="ml-3 sm:ml-6">
            <ReplyForm
              topicId={topic.id}
              parentPostId={post.id}
              inputId={`reply-to-${post.id}`}
              label={p.replyToLabel(post.mine ? p.you : post.author.name)}
              onPosted={() => {
                setReplying(false);
                onChanged();
              }}
              onCancel={() => setReplying(false)}
            />
          </div>
        ) : (
          <button type="button" className="ml-3 text-sm text-brand-700 underline sm:ml-6" onClick={() => setReplying(true)} data-answer={post.number}>
            {p.answer}
          </button>
        )
      ) : null}
    </li>
  );
}

function PostItem({ post, topic, onChanged }: { post: ForumPost; topic: ForumTopic; onChanged: () => void }) {
  const { t, locale } = useLocale();
  const p = t.forums.topic;
  const f = t.forums.forum;
  const { run, pending, result } = useCsrfAction();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(post.body);
  const [confirming, setConfirming] = useState(false);
  const moderate = async (action: 'hide' | 'restore') => {
    if (await run((csrf) => api.moderateForumPost(post.id, action, csrf))) {
      setConfirming(false);
      onChanged();
    }
  };
  return (
    <div className={`space-y-2 rounded-lg px-3 py-2 ${post.hidden ? 'border border-dashed border-slate-300 bg-slate-50' : 'bg-slate-50'}`} data-post-id={post.id} data-hidden={String(post.hidden)} data-mine={String(post.mine)}>
      <div className="flex flex-wrap items-center gap-2">
        <Byline name={post.author.name} mine={post.mine} role={post.author.role} createdAt={post.createdAt} editedAt={post.editedAt} />
        {post.hidden ? <Badge tone="neutral">{f.hidden}</Badge> : null}
      </div>
      {post.hidden ? <p className="text-xs text-slate-500 italic">{p.hiddenPost}</p> : null}
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await run((csrf) => api.updateForumPost(post.id, body, csrf))) {
              setEditing(false);
              onChanged();
            }
          }}
        >
          <label htmlFor={`edit-post-${post.id}`} className="sr-only">
            {f.bodyLabel}
          </label>
          <textarea id={`edit-post-${post.id}`} rows={3} maxLength={BODY_MAX} value={body} onChange={(event) => setBody(event.target.value)} className={fieldClasses} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? p.saving : p.save}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)}>
              {p.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <p className={`text-sm break-words whitespace-pre-wrap ${post.hidden ? 'text-slate-500' : 'text-slate-900'}`} data-post-body>
          {post.body}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {post.canEdit && post.editableUntil && !editing ? (
          <>
            <button
              type="button"
              className="text-xs text-slate-600 underline"
              onClick={() => {
                setBody(post.body);
                setEditing(true);
              }}
              data-edit-post={post.number}
            >
              {p.edit}
            </button>
            <span className="text-xs text-slate-500">{p.editUntil(formatDateTime(post.editableUntil, locale))}</span>
          </>
        ) : null}
        {topic.canModerate ? (
          post.hidden ? (
            <button type="button" className="text-xs text-slate-600 underline" disabled={pending} onClick={() => void moderate('restore')} data-restore-post={post.number}>
              {p.restore}
            </button>
          ) : (
            <button type="button" className="text-xs text-slate-600 underline" onClick={() => setConfirming(true)} data-hide-post={post.number}>
              {p.hide}
            </button>
          )
        ) : null}
      </div>
      {confirming ? (
        <div className="space-y-2 rounded border border-amber-200 bg-amber-50 p-2">
          <p className="text-xs text-amber-900">{p.hidePostConfirm}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={() => void moderate('hide')} data-confirm-hide-post>
              {p.confirmHide}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
              {p.cancel}
            </Button>
          </div>
        </div>
      ) : null}
      {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
    </div>
  );
}

/** The reply box. One idempotency key per reply: a retried send never creates a second reply. */
function ReplyForm({ topicId, parentPostId, label, inputId, onPosted, onCancel }: { topicId: string; parentPostId?: string; label: string; inputId: string; onPosted: () => void; onCancel?: () => void }) {
  const { t } = useLocale();
  const p = t.forums.topic;
  const f = t.forums.forum;
  const { run, pending, result } = useCsrfAction();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newClientMessageId());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return setError(f.emptyBody);
    setError(null);
    const post = await run((csrf) => api.createForumPost(topicId, { body, clientRequestId: key.current, ...(parentPostId ? { parentPostId } : {}) }, csrf));
    if (post) {
      setBody('');
      key.current = newClientMessageId();
      onPosted();
    }
  };
  return (
    <form className="space-y-2" onSubmit={(event) => void submit(event)} data-reply-form={parentPostId ?? 'topic'}>
      <label htmlFor={inputId} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <textarea id={inputId} rows={3} maxLength={BODY_MAX} value={body} onChange={(event) => setBody(event.target.value)} aria-describedby={`${inputId}-hint`} className={fieldClasses} />
      <p id={`${inputId}-hint`} className="text-xs text-slate-500">
        {f.bodyHint(BODY_MAX)}
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? p.replying : p.reply}
        </Button>
        {onCancel ? (
          <Button type="button" size="sm" variant="secondary" onClick={onCancel}>
            {p.cancel}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
