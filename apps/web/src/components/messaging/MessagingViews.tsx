'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { useWorkspace } from '@/components/session/WorkspaceProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Conversation, CourseMessaging, Message } from '@/lib/api/types';
import { formatDateTime } from '@/lib/i18n/messages';
import { newClientMessageId, usePolling, useUnreadSummary } from './polling';

const MAX_LENGTH = 4000;
const CONVERSATION_POLL_MS = 8_000;
const LIST_POLL_MS = 30_000;

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

/** Title of a conversation as its reader sees it. */
function useConversationTitle() {
  const { t } = useLocale();
  return (c: Pick<Conversation, 'kind' | 'counterpart' | 'course'>) => (c.kind === 'course' ? `${t.messaging.messages.courseConversation} · ${c.course.code}` : c.counterpart?.name ?? t.messaging.messages.direct);
}

function ConversationRow({ conversation }: { conversation: Conversation }) {
  const { t, locale } = useLocale();
  const m = t.messaging.messages;
  const title = useConversationTitle();
  return (
    <li data-conversation={conversation.id} data-conversation-kind={conversation.kind} data-unread={conversation.unreadCount}>
      <Link href={`/messages/${conversation.id}`} className="block rounded-lg p-3 hover:bg-slate-50">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium break-words text-slate-900">{title(conversation)}</span>
          {conversation.kind === 'direct' ? <span className="text-xs text-slate-500">{conversation.course.code}</span> : null}
          {conversation.counterpart?.role ? <Badge tone="neutral">{m.roles[conversation.counterpart.role]}</Badge> : null}
          {conversation.locked ? <Badge tone="warning">{m.locked}</Badge> : null}
          {conversation.unreadCount ? <Badge tone="brand">{m.unread(conversation.unreadCount)}</Badge> : null}
        </div>
        <p className="mt-1 truncate text-sm text-slate-600">
          {conversation.lastMessage
            ? `${conversation.lastMessage.senderName}: ${conversation.lastMessage.preview ?? m.hiddenPreview}`
            : m.noMessagesYet}
        </p>
        {conversation.lastMessage ? <p className="text-xs text-slate-500">{formatDateTime(conversation.lastMessage.createdAt, locale)}</p> : null}
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// /messages

export function MyMessagesView() {
  return <RequireAuth>{() => <MyMessages />}</RequireAuth>;
}

function MyMessages() {
  const { t } = useLocale();
  const m = t.messaging.messages;
  const workspace = useWorkspace();
  const fetcher = useCallback(() => api.myConversations(), []);
  const { state, load } = useLoader(fetcher);
  usePolling(load, LIST_POLL_MS);
  const courses = workspace.courses.filter((course) => {
    const role = workspace.roleByCourse.get(course.id);
    return course.status === 'published' && (role === 'student' || role === 'instructor' || role === 'non_editing_instructor');
  });
  return (
    <div className="space-y-6">
      <PageHeader title={m.title} description={m.intro} />
      <p className="text-xs text-slate-500">{m.pollingNote}</p>
      <Card as="section" aria-label={m.title} className="space-y-2">
        {state.status === 'loading' ? (
          <p role="status" className="text-sm text-slate-600">
            {m.loading}
          </p>
        ) : state.status !== 'ready' ? (
          <Alert tone="error">{state.status === 'error' ? state.message : t.common.loadError}</Alert>
        ) : state.data.items.length === 0 ? (
          <EmptyState title={m.none} description={m.noneHelp} />
        ) : (
          <ul className="divide-y divide-slate-100" data-conversation-list>
            {state.data.items.map((conversation) => (
              <ConversationRow key={conversation.id} conversation={conversation} />
            ))}
          </ul>
        )}
      </Card>
      {courses.length ? (
        <Card as="section" aria-labelledby="message-courses" className="space-y-2">
          <h2 id="message-courses" className="font-semibold text-brand-600">
            {m.yourCourses}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {courses.map((course) => (
              <li key={course.id}>
                <Link href={`/courses/${course.id}/messages`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
                  {course.code} · {m.openCourse}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// /courses/[id]/messages

export function CourseMessagesView({ courseId }: { courseId: string }) {
  return <RequireAuth>{() => <CourseMessages courseId={courseId} />}</RequireAuth>;
}

function CourseMessages({ courseId }: { courseId: string }) {
  const { t } = useLocale();
  const m = t.messaging.messages;
  const router = useRouter();
  const fetcher = useCallback(() => api.courseMessaging(courseId), [courseId]);
  const { state, load } = useLoader<CourseMessaging>(fetcher);
  usePolling(load, LIST_POLL_MS);
  const { run, pending, result } = useCsrfAction();
  const open = async (action: (csrf: string) => Promise<Conversation>) => {
    const conversation = await run(action);
    if (conversation) router.push(`/messages/${conversation.id}`);
  };
  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {m.loading}
      </p>
    );
  }
  if (state.status === 'forbidden') return <EmptyState titleAs="h1" title={m.course.notAvailableTitle} description={m.course.notAvailable} />;
  if (state.status === 'not-found') return <EmptyState titleAs="h1" title={t.assignments.book.notAvailableTitle} description={t.assignments.book.notAvailableDescription} />;
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  const data = state.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.course.title}
        kicker={data.course.code}
        description={m.course.intro}
        breadcrumbLabel={t.common.breadcrumb}
        breadcrumbs={[{ label: t.nav.myCourses, href: '/courses' }, { label: data.course.title, href: `/courses/${courseId}` }, { label: m.course.title }]}
      />
      <Card as="section" aria-labelledby="course-conversation-heading" className="space-y-3" data-course-conversation={data.courseConversation?.id ?? 'none'}>
        <h2 id="course-conversation-heading" className="font-semibold text-brand-600">
          {m.courseConversation}
        </h2>
        {data.courseConversation ? (
          <ul>
            <ConversationRow conversation={data.courseConversation} />
          </ul>
        ) : (
          <Button disabled={pending} onClick={() => void open((csrf) => api.openCourseConversation(courseId, csrf))}>
            {m.course.openGroup}
          </Button>
        )}
      </Card>
      <Card as="section" aria-labelledby="direct-heading" className="space-y-3">
        <h2 id="direct-heading" className="font-semibold text-brand-600">
          {m.course.directTitle}
        </h2>
        {data.directConversations.length === 0 ? (
          <p className="text-sm text-slate-600">{m.course.noDirect}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.directConversations.map((conversation) => (
              <ConversationRow key={conversation.id} conversation={conversation} />
            ))}
          </ul>
        )}
      </Card>
      <Card as="section" aria-labelledby="contacts-heading" className="space-y-3">
        <h2 id="contacts-heading" className="font-semibold text-brand-600">
          {data.role === 'student' ? m.course.contactsStudent : m.course.contactsStaff}
        </h2>
        {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
        {data.contacts.length === 0 ? (
          <p className="text-sm text-slate-600">{m.course.noContacts}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.contacts.map((contact) => (
              <li key={contact.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-contact={contact.name}>
                <span className="text-sm text-slate-900">
                  {contact.name} {contact.role ? <Badge tone="neutral">{m.roles[contact.role]}</Badge> : null}
                </span>
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => void open((csrf) => api.openDirectConversation(courseId, contact.id, csrf))}>
                  {m.course.message}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// /messages/[conversationId]

export function ConversationView({ conversationId }: { conversationId: string }) {
  return <RequireAuth>{() => <ConversationPage conversationId={conversationId} />}</RequireAuth>;
}

function ConversationPage({ conversationId }: { conversationId: string }) {
  const { t } = useLocale();
  const m = t.messaging.messages;
  const title = useConversationTitle();
  const { handleUnauthorized, getCsrfToken } = useSession();
  const { refresh: refreshSummary } = useUnreadSummary();
  const fetchConversation = useCallback(() => api.getConversation(conversationId), [conversationId]);
  const conversation = useLoader<Conversation>(fetchConversation);
  const [messages, setMessages] = useState<Message[]>([]);
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const markedSeq = useRef(0);
  const listRef = useRef<HTMLOListElement>(null);

  const merge = useCallback((incoming: Message[], position: 'append' | 'prepend') => {
    setMessages((current) => {
      const known = new Set(current.map((message) => message.id));
      const fresh = incoming.filter((message) => !known.has(message.id));
      const next = position === 'append' ? [...current, ...fresh] : [...fresh, ...current];
      return next.sort((a, b) => a.seq - b.seq);
    });
  }, []);

  // First page: the latest messages.
  useEffect(() => {
    let active = true;
    api
      .listMessages(conversationId, { limit: 30 })
      .then((page) => {
        if (!active) return;
        merge(page.items, 'append');
        setOlderCursor(page.olderCursor);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (isApiError(error, 401)) handleUnauthorized();
        setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [conversationId, merge, handleUnauthorized]);

  const latestSeq = messages.at(-1)?.seq ?? 0;
  // Newer messages, by polling while the page is visible.
  const poll = useCallback(async () => {
    const page = await api.listMessages(conversationId, { after: latestSeq, limit: 100 });
    if (page.items.length) merge(page.items, 'append');
    await conversation.load();
  }, [conversationId, latestSeq, merge, conversation]);
  usePolling(poll, CONVERSATION_POLL_MS, loaded && conversation.state.status === 'ready');

  // Everything shown is read: move the read position forward (never back) and refresh the unread badges.
  useEffect(() => {
    if (!loaded || latestSeq <= markedSeq.current) return;
    markedSeq.current = latestSeq;
    void getCsrfToken()
      .then((csrf) => api.markConversationRead(conversationId, latestSeq, csrf))
      .then(() => refreshSummary())
      .catch(() => {
        markedSeq.current = 0;
      });
  }, [loaded, latestSeq, conversationId, getCsrfToken, refreshSummary]);

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [latestSeq]);

  const loadOlder = async () => {
    if (olderCursor === null) return;
    setLoadingOlder(true);
    try {
      const page = await api.listMessages(conversationId, { before: olderCursor, limit: 30 });
      merge(page.items, 'prepend');
      setOlderCursor(page.olderCursor);
    } finally {
      setLoadingOlder(false);
    }
  };

  if (conversation.state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {m.loading}
      </p>
    );
  }
  if (conversation.state.status !== 'ready') {
    return conversation.state.status === 'error' ? <Alert tone="error">{conversation.state.message}</Alert> : <EmptyState titleAs="h1" title={m.notAvailable} action={<Link href="/messages" className={buttonClasses({ variant: 'secondary' })}>{m.back}</Link>} />;
  }
  const c = conversation.state.data;
  return (
    <div className="space-y-4">
      <PageHeader
        title={title(c)}
        kicker={c.course.code}
        breadcrumbLabel={t.common.breadcrumb}
        breadcrumbs={[{ label: m.title, href: '/messages' }, { label: c.course.code, href: `/courses/${c.course.id}/messages` }, { label: title(c) }]}
      />
      <p className="text-xs text-slate-500">{m.pollingNote}</p>
      {c.kind === 'course' && c.canModerate ? <LockToggle conversation={c} onChanged={() => void conversation.load()} /> : null}
      <Card as="section" aria-label={title(c)} padding="md" className="space-y-3">
        {olderCursor !== null ? (
          <Button size="sm" variant="ghost" disabled={loadingOlder} onClick={() => void loadOlder()}>
            {loadingOlder ? m.loadingOlder : m.loadOlder}
          </Button>
        ) : null}
        {!loaded ? (
          <p className="text-sm text-slate-600">{m.loading}</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-slate-600">{m.noMessagesYet}</p>
        ) : (
          <ol ref={listRef} className="max-h-[60vh] space-y-3 overflow-y-auto px-1" data-message-list aria-live="polite">
            {messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                conversationId={c.id}
                canModerate={c.kind === 'course' && c.canModerate}
                onHidden={(hidden) => setMessages((current) => current.map((item) => (item.id === hidden.id ? hidden : item)))}
              />
            ))}
          </ol>
        )}
      </Card>
      {c.locked ? <Alert tone="info">{m.lockedNotice}</Alert> : !c.canPost ? <Alert tone="info">{m.cannotPost}</Alert> : null}
      {c.canPost ? <Composer conversationId={c.id} onSent={(message) => merge([message], 'append')} /> : null}
    </div>
  );
}

function MessageItem({ message, conversationId, canModerate, onHidden }: { message: Message; conversationId: string; canModerate: boolean; onHidden: (message: Message) => void }) {
  const { t, locale } = useLocale();
  const m = t.messaging.messages;
  const { run, pending, result } = useCsrfAction();
  const [confirming, setConfirming] = useState(false);
  return (
    <li className={`flex ${message.mine ? 'justify-end' : 'justify-start'}`} data-message={message.seq} data-mine={String(message.mine)} data-hidden={String(message.hidden)}>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 ${message.mine ? 'bg-brand-50 text-slate-900' : 'bg-slate-100 text-slate-900'}`}>
        <p className="text-xs text-slate-500">
          <span className="font-medium text-slate-700">{message.mine ? m.you : message.sender.name}</span>
          {message.sender.role && !message.mine ? ` · ${m.roles[message.sender.role]}` : ''} · {formatDateTime(message.createdAt, locale)}
        </p>
        {message.hidden ? (
          <p className="text-sm text-slate-500 italic">{m.hidden}</p>
        ) : (
          <p className="text-sm break-words whitespace-pre-wrap">{message.body}</p>
        )}
        {canModerate && !message.hidden ? (
          confirming ? (
            <div className="mt-2 space-y-2 rounded border border-amber-200 bg-amber-50 p-2">
              <p className="text-xs text-amber-900">{m.hideConfirm}</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={async () => {
                    const hidden = await run((csrf) => api.hideMessage(conversationId, message.id, csrf));
                    if (hidden) onHidden(hidden);
                  }}
                >
                  {m.hide}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
                  {t.common.cancel}
                </Button>
              </div>
            </div>
          ) : (
            <button type="button" className="mt-1 text-xs text-slate-500 underline" onClick={() => setConfirming(true)}>
              {m.hide}
            </button>
          )
        ) : null}
        {result?.tone === 'error' ? <p className="text-xs text-red-700">{result.message}</p> : null}
      </div>
    </li>
  );
}

function LockToggle({ conversation, onChanged }: { conversation: Conversation; onChanged: () => void }) {
  const { t } = useLocale();
  const m = t.messaging.messages;
  const { run, pending, result } = useCsrfAction();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        data-lock-toggle={conversation.locked ? 'unlock' : 'lock'}
        onClick={async () => {
          if (await run((csrf) => api.setConversationLock(conversation.id, !conversation.locked, csrf))) onChanged();
        }}
      >
        {conversation.locked ? m.unlock : m.lock}
      </Button>
      {result?.tone === 'error' ? <span className="text-sm text-red-700">{result.message}</span> : null}
    </div>
  );
}

/** The message box. One idempotency key per message: a retried send never creates a second message. */
function Composer({ conversationId, onSent }: { conversationId: string; onSent: (message: Message) => void }) {
  const { t } = useLocale();
  const m = t.messaging.messages;
  const { run, pending, result } = useCsrfAction();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newClientMessageId());
  const submit = async () => {
    if (!body.trim()) return setError(m.empty);
    if (body.length > MAX_LENGTH) return setError(m.tooLong(MAX_LENGTH));
    setError(null);
    const message = await run((csrf) => api.sendMessage(conversationId, body, key.current, csrf));
    if (message) {
      onSent(message);
      setBody('');
      key.current = newClientMessageId();
    }
  };
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="message-body" className="block text-sm font-medium text-slate-800">
        {m.composerLabel}
      </label>
      <textarea
        id="message-body"
        rows={3}
        maxLength={MAX_LENGTH}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        aria-describedby="message-body-hint"
        className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
      />
      <p id="message-body-hint" className="text-xs text-slate-500">
        {m.composerHint(MAX_LENGTH)}
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {result?.tone === 'error' ? <Alert tone="error">{result.message}</Alert> : null}
      <Button type="submit" disabled={pending}>
        {pending ? m.sending : m.send}
      </Button>
    </form>
  );
}
