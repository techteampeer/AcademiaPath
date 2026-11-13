'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { contentAbilities } from '@/components/content/contentDisplay';
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
import { SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Calendar, CalendarDueDate, CalendarEvent, CalendarEventInput, Course, CurrentUser, TeachingSessionMode } from '@/lib/api/types';
import {
  DEFAULT_TIME_ZONE,
  EventStatusBadge,
  PlainText,
  TIME_ZONES,
  addDays,
  dateInZone,
  eventDay,
  formatEventWhen,
  formatInZone,
  formatPlainDate,
  formatTimeInZone,
  instantToWall,
  todayIn,
  wallTimeToInstant,
} from './communicationDisplay';

type Load<T> = { status: 'loading' } | { status: 'not-found' } | { status: 'error'; message: string } | { status: 'ready'; data: T };
const WINDOW_DAYS = 30;
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
    setState({ status: 'loading' });
    void load();
  }, [load]);
  return { state, load };
}

/** A 30-day window starting at local midnight of `start` in the institution's zone (sent as explicit instants). */
function useWindow() {
  const [start, setStart] = useState(() => todayIn(DEFAULT_TIME_ZONE));
  const range = useMemo(
    () => ({ from: wallTimeToInstant(start, '00:00', DEFAULT_TIME_ZONE), to: wallTimeToInstant(addDays(start, WINDOW_DAYS), '00:00', DEFAULT_TIME_ZONE) }),
    [start],
  );
  return { start, setStart, range };
}

function WindowControls({ start, setStart }: { start: string; setStart: (value: string) => void }) {
  const { t, locale } = useLocale();
  const c = t.communications.calendar;
  return (
    <div className="flex flex-wrap items-center gap-2" data-window={start}>
      <Button size="sm" variant="secondary" onClick={() => setStart(addDays(start, -WINDOW_DAYS))}>
        {c.previous}
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setStart(todayIn(DEFAULT_TIME_ZONE))}>
        {c.today}
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setStart(addDays(start, WINDOW_DAYS))}>
        {c.next}
      </Button>
      <span className="text-sm text-slate-600">{c.period(formatPlainDate(start, locale), formatPlainDate(addDays(start, WINDOW_DAYS - 1), locale))}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Agenda

/** "miércoles, 11 de nov." → "Miércoles, 11 de nov." (CSS capitalize would also capitalize "de"). */
const upperFirst = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

type AgendaEntry = { kind: 'event'; day: string; at: string; event: CalendarEvent } | { kind: 'due'; day: string; at: string; due: CalendarDueDate };

function agendaEntries(events: CalendarEvent[], dueDates: CalendarDueDate[], zone: string): AgendaEntry[] {
  const entries: AgendaEntry[] = [
    ...events.map((event) => ({ kind: 'event' as const, day: eventDay(event, zone), at: event.allDay ? '' : event.startsAt, event })),
    ...dueDates.map((due) => ({ kind: 'due' as const, day: dateInZone(due.dueAt, zone), at: due.dueAt, due })),
  ];
  // All-day events first within a day, then by time.
  return entries.sort((a, b) => (a.day === b.day ? a.at.localeCompare(b.at) : a.day.localeCompare(b.day)));
}

/** Upcoming events and due dates grouped by day; times always name their zone. */
export function Agenda({
  events,
  dueDates,
  zone,
  showCourse,
  renderActions,
}: {
  events: CalendarEvent[];
  dueDates: CalendarDueDate[];
  zone: string;
  showCourse: boolean;
  renderActions?: (event: CalendarEvent) => ReactNode;
}) {
  const { t, locale } = useLocale();
  const c = t.communications.calendar;
  const entries = agendaEntries(events, dueDates, zone);
  if (entries.length === 0) return <p className="text-sm text-slate-600">{c.none}</p>;
  const days = [...new Set(entries.map((entry) => entry.day))];
  return (
    <ol className="space-y-5" data-agenda>
      {days.map((day) => (
        <li key={day} data-day={day}>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">{upperFirst(formatPlainDate(day, locale, true))}</h3>
          <ul className="space-y-2">
            {entries
              .filter((entry) => entry.day === day)
              .map((entry) =>
                entry.kind === 'event' ? (
                  <li key={entry.event.id} className="rounded-lg border border-slate-200 p-3" data-event={entry.event.title} data-event-state={entry.event.status}>
                    <div className="flex flex-wrap items-center gap-2">
                      {showCourse ? <span className="text-xs font-medium text-slate-500">{entry.event.course?.code ?? c.institution}</span> : null}
                      {entry.event.session ? <SessionBadges session={entry.event.session} /> : null}
                      {entry.event.allDay ? <Badge tone="brand">{c.allDay}</Badge> : null}
                      {entry.event.status !== 'published' ? <EventStatusBadge status={entry.event.status} /> : null}
                    </div>
                    <p className={`mt-1 font-medium break-words text-slate-900 ${entry.event.status === 'cancelled' ? 'line-through' : ''}`}>{entry.event.title}</p>
                    <p className="text-sm text-slate-600" data-event-when>
                      {formatEventWhen(entry.event, locale, c.allDay)}
                    </p>
                    {entry.event.description ? <PlainText text={entry.event.description} className="mt-1 text-sm text-slate-700" /> : null}
                    <SessionDetails event={entry.event} />
                    {renderActions ? renderActions(entry.event) : null}
                  </li>
                ) : (
                  <li key={`due-${entry.due.activityId}`} className="rounded-lg border border-amber-200 bg-amber-50/40 p-3" data-due={entry.due.title}>
                    <div className="flex flex-wrap items-center gap-2">
                      {showCourse && entry.due.course ? <span className="text-xs font-medium text-slate-500">{entry.due.course.code}</span> : null}
                      <Badge tone="warning">{c.due}</Badge>
                    </div>
                    <p className="mt-1 font-medium break-words text-slate-900">
                      {entry.due.course ? (
                        <Link href={`/courses/${entry.due.course.id}/activities/${entry.due.activityId}`} className="hover:underline">
                          {c.dueLabel(entry.due.title)}
                        </Link>
                      ) : (
                        c.dueLabel(entry.due.title)
                      )}
                    </p>
                    <p className="text-sm text-slate-600">
                      {formatTimeInZone(entry.due.dueAt, zone, locale)} ({zone})
                      {entry.due.lateUntil ? ` · ${c.lateUntil(formatInZone(entry.due.lateUntil, zone, locale))}` : ''}
                    </p>
                  </li>
                ),
              )}
          </ul>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------------------------------------
// AP-045 hybrid teaching sessions: course events with a session number, a delivery mode, units and links

const SESSION_MODES: TeachingSessionMode[] = ['live_online', 'asynchronous', 'presentation'];
type SessionView = NonNullable<CalendarEvent['session']>;

function SessionBadges({ session }: { session: SessionView }) {
  const { t } = useLocale();
  const s = t.communications.calendar.session;
  return (
    <>
      <span data-session-number={session.number}>
        <Badge tone="gold">{s.number(session.number)}</Badge>
      </span>
      <span data-session-mode={session.deliveryMode}>
        <Badge tone="neutral">{s.modes[session.deliveryMode]}</Badge>
      </span>
    </>
  );
}

/** Units (links to the course outline), the linked activity and the external classroom link of a session. */
function SessionDetails({ event }: { event: CalendarEvent }) {
  const { t } = useLocale();
  const s = t.communications.calendar.session;
  const session = event.session;
  if (!session) return null;
  const courseId = event.course?.id;
  const joinUrl = session.joinUrl && session.joinUrl.startsWith('https://') && event.status !== 'cancelled' ? session.joinUrl : null;
  return (
    <div className="mt-2 space-y-2 text-sm" data-session-details={session.number}>
      {session.units.length > 0 ? (
        <p className="break-words text-slate-700" data-session-units>
          <span className="font-medium text-slate-800">{s.units}:</span>{' '}
          {session.units.map((unit, index) => (
            <span key={unit.id}>
              {index > 0 ? ', ' : ''}
              {courseId ? (
                <Link href={`/courses/${courseId}#section-${unit.id}`} className="text-brand-700 hover:underline">
                  {unit.title}
                </Link>
              ) : (
                unit.title
              )}
            </span>
          ))}
        </p>
      ) : null}
      {session.activity && courseId ? (
        <p className="break-words text-slate-700" data-session-activity>
          <span className="font-medium text-slate-800">{s.activity}:</span>{' '}
          <Link href={`/courses/${courseId}/activities/${session.activity.id}`} className="text-brand-700 hover:underline">
            {session.activity.title}
          </Link>
        </p>
      ) : null}
      {joinUrl ? (
        <a href={joinUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses({ size: 'sm' })} data-join-class>
          {s.join}
          <span className="sr-only"> {s.external}</span>
        </a>
      ) : null}
    </div>
  );
}

const PLAN_PAST_DAYS = 180;
const PLAN_FUTURE_DAYS = 219;

/** The course's teaching sessions in number order, with their units (one calendar request over a wide window). */
function SessionPlan({ courseId, version }: { courseId: string; version: number }) {
  const { t, locale } = useLocale();
  const c = t.communications.calendar;
  const s = c.session;
  const range = useMemo(() => {
    const today = todayIn(DEFAULT_TIME_ZONE);
    return { from: wallTimeToInstant(addDays(today, -PLAN_PAST_DAYS), '00:00', DEFAULT_TIME_ZONE), to: wallTimeToInstant(addDays(today, PLAN_FUTURE_DAYS), '00:00', DEFAULT_TIME_ZONE) };
  }, []);
  const fetcher = useCallback(() => {
    void version;
    return api.courseCalendar(courseId, range);
  }, [courseId, range, version]);
  const { state } = useLoader<Calendar>(fetcher);
  const sessions =
    state.status === 'ready'
      ? state.data.events.filter((event) => event.session).sort((a, b) => a.session!.number - b.session!.number || a.startsAt.localeCompare(b.startsAt))
      : [];
  return (
    <Card as="section" aria-labelledby="session-plan-heading" className="space-y-3" data-session-plan={sessions.length}>
      <h2 id="session-plan-heading" className="font-semibold text-brand-600">
        {s.planHeading}
      </h2>
      <p className="text-sm text-slate-600">{s.planIntro}</p>
      {state.status === 'loading' ? (
        <p className="text-sm text-slate-600">{s.planLoading}</p>
      ) : state.status !== 'ready' ? (
        <Alert tone="error">{state.status === 'error' ? state.message : t.common.loadError}</Alert>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-slate-600" data-session-plan-empty>
          {s.planNone}
        </p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {sessions.map((event) => (
            <li key={event.id} className="grid gap-1 py-3 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] sm:gap-4" data-plan-session={event.session!.number}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <SessionBadges session={event.session!} />
                  {event.status !== 'published' ? <EventStatusBadge status={event.status} /> : null}
                </div>
                <p className="mt-1 text-sm text-slate-600">{formatEventWhen(event, locale, c.allDay)}</p>
              </div>
              <div className="min-w-0">
                <p className={`font-medium break-words text-slate-900 ${event.status === 'cancelled' ? 'line-through' : ''}`}>{event.title}</p>
                <p className="text-sm break-words text-slate-600" data-plan-units>
                  {event.session!.units.length ? event.session!.units.map((unit) => unit.title).join(', ') : s.noUnits}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-slate-500">{s.planRange}</p>
    </Card>
  );
}

type SessionOptions = { status: 'idle' | 'loading' | 'error' } | { status: 'ready'; units: Array<{ id: string; title: string }>; activities: Array<{ id: string; label: string }> };

/** The course's units and activities for the session form, loaded only when a session is being configured. */
function useSessionOptions(courseId: string | null, enabled: boolean): SessionOptions {
  const [options, setOptions] = useState<SessionOptions>({ status: 'idle' });
  useEffect(() => {
    if (!courseId || !enabled || options.status !== 'idle') return;
    setOptions({ status: 'loading' });
    void (async () => {
      try {
        const units = (await api.listSections(courseId, { limit: 100 })).items.map((section) => ({ id: section.id, title: section.title }));
        const pages = await Promise.all(units.map((unit) => api.listActivities(courseId, unit.id, { limit: 100 })));
        const activities = pages.flatMap((page, index) => page.items.map((activity) => ({ id: activity.id, label: `${units[index]!.title} · ${activity.title}` })));
        setOptions({ status: 'ready', units, activities });
      } catch {
        setOptions({ status: 'error' });
      }
    })();
  }, [courseId, enabled, options.status]);
  return options;
}

// ---------------------------------------------------------------------------------------------------------
// /calendar

export function MyCalendarView() {
  return <RequireAuth>{() => <MyCalendar />}</RequireAuth>;
}

function MyCalendar() {
  const { t } = useLocale();
  const c = t.communications.calendar;
  const workspace = useWorkspace();
  const { start, setStart, range } = useWindow();
  const [courseId, setCourseId] = useState('');
  const fetcher = useCallback(() => api.myCalendar({ ...range, courseId: courseId || null }), [range, courseId]);
  const { state } = useLoader<Calendar>(fetcher);
  // Only courses the user holds a role in (administrator access alone gives no personal calendar).
  const mine = workspace.courses.filter((course) => workspace.roleByCourse.get(course.id));
  return (
    <div className="space-y-6">
      <PageHeader title={c.title} description={c.intro} />
      <Card className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SelectField
            id="calendar-course"
            label={c.course}
            value={courseId}
            onChange={(event) => setCourseId(event.target.value)}
            options={[{ value: '', label: c.allCourses }, ...mine.map((course) => ({ value: course.id, label: `${course.code} · ${course.title}` }))]}
          />
          <WindowControls start={start} setStart={setStart} />
        </div>
        {state.status === 'loading' ? (
          <p role="status" className="text-sm text-slate-600">
            {c.loading}
          </p>
        ) : state.status === 'not-found' ? (
          <Alert tone="info">{c.none}</Alert>
        ) : state.status === 'error' ? (
          <Alert tone="error">{state.message}</Alert>
        ) : (
          <>
            <p className="text-xs text-slate-500">{c.timeZoneNote(state.data.timeZone)}</p>
            <Agenda events={state.data.events} dueDates={state.data.dueDates} zone={state.data.timeZone} showCourse={!courseId} />
          </>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// /courses/[id]/calendar

export function CourseCalendarView({ courseId }: { courseId: string }) {
  return <RequireAuth>{(user) => <CourseCalendar courseId={courseId} user={user} />}</RequireAuth>;
}

function CourseCalendar({ courseId, user }: { courseId: string; user: CurrentUser }) {
  const { t } = useLocale();
  const c = t.communications.calendar;
  const fetchCourse = useCallback(() => api.getCourse(courseId), [courseId]);
  const { state } = useLoader<Course>(fetchCourse);
  if (state.status === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        {c.loading}
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
        title={c.courseTitle}
        kicker={course.code}
        breadcrumbLabel={t.common.breadcrumb}
        breadcrumbs={[{ label: t.nav.myCourses, href: '/courses' }, { label: course.title, href: `/courses/${courseId}` }, { label: c.title }]}
      />
      <EventCalendar target={{ kind: 'course', courseId }} staff={abilities.viewAllCommunications} canManage={abilities.manageCommunications} />
    </div>
  );
}

export type EventTarget = { kind: 'course'; courseId: string } | { kind: 'institution' };

/** One calendar (a course's, or the institution-wide events) with staff management when allowed. */
export function EventCalendar({ target, staff, canManage }: { target: EventTarget; staff: boolean; canManage: boolean }) {
  const { t } = useLocale();
  const c = t.communications.calendar;
  const { start, setStart, range } = useWindow();
  const courseId = target.kind === 'course' ? target.courseId : null;
  const fetcher = useCallback(
    async (): Promise<Calendar> =>
      courseId
        ? api.courseCalendar(courseId, range)
        : { timeZone: DEFAULT_TIME_ZONE, ...range, events: (await api.institutionEvents(range)).items, dueDates: [] },
    [courseId, range],
  );
  const { state, load } = useLoader<Calendar>(fetcher);
  const [version, setVersion] = useState(0);
  const reload = () => {
    void load();
    setVersion((value) => value + 1);
  };
  const prefix = courseId ? 'course' : 'institution';
  return (
    <div className="space-y-6">
      {canManage ? <EventForm prefix={prefix} target={target} onSaved={reload} /> : staff ? <Alert tone="info">{c.manage.readOnly}</Alert> : null}
      <Card as="section" aria-labelledby={`${prefix}-calendar-heading`} className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id={`${prefix}-calendar-heading`} className="font-semibold text-brand-600">
            {courseId ? c.courseTitle : c.institutionTitle}
          </h2>
          <WindowControls start={start} setStart={setStart} />
        </div>
        {state.status === 'loading' ? (
          <p className="text-sm text-slate-600">{c.loading}</p>
        ) : state.status !== 'ready' ? (
          <Alert tone="error">{state.status === 'error' ? state.message : t.common.loadError}</Alert>
        ) : (
          <>
            <p className="text-xs text-slate-500">{c.timeZoneNote(state.data.timeZone)}</p>
            <Agenda
              events={state.data.events}
              dueDates={state.data.dueDates}
              zone={state.data.timeZone}
              showCourse={false}
              renderActions={canManage ? (event) => <EventActions prefix={prefix} target={target} event={event} onChanged={reload} /> : undefined}
            />
          </>
        )}
      </Card>
      {courseId ? <SessionPlan courseId={courseId} version={version} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Staff: create, edit, publish or hide, cancel, delete

const inputOf = (event: CalendarEvent, status: 'hidden' | 'published'): CalendarEventInput =>
  event.allDay && event.startDate && event.endDate
    ? { title: event.title, description: event.description, allDay: true, startDate: event.startDate, endDate: event.endDate, timeZone: event.timeZone, status }
    : { title: event.title, description: event.description, allDay: false, startsAt: event.startsAt, endsAt: event.endsAt, timeZone: event.timeZone, status };

type EventMode = 'idle' | 'edit' | 'cancel' | 'delete';

function EventActions({ prefix, target, event, onChanged }: { prefix: string; target: EventTarget; event: CalendarEvent; onChanged: () => void }) {
  const { t } = useLocale();
  const m = t.communications.calendar.manage;
  const { run, pending, result, clearResult } = useCsrfAction();
  const [mode, setMode] = useState<EventMode>('idle');
  const open = (next: EventMode) => {
    clearResult();
    setMode(next);
  };
  const act = async <T,>(action: (csrf: string) => Promise<T>, message: string) => {
    const done = await run(action, () => message);
    if (done !== null) {
      setMode('idle');
      onChanged();
    }
  };
  if (event.status === 'cancelled') return null;
  return (
    <div className="mt-2 space-y-2" data-event-actions={event.title}>
      {mode === 'edit' ? <EventForm prefix={`${prefix}-edit-${event.id}`} target={target} event={event} onSaved={() => {
            setMode('idle');
            onChanged();
          }} onClose={() => setMode('idle')} /> : null}
      {mode === 'cancel' || mode === 'delete' ? (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-900">{mode === 'cancel' ? m.cancelConfirm : m.deleteConfirm}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                void (mode === 'cancel' ? act((csrf) => api.cancelEvent(event.id, csrf), m.cancelledDone) : act((csrf) => api.deleteEvent(event.id, csrf), m.deleted))
              }
            >
              {mode === 'cancel' ? m.cancelEvent : m.delete}
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => setMode('idle')}>
              {m.keep}
            </Button>
          </div>
        </div>
      ) : null}
      {mode === 'idle' ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => open('edit')}>
            {m.edit}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => void act((csrf) => api.updateEvent(event.id, inputOf(event, event.status === 'published' ? 'hidden' : 'published'), csrf), m.saved)}
          >
            {event.status === 'published' ? m.hide : m.publish}
          </Button>
          {event.publishedAt ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => open('cancel')}>
              {m.cancelEvent}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => open('delete')}>
              {m.delete}
            </Button>
          )}
        </div>
      ) : null}
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
    </div>
  );
}

/** Create (no `event`) or edit an event. Times are wall-clock values in the chosen zone, sent with explicit offsets. */
function EventForm({ prefix, target, event, onSaved, onClose }: { prefix: string; target: EventTarget; event?: CalendarEvent; onSaved: () => void; onClose?: () => void }) {
  const { t } = useLocale();
  const m = t.communications.calendar.manage;
  const { run, pending, result } = useCsrfAction();
  const initialZone = event?.timeZone ?? DEFAULT_TIME_ZONE;
  const startWall = event && !event.allDay ? instantToWall(event.startsAt, initialZone) : null;
  const endWall = event && !event.allDay ? instantToWall(event.endsAt, initialZone) : null;
  const defaultDate = addDays(todayIn(DEFAULT_TIME_ZONE), 1);
  const [title, setTitle] = useState(event?.title ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [startDate, setStartDate] = useState(event?.startDate ?? startWall?.date ?? defaultDate);
  const [startTime, setStartTime] = useState(startWall?.time ?? '19:00');
  const [endDate, setEndDate] = useState(event?.endDate ?? endWall?.date ?? defaultDate);
  const [endTime, setEndTime] = useState(endWall?.time ?? '20:00');
  const [zone, setZone] = useState(initialZone);
  const [status, setStatus] = useState<'hidden' | 'published'>(event?.status === 'published' ? 'published' : 'hidden');
  const [error, setError] = useState<string | null>(null);
  const zones = TIME_ZONES.includes(zone) ? TIME_ZONES : [zone, ...TIME_ZONES];
  // AP-045: optional teaching session details (course events only).
  const sf = t.communications.calendar.session.form;
  const sessionModes = t.communications.calendar.session.modes;
  const courseId = target.kind === 'course' ? target.courseId : null;
  const [isSession, setIsSession] = useState(Boolean(event?.session));
  const [sessionNumber, setSessionNumber] = useState(event?.session ? String(event.session.number) : '');
  const [mode, setMode] = useState<TeachingSessionMode>(event?.session?.deliveryMode ?? 'live_online');
  const [joinUrl, setJoinUrl] = useState(event?.session?.joinUrl ?? '');
  const [unitIds, setUnitIds] = useState<string[]>(event?.session?.units.map((unit) => unit.id) ?? []);
  const [activityId, setActivityId] = useState(event?.session?.activity?.id ?? '');
  const options = useSessionOptions(courseId, isSession);
  const sessionField = (): CalendarEventInput['session'] | 'invalid-number' | 'invalid-url' | undefined => {
    if (!courseId) return undefined;
    if (!isSession) return event?.session ? null : undefined;
    const number = Number(sessionNumber.trim());
    if (!/^\d+$/.test(sessionNumber.trim()) || number < 1 || number > 999) return 'invalid-number';
    const link = mode === 'asynchronous' ? '' : joinUrl.trim();
    if (link) {
      try {
        if (new URL(link).protocol !== 'https:') return 'invalid-url';
      } catch {
        return 'invalid-url';
      }
    }
    return { number, deliveryMode: mode, joinUrl: link || null, unitIds, activityId: activityId || null };
  };

  const submit = async () => {
    if (!title.trim()) return setError(m.titleRequired);
    if (!startDate || !endDate || (!allDay && (!startTime || !endTime))) return setError(m.datesRequired);
    const session = sessionField();
    if (session === 'invalid-number') return setError(sf.numberRange);
    if (session === 'invalid-url') return setError(sf.joinUrlInvalid);
    let body: CalendarEventInput;
    if (allDay) {
      if (endDate < startDate) return setError(m.endBeforeStart);
      body = { title: title.trim(), description: description.trim() || null, allDay: true, startDate, endDate, timeZone: zone, status };
    } else {
      const startsAt = wallTimeToInstant(startDate, startTime, zone);
      const endsAt = wallTimeToInstant(endDate, endTime, zone);
      if (Date.parse(endsAt) <= Date.parse(startsAt)) return setError(m.endBeforeStart);
      body = { title: title.trim(), description: description.trim() || null, allDay: false, startsAt, endsAt, timeZone: zone, status };
    }
    if (session !== undefined) body = { ...body, session };
    setError(null);
    const saved = await run(
      (csrf) =>
        event
          ? api.updateEvent(event.id, body, csrf)
          : target.kind === 'course'
            ? api.createCourseEvent(target.courseId, body, csrf)
            : api.createInstitutionEvent(body, csrf),
      () => (event ? m.saved : m.created),
    );
    if (saved && !event) {
      setTitle('');
      setDescription('');
      // Ready for the next session: the following number, same mode and link, no units or activity.
      if (session) {
        setSessionNumber(String(Math.min(session.number + 1, 999)));
        setUnitIds([]);
        setActivityId('');
      }
    }
    if (saved) onSaved();
  };

  const form = (
    <form
      className="space-y-3"
      data-event-form={event ? 'edit' : 'create'}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField id={`${prefix}-event-title`} label={m.title} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      <div>
        <label htmlFor={`${prefix}-event-description`} className="block text-sm font-medium text-slate-800">
          {m.description}
        </label>
        <textarea id={`${prefix}-event-description`} rows={3} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} className={textareaClasses} />
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-800">
        <input id={`${prefix}-event-all-day`} type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        {m.allDay}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id={`${prefix}-event-start-date`} type="date" label={m.startDate} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        {!allDay ? <TextField id={`${prefix}-event-start-time`} type="time" label={m.startTime} value={startTime} onChange={(e) => setStartTime(e.target.value)} /> : <span className="hidden sm:block" />}
        <TextField id={`${prefix}-event-end-date`} type="date" label={m.endDate} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        {!allDay ? <TextField id={`${prefix}-event-end-time`} type="time" label={m.endTime} value={endTime} onChange={(e) => setEndTime(e.target.value)} /> : <span className="hidden sm:block" />}
        <SelectField id={`${prefix}-event-zone`} label={m.timeZone} value={zone} onChange={(e) => setZone(e.target.value)} options={zones.map((z) => ({ value: z, label: z }))} />
        <SelectField
          id={`${prefix}-event-status`}
          label={m.visibility}
          value={status}
          onChange={(e) => setStatus(e.target.value as 'hidden' | 'published')}
          options={[
            { value: 'hidden', label: m.hiddenOption },
            { value: 'published', label: m.publishedOption },
          ]}
        />
      </div>
      {courseId ? (
        <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3" data-session-form>
          <legend className="px-1 text-sm font-semibold text-slate-800">{sf.heading}</legend>
          <label className="flex items-center gap-2 text-sm text-slate-800">
            <input id={`${prefix}-session-toggle`} type="checkbox" checked={isSession} onChange={(e) => setIsSession(e.target.checked)} />
            {sf.toggle}
          </label>
          {isSession ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField id={`${prefix}-session-number`} inputMode="numeric" label={sf.number} maxLength={3} value={sessionNumber} onChange={(e) => setSessionNumber(e.target.value)} />
                <SelectField
                  id={`${prefix}-session-mode`}
                  label={sf.mode}
                  value={mode}
                  onChange={(e) => setMode(e.target.value as TeachingSessionMode)}
                  options={SESSION_MODES.map((value) => ({ value, label: sessionModes[value] }))}
                />
              </div>
              {mode === 'asynchronous' ? (
                <p className="text-sm text-slate-600">{sf.asyncNote}</p>
              ) : (
                <TextField id={`${prefix}-session-join`} inputMode="url" label={sf.joinUrl} hint={sf.joinUrlHint} maxLength={2000} value={joinUrl} onChange={(e) => setJoinUrl(e.target.value)} />
              )}
              {options.status === 'ready' ? (
                <>
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium text-slate-800">{sf.units}</legend>
                    <p className="text-xs text-slate-500">{sf.unitsHint}</p>
                    {options.units.length === 0 ? (
                      <p className="text-sm text-slate-600">{sf.noUnitsAvailable}</p>
                    ) : (
                      <div className="grid gap-1 sm:grid-cols-2">
                        {options.units.map((unit) => (
                          <label key={unit.id} className="flex items-start gap-2 text-sm text-slate-800">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={unitIds.includes(unit.id)}
                              onChange={(e) => setUnitIds((current) => (e.target.checked ? [...current, unit.id] : current.filter((id) => id !== unit.id)))}
                            />
                            <span className="break-words">{unit.title}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </fieldset>
                  <SelectField
                    id={`${prefix}-session-activity`}
                    label={sf.activity}
                    value={activityId}
                    onChange={(e) => setActivityId(e.target.value)}
                    options={[{ value: '', label: sf.activityNone }, ...options.activities.map((activity) => ({ value: activity.id, label: activity.label }))]}
                  />
                </>
              ) : options.status === 'error' ? (
                <Alert tone="error">{sf.loadFailed}</Alert>
              ) : (
                <p className="text-sm text-slate-600">{sf.loading}</p>
              )}
            </>
          ) : null}
        </fieldset>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size={event ? 'sm' : 'md'} disabled={pending}>
          {pending ? m.creating : event ? m.save : m.create}
        </Button>
        {onClose ? (
          <Button size="sm" variant="secondary" disabled={pending} onClick={onClose}>
            {m.cancel}
          </Button>
        ) : null}
      </div>
    </form>
  );
  if (event) return <div className="rounded-lg border border-slate-200 p-3">{form}</div>;
  return (
    <Card as="section" id="new-event" aria-labelledby={`${prefix}-new-event`} className="scroll-mt-20 space-y-3">
      <h2 id={`${prefix}-new-event`} className="font-semibold text-brand-600">
        {m.heading}
      </h2>
      <p className="text-sm text-slate-600">{m.intro}</p>
      {form}
    </Card>
  );
}
