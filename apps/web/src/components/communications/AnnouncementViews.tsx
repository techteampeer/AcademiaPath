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
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Announcement, AnnouncementPage, AnnouncementStatus, Course, CurrentUser } from '@/lib/api/types';
import {
  AnnouncementStatusBadge,
  DEFAULT_TIME_ZONE,
  PlainText,
  SourceLabel,
  TIME_ZONES,
  addDays,
  announcementDate,
  todayIn,
  wallTimeToInstant,
} from './communicationDisplay';

type Load<T> = { status: 'loading' } | { status: 'not-found' } | { status: 'error'; message: string } | { status: 'ready'; data: T };
type Filter = 'all' | AnnouncementStatus;
const textareaClasses = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm disabled:bg-slate-100';

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
      else setState({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [fetcher, handleUnauthorized, locale]);
  useEffect(() => {
    void load();
  }, [load]);
  return { state, load, setState };
}

/** Paged list: the first page, then "Load more" appends the next one (the API orders pinned first, then newest). */
function usePagedAnnouncements(fetchPage: (cursor: string | null) => Promise<AnnouncementPage>) {
  const first = useCallback(() => fetchPage(null), [fetchPage]);
  const loader = useLoader<AnnouncementPage>(first);
  const [loadingMore, setLoadingMore] = useState(false);
  const more = async () => {
    if (loader.state.status !== 'ready' || !loader.state.data.nextCursor) return;
    setLoadingMore(true);
    try {
      const current = loader.state.data;
      const next = await fetchPage(current.nextCursor);
      loader.setState({ status: 'ready', data: { items: [...current.items, ...next.items], nextCursor: next.nextCursor } });
    } finally {
      setLoadingMore(false);
    }
  };
  const replace = (item: Announcement) => {
    if (loader.state.status !== 'ready') return;
    const data = loader.state.data;
    loader.setState({ status: 'ready', data: { ...data, items: data.items.map((existing) => (existing.id === item.id ? item : existing)) } });
  };
  return { ...loader, more, loadingMore, replace };
}

// ---------------------------------------------------------------------------------------------------------
// Reading

function MarkReadButton({ item, onRead }: { item: Announcement; onRead: () => void }) {
  const { t } = useLocale();
  const a = t.communications.announcements;
  const { run, pending, result } = useCsrfAction();
  if (item.read) {
    return (
      <span data-read="true">
        <Badge tone="neutral">{a.read}</Badge>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        data-mark-read={item.id}
        disabled={pending}
        onClick={async () => {
          const done = await run((csrf) => api.markAnnouncementRead(item.id, csrf));
          if (done !== null) onRead();
        }}
      >
        {pending ? a.marking : a.markRead}
      </Button>
      {result?.tone === 'error' ? <span className="text-xs text-red-700">{result.message}</span> : null}
    </span>
  );
}

/** One announcement as a reader sees it: plain text, source, date, read state. */
export function AnnouncementCard({ item, onRead, full = false }: { item: Announcement; onRead: (item: Announcement) => void; full?: boolean }) {
  const { t, locale } = useLocale();
  const a = t.communications.announcements;
  return (
    <Card as="article" className="space-y-2" data-announcement={item.title} data-unread={String(!item.read)}>
      <div className="flex flex-wrap items-center gap-2">
        <SourceLabel item={item} />
        {item.pinned ? <Badge tone="brand">{a.pinned}</Badge> : null}
        {!item.read ? <Badge tone="warning">{a.unreadBadge}</Badge> : null}
      </div>
      <h2 className="text-lg font-semibold break-words text-brand-600">
        {full ? item.title : <Link href={`/announcements/${item.id}`} className="hover:underline">{item.title}</Link>}
      </h2>
      <p className="text-xs text-slate-500">{a.published(announcementDate(item, locale))}</p>
      <PlainText text={item.body} className={full ? 'text-sm text-slate-800' : 'line-clamp-4 text-sm text-slate-700'} />
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <MarkReadButton item={item} onRead={() => onRead({ ...item, read: true })} />
        {!full ? (
          <Link href={`/announcements/${item.id}`} className="text-sm font-medium text-brand-700 hover:underline">
            {a.open}
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

function LoadMore({ show, pending, onClick }: { show: boolean; pending: boolean; onClick: () => void }) {
  const { t } = useLocale();
  if (!show) return null;
  return (
    <Button variant="secondary" onClick={onClick} disabled={pending}>
      {pending ? t.common.loading : t.communications.announcements.loadMore}
    </Button>
  );
}

/** /announcements: every announcement the caller may read, with the unread count. */
export function MyAnnouncementsView() {
  return <RequireAuth>{(user) => <Feed user={user} />}</RequireAuth>;
}

function Feed({ user }: { user: CurrentUser }) {
  const { t } = useLocale();
  const a = t.communications.announcements;
  const fetchPage = useCallback((cursor: string | null) => api.myAnnouncements({ limit: 20, cursor }), []);
  const feed = usePagedAnnouncements(fetchPage);
  const fetchCount = useCallback(() => api.myUnreadCount(), []);
  const count = useLoader(fetchCount);
  return (
    <div className="space-y-6">
      <PageHeader title={a.title} description={a.feedIntro} />
      <div className="flex flex-wrap items-center gap-3">
        <span data-unread-count={count.state.status === 'ready' ? count.state.data.unreadCount : ''}>
          {count.state.status === 'ready' ? <Badge tone={count.state.data.unreadCount ? 'warning' : 'neutral'}>{a.unread(count.state.data.unreadCount)}</Badge> : null}
        </span>
        {user.systemRole === 'administrator' ? (
          <Link href="/admin/communications" className="text-sm font-medium text-brand-700 hover:underline">
            {t.communications.dashboard.institutionTools}
          </Link>
        ) : null}
      </div>
      {feed.state.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          {a.loading}
        </p>
      ) : feed.state.status !== 'ready' ? (
        <Alert tone="error">{feed.state.status === 'error' ? feed.state.message : t.common.loadError}</Alert>
      ) : feed.state.data.items.length === 0 ? (
        <EmptyState title={a.none} />
      ) : (
        <div className="space-y-4" data-feed>
          {feed.state.data.items.map((item) => (
            <AnnouncementCard
              key={item.id}
              item={item}
              onRead={(read) => {
                feed.replace(read);
                void count.load();
              }}
            />
          ))}
          <LoadMore show={Boolean(feed.state.data.nextCursor)} pending={feed.loadingMore} onClick={() => void feed.more()} />
        </div>
      )}
    </div>
  );
}

/** /announcements/[id]: one announcement, in full. Anything the caller may not read is "not available". */
export function AnnouncementDetailView({ announcementId }: { announcementId: string }) {
  return <RequireAuth>{() => <Detail announcementId={announcementId} />}</RequireAuth>;
}

function Detail({ announcementId }: { announcementId: string }) {
  const { t } = useLocale();
  const a = t.communications.announcements;
  const fetcher = useCallback(() => api.getAnnouncement(announcementId), [announcementId]);
  const { state, setState } = useLoader(fetcher);
  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {a.loading}
      </p>
    );
  }
  if (state.status === 'not-found') return <EmptyState titleAs="h1" title={a.notFound} />;
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  const item = state.data;
  const back = item.course ? { label: item.course.title, href: `/courses/${item.course.id}/announcements` } : { label: a.title, href: '/announcements' };
  return (
    <div className="space-y-6">
      <PageHeader title={a.title} kicker={item.course?.code ?? a.institution} breadcrumbLabel={t.common.breadcrumb} breadcrumbs={[back, { label: item.title }]} />
      {item.status === 'published' ? (
        <AnnouncementCard item={item} full onRead={(read) => setState({ status: 'ready', data: read })} />
      ) : (
        <Card as="article" className="space-y-2" data-announcement={item.title}>
          <AnnouncementStatusBadge status={item.status} />
          <h2 className="text-lg font-semibold break-words text-brand-600">{item.title}</h2>
          <PlainText text={item.body} className="text-sm text-slate-800" />
        </Card>
      )}
      <Link href={back.href} className="text-sm font-medium text-brand-700 hover:underline">
        {a.back}
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Course page

export function CourseAnnouncementsView({ courseId }: { courseId: string }) {
  return <RequireAuth>{(user) => <CourseAnnouncements courseId={courseId} user={user} />}</RequireAuth>;
}

function CourseAnnouncements({ courseId, user }: { courseId: string; user: CurrentUser }) {
  const { t } = useLocale();
  const a = t.communications.announcements;
  const fetchCourse = useCallback(() => api.getCourse(courseId), [courseId]);
  const { state } = useLoader<Course>(fetchCourse);
  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {a.loading}
      </p>
    );
  }
  if (state.status === 'not-found') return <EmptyState titleAs="h1" title={t.assignments.book.notAvailableTitle} description={t.assignments.book.notAvailableDescription} />;
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  const course = state.data;
  const abilities = contentAbilities(user, course.viewerRole);
  return (
    <div className="space-y-6">
      <PageHeader
        title={a.courseTitle}
        kicker={course.code}
        breadcrumbLabel={t.common.breadcrumb}
        breadcrumbs={[{ label: t.nav.myCourses, href: '/courses' }, { label: course.title, href: `/courses/${courseId}` }, { label: a.title }]}
      />
      {abilities.viewAllCommunications ? (
        <AnnouncementManager target={{ kind: 'course', courseId }} canManage={abilities.manageCommunications} />
      ) : (
        <CourseReader courseId={courseId} />
      )}
    </div>
  );
}

/** Students (and other course roles without staff rights): the course's visible announcements. */
function CourseReader({ courseId }: { courseId: string }) {
  const { t } = useLocale();
  const a = t.communications.announcements;
  const fetchPage = useCallback((cursor: string | null) => api.listCourseAnnouncements(courseId, { cursor }), [courseId]);
  const list = usePagedAnnouncements(fetchPage);
  if (list.state.status === 'loading') return <p className="text-sm text-slate-600">{a.loading}</p>;
  if (list.state.status !== 'ready') return <Alert tone="error">{list.state.status === 'error' ? list.state.message : t.common.loadError}</Alert>;
  if (list.state.data.items.length === 0) return <EmptyState title={a.none} />;
  return (
    <div className="space-y-4" data-feed>
      {list.state.data.items.map((item) => (
        <AnnouncementCard key={item.id} item={item} onRead={list.replace} />
      ))}
      <LoadMore show={Boolean(list.state.data.nextCursor)} pending={list.loadingMore} onClick={() => void list.more()} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Staff management (course or institution-wide)

export type AnnouncementTarget = { kind: 'course'; courseId: string } | { kind: 'institution' };

export function AnnouncementManager({ target, canManage }: { target: AnnouncementTarget; canManage: boolean }) {
  const { t } = useLocale();
  const a = t.communications.announcements;
  const [filter, setFilter] = useState<Filter>('all');
  const courseId = target.kind === 'course' ? target.courseId : null;
  const fetchPage = useCallback(
    (cursor: string | null) =>
      courseId ? api.listCourseAnnouncements(courseId, { status: filter, cursor }) : api.listInstitutionAnnouncements({ status: filter, cursor }),
    [courseId, filter],
  );
  const list = usePagedAnnouncements(fetchPage);
  const prefix = target.kind === 'course' ? 'course' : 'institution';
  return (
    <div className="space-y-6">
      {canManage ? <AnnouncementCreateForm target={target} onCreated={() => void list.load()} /> : <Alert tone="info">{a.manage.readOnly}</Alert>}
      <Card as="section" aria-labelledby={`${prefix}-announcements-heading`} className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id={`${prefix}-announcements-heading`} className="font-semibold text-brand-600">
            {target.kind === 'course' ? a.courseTitle : a.institutionTitle}
          </h2>
          <SelectField
            id={`${prefix}-announcement-filter`}
            label={a.filter}
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
            options={[
              { value: 'all', label: a.all },
              ...(['draft', 'scheduled', 'published', 'archived'] as const).map((status) => ({ value: status, label: a.status[status] })),
            ]}
          />
        </div>
        {list.state.status === 'loading' ? (
          <p className="text-sm text-slate-600">{a.loading}</p>
        ) : list.state.status !== 'ready' ? (
          <Alert tone="error">{list.state.status === 'error' ? list.state.message : t.common.loadError}</Alert>
        ) : list.state.data.items.length === 0 ? (
          <p className="text-sm text-slate-600">{a.none}</p>
        ) : (
          <ul className="divide-y divide-slate-100" data-manage-list={prefix}>
            {list.state.data.items.map((item) => (
              <ManagedAnnouncement key={item.id} item={item} canManage={canManage} onChanged={(updated) => (updated.status === item.status || filter === 'all' ? list.replace(updated) : void list.load())} />
            ))}
          </ul>
        )}
        {list.state.status === 'ready' ? <LoadMore show={Boolean(list.state.data.nextCursor)} pending={list.loadingMore} onClick={() => void list.more()} /> : null}
      </Card>
    </div>
  );
}

function AnnouncementCreateForm({ target, onCreated }: { target: AnnouncementTarget; onCreated: () => void }) {
  const { t } = useLocale();
  const m = t.communications.announcements.manage;
  const { run, pending, result } = useCsrfAction();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefix = target.kind === 'course' ? 'course' : 'institution';
  const submit = async () => {
    if (!title.trim()) return setError(m.titleRequired);
    if (!body.trim()) return setError(m.bodyRequired);
    setError(null);
    const input = { title: title.trim(), body, pinned };
    const created = await run(
      (csrf) => (target.kind === 'course' ? api.createCourseAnnouncement(target.courseId, input, csrf) : api.createInstitutionAnnouncement(input, csrf)),
      () => m.created,
    );
    if (created) {
      setTitle('');
      setBody('');
      setPinned(false);
      onCreated();
    }
  };
  return (
    <Card as="section" id="new-announcement" aria-labelledby={`${prefix}-new-announcement`} className="scroll-mt-20 space-y-3">
      <h2 id={`${prefix}-new-announcement`} className="font-semibold text-brand-600">
        {m.heading}
      </h2>
      <p className="text-sm text-slate-600">{m.intro}</p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField id={`${prefix}-announcement-title`} label={m.title} maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
        <div>
          <label htmlFor={`${prefix}-announcement-body`} className="block text-sm font-medium text-slate-800">
            {m.body}
          </label>
          <textarea id={`${prefix}-announcement-body`} rows={5} maxLength={10000} value={body} onChange={(event) => setBody(event.target.value)} className={textareaClasses} />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-800">
          <input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} />
          {m.pin}
        </label>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
        <Button type="submit" disabled={pending}>
          {pending ? m.creating : m.create}
        </Button>
      </form>
    </Card>
  );
}

type Mode = 'idle' | 'edit' | 'schedule' | 'archive';

function ManagedAnnouncement({ item, canManage, onChanged }: { item: Announcement; canManage: boolean; onChanged: (item: Announcement) => void }) {
  const { t, locale } = useLocale();
  const a = t.communications.announcements;
  const m = a.manage;
  const { run, pending, result, clearResult } = useCsrfAction();
  const [mode, setMode] = useState<Mode>('idle');
  const act = async (action: (csrf: string) => Promise<Announcement>, message: string) => {
    const updated = await run(action, () => message);
    if (updated) {
      setMode('idle');
      onChanged(updated);
    }
  };
  const open = item.status !== 'archived';
  return (
    <li className="space-y-2 py-4" data-managed-announcement={item.title}>
      <div className="flex flex-wrap items-center gap-2">
        <AnnouncementStatusBadge status={item.status} />
        {item.pinned ? <Badge tone="brand">{a.pinned}</Badge> : null}
        {item.course ? <span className="text-xs text-slate-500">{item.course.code}</span> : null}
      </div>
      <h3 className="font-medium break-words text-slate-900">{item.title}</h3>
      <p className="text-xs text-slate-500">
        {item.status === 'scheduled' && item.publishAt
          ? a.scheduledFor(announcementDate(item, locale))
          : item.status === 'published'
            ? a.published(announcementDate(item, locale))
            : a.status[item.status]}
      </p>
      {mode === 'edit' ? (
        <EditForm item={item} pending={pending} onCancel={() => setMode('idle')} onSave={(body) => void act((csrf) => api.updateAnnouncement(item.id, body, csrf), m.saved)} />
      ) : (
        <PlainText text={item.body} className="line-clamp-3 text-sm text-slate-700" />
      )}
      {mode === 'schedule' ? (
        <ScheduleForm pending={pending} onCancel={() => setMode('idle')} onSchedule={(instant) => void act((csrf) => api.publishAnnouncement(item.id, instant, csrf), m.scheduled)} />
      ) : null}
      {mode === 'archive' ? (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-900">{m.archiveConfirm}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={() => void act((csrf) => api.archiveAnnouncement(item.id, csrf), m.archived)}>
              {m.archive}
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => setMode('idle')}>
              {m.cancel}
            </Button>
          </div>
        </div>
      ) : null}
      {canManage && open && mode === 'idle' ? (
        <div className="flex flex-wrap gap-2">
          {item.status !== 'published' ? (
            <Button size="sm" disabled={pending} onClick={() => void act((csrf) => api.publishAnnouncement(item.id, null, csrf), m.published)}>
              {m.publishNow}
            </Button>
          ) : null}
          {item.status === 'draft' ? (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => {
              clearResult();
              setMode('schedule');
            }}>
              {m.schedule}
            </Button>
          ) : null}
          {item.status === 'scheduled' ? (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => void act((csrf) => api.unscheduleAnnouncement(item.id, csrf), m.saved)}>
              {m.unschedule}
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => {
              clearResult();
              setMode('edit');
            }}>
            {m.edit}
          </Button>
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => void act((csrf) => api.updateAnnouncement(item.id, { pinned: !item.pinned }, csrf), m.saved)}>
            {item.pinned ? m.unpinAction : m.pinAction}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
              clearResult();
              setMode('archive');
            }}>
            {m.archive}
          </Button>
        </div>
      ) : null}
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
    </li>
  );
}

function EditForm({ item, pending, onSave, onCancel }: { item: Announcement; pending: boolean; onSave: (body: { title: string; body: string }) => void; onCancel: () => void }) {
  const { t } = useLocale();
  const m = t.communications.announcements.manage;
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3 rounded-lg border border-slate-200 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim()) return setError(m.titleRequired);
        if (!body.trim()) return setError(m.bodyRequired);
        setError(null);
        onSave({ title: title.trim(), body });
      }}
    >
      <TextField id={`edit-title-${item.id}`} label={m.title} maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
      <div>
        <label htmlFor={`edit-body-${item.id}`} className="block text-sm font-medium text-slate-800">
          {m.body}
        </label>
        <textarea id={`edit-body-${item.id}`} rows={5} maxLength={10000} value={body} onChange={(event) => setBody(event.target.value)} className={textareaClasses} />
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {m.save}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={onCancel}>
          {m.cancel}
        </Button>
      </div>
    </form>
  );
}

/** Schedules publication at a wall-clock time in an explicit zone (sent with its offset; the API checks it is in the future). */
function ScheduleForm({ pending, onSchedule, onCancel }: { pending: boolean; onSchedule: (instant: string) => void; onCancel: () => void }) {
  const { t } = useLocale();
  const m = t.communications.announcements.manage;
  const [zone, setZone] = useState(DEFAULT_TIME_ZONE);
  const [date, setDate] = useState(() => addDays(todayIn(DEFAULT_TIME_ZONE), 1));
  const [time, setTime] = useState('08:00');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3 rounded-lg border border-slate-200 p-3"
      data-schedule-form
      onSubmit={(event) => {
        event.preventDefault();
        if (!date || !time) return setError(m.scheduleRequired);
        const instant = wallTimeToInstant(date, time, zone);
        if (Date.parse(instant) <= Date.now()) return setError(m.scheduleRequired);
        setError(null);
        onSchedule(instant);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField id="schedule-date" type="date" label={m.scheduleDate} value={date} onChange={(event) => setDate(event.target.value)} />
        <TextField id="schedule-time" type="time" label={m.scheduleTime} value={time} onChange={(event) => setTime(event.target.value)} />
        <SelectField id="schedule-zone" label={t.communications.calendar.manage.timeZone} value={zone} onChange={(event) => setZone(event.target.value)} options={TIME_ZONES.map((z) => ({ value: z, label: z }))} />
      </div>
      <p className="text-xs text-slate-500">{m.scheduleZone(zone)}</p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {m.schedule}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={onCancel}>
          {m.cancel}
        </Button>
      </div>
    </form>
  );
}
