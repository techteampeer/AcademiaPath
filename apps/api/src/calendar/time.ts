/**
 * Time handling for the academic calendar (AP-025). Nothing is ever interpreted in the server machine's own
 * time zone:
 * - timed events are sent as RFC 3339 instants with an explicit offset (or Z) and stored in UTC, together with
 *   the IANA time zone they are shown in;
 * - all-day events are calendar dates (YYYY-MM-DD, end inclusive) in an IANA time zone; their stored instants
 *   are the midnights that start the first day and end the last day in that zone.
 */
import { isValidTimeZone } from '../config.js';

export { isValidTimeZone };

/** RFC 3339 date-time with a mandatory offset: an instant, never a "floating" local time. */
export const INSTANT_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,3})?)?(Z|[+-]\\d{2}:\\d{2})$';
export const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

/** Whether a YYYY-MM-DD string is a real calendar date between 2000 and 2100. */
export function isCalendarDate(value: string): boolean {
  if (!new RegExp(DATE_PATTERN).test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && year <= 2100 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Offset (ms) of `timeZone` from UTC at `instant`, read from the platform's IANA database. */
function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant at which `date` (YYYY-MM-DD) begins in `timeZone` (handles offsets and DST changes). */
export function startOfDay(date: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, day);
  let instant = guess - offsetMs(guess, timeZone);
  const corrected = guess - offsetMs(instant, timeZone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

/** The next calendar day of a YYYY-MM-DD date. */
export function nextDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/** The calendar date of an instant in a time zone (YYYY-MM-DD). */
export function dateIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}
