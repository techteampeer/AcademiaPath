'use client';

import { useLocale } from '@/components/i18n/LocaleProvider';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import type { Announcement, AnnouncementStatus, CalendarEvent } from '@/lib/api/types';
import type { Locale } from '@/lib/i18n/messages';

/**
 * Display helpers for announcements and calendar events (AP-025). Every date shown here names its time zone
 * explicitly; nothing is interpreted in the browser's own zone. The API validates every value again.
 */

/** The documented institutional default (the API's INSTITUTION_TIME_ZONE); used before the API reports it. */
export const DEFAULT_TIME_ZONE = 'America/Lima';
export const TIME_ZONES = ['America/Lima', 'America/Bogota', 'America/Santiago', 'America/Mexico_City', 'America/New_York', 'Europe/Madrid', 'UTC'];
const DAY = 86_400_000;

const intlLocale = (locale: Locale) => (locale === 'es' ? 'es-PE' : 'en-US');

function zoneParts(instant: Date, zone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Minutes the zone is ahead of UTC at that instant (Lima: -300). */
function offsetMinutes(instant: Date, zone: string): number {
  const p = zoneParts(instant, zone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime()) / 60_000);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A wall-clock date and time in a zone as an RFC 3339 instant with that zone's explicit offset. */
export function wallTimeToInstant(date: string, time: string, zone: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  let offset = offsetMinutes(new Date(guess), zone);
  offset = offsetMinutes(new Date(guess - offset * 60_000), zone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${date}T${pad(hh ?? 0)}:${pad(mm ?? 0)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The calendar date and wall-clock time of an instant in a zone (to prefill forms). */
export function instantToWall(iso: string, zone: string): { date: string; time: string } {
  const p = zoneParts(new Date(iso), zone);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

export const dateInZone = (iso: string, zone: string) => instantToWall(iso, zone).date;
export const todayIn = (zone: string) => dateInZone(new Date().toISOString(), zone);
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** A plain calendar date (YYYY-MM-DD), the same in every browser zone. */
export function formatPlainDate(date: string, locale: Locale, weekday = false): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(intlLocale(locale), {
    timeZone: 'UTC',
    ...(weekday ? { weekday: 'long' } : {}),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Date and time of an instant in a named zone, followed by the zone. */
export function formatInZone(iso: string, zone: string, locale: Locale): string {
  const text = new Date(iso).toLocaleString(intlLocale(locale), { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' });
  return `${text} (${zone})`;
}

export function formatTimeInZone(iso: string, zone: string, locale: Locale): string {
  return new Date(iso).toLocaleTimeString(intlLocale(locale), { timeZone: zone, hour: '2-digit', minute: '2-digit' });
}

/** When an event happens: all-day dates, or start–end in the event's own zone (named). */
export function formatEventWhen(event: CalendarEvent, locale: Locale, allDayLabel: string): string {
  if (event.allDay && event.startDate && event.endDate) {
    const start = formatPlainDate(event.startDate, locale);
    return event.startDate === event.endDate ? `${start} · ${allDayLabel}` : `${start} – ${formatPlainDate(event.endDate, locale)} · ${allDayLabel}`;
  }
  const format = new Intl.DateTimeFormat(intlLocale(locale), { timeZone: event.timeZone, dateStyle: 'medium', timeStyle: 'short' });
  return `${format.formatRange(new Date(event.startsAt), new Date(event.endsAt))} (${event.timeZone})`;
}

/** The agenda day an event belongs to: its first date (all-day) or its start date in the display zone. */
export const eventDay = (event: CalendarEvent, zone: string) => (event.allDay && event.startDate ? event.startDate : dateInZone(event.startsAt, zone));

const STATUS_TONES: Record<AnnouncementStatus, BadgeTone> = { draft: 'neutral', scheduled: 'warning', published: 'success', archived: 'neutral' };

export function AnnouncementStatusBadge({ status }: { status: AnnouncementStatus }) {
  const { t } = useLocale();
  return (
    <span data-announcement-status={status}>
      <Badge tone={STATUS_TONES[status]}>{t.communications.announcements.status[status]}</Badge>
    </span>
  );
}

const EVENT_TONES: Record<CalendarEvent['status'], BadgeTone> = { hidden: 'neutral', published: 'success', cancelled: 'warning' };

export function EventStatusBadge({ status }: { status: CalendarEvent['status'] }) {
  const { t } = useLocale();
  return (
    <span data-event-status={status}>
      <Badge tone={EVENT_TONES[status]}>{t.communications.calendar.status[status]}</Badge>
    </span>
  );
}

/** User-written text, always rendered as plain text (React escapes it); line breaks are kept. */
export function PlainText({ text, className }: { text: string; className?: string }) {
  return <p className={`break-words whitespace-pre-wrap ${className ?? ''}`}>{text}</p>;
}

/** A one-line description of where an announcement or event comes from. */
export function SourceLabel({ item }: { item: Pick<Announcement, 'scope' | 'course'> }) {
  const { t } = useLocale();
  return <span className="text-xs font-medium text-slate-500">{item.scope === 'institution' ? t.communications.announcements.institution : item.course?.code}</span>;
}

/** When an announcement became (or becomes) visible, in the institution's zone. */
export function announcementDate(item: Announcement, locale: Locale, zone = DEFAULT_TIME_ZONE): string {
  return formatInZone(item.publishAt ?? item.createdAt, zone, locale);
}
