/**
 * Hybrid teaching sessions (AP-045): optional details on course calendar events. A session has a number and a
 * delivery mode; it may link an external HTTPS virtual classroom (live or presentation sessions; AcademiaPath does
 * not host meetings), one course activity, and any number of the course's units (sections). Units and sessions
 * are independent. What a viewer sees follows the existing course rules: hidden units and activities students
 * cannot open are left out, and students only get the classroom link of a published session.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { activities, calendarEvents, calendarEventUnits, sections, teachingSessionModeEnum } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';

export type SessionMode = (typeof teachingSessionModeEnum.enumValues)[number];
export type SessionInput = { number: number; deliveryMode: SessionMode; joinUrl?: string | null; unitIds?: string[]; activityId?: string | null };
export type SessionView = {
  number: number;
  deliveryMode: SessionMode;
  joinUrl: string | null;
  units: Array<{ id: string; title: string }>;
  activity: { id: string; title: string; type: string } | null;
};
/** What one viewer may see in one course (derived from their course permissions). */
export type SessionViewer = { hiddenUnits: boolean; unapprovedActivities: boolean; lockedSections: Set<string>; anyJoinUrl: boolean };
/** Course staff and administrators who manage the calendar see everything. */
export const FULL_VIEWER: SessionViewer = { hiddenUnits: true, unapprovedActivities: true, lockedSections: new Set(), anyJoinUrl: true };

type EventRecord = typeof calendarEvents.$inferSelect;
type Reader = Pick<Database, 'select'>;
type Writer = Pick<Database, 'select' | 'insert' | 'delete'>;
export type SessionColumns = Pick<EventRecord, 'sessionNumber' | 'sessionMode' | 'joinUrl' | 'sessionActivityId'>;
export const NO_SESSION: SessionColumns = { sessionNumber: null, sessionMode: null, joinUrl: null, sessionActivityId: null };

const LIVE_MODES: readonly SessionMode[] = ['live_online', 'presentation'];
const joinUrlInvalid = (detail: string) => new ApiProblem(422, 'SESSION_JOIN_URL_INVALID', detail);

/**
 * An external classroom link: an absolute https:// URL with a host name, without embedded credentials or spaces,
 * at most 2,000 characters. Returned normalized (lower-case scheme and host). Empty means no link.
 */
export function checkJoinUrl(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  if (text.length > 2000 || /\s/.test(text)) throw joinUrlInvalid('The classroom link must be a single https:// address of at most 2,000 characters.');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw joinUrlInvalid('The classroom link must be a full https:// address.');
  }
  if (url.protocol !== 'https:' || !url.hostname) throw joinUrlInvalid('The classroom link must use https://.');
  if (url.username || url.password) throw joinUrlInvalid('The classroom link must not contain a user name or password.');
  if (url.href.length > 2000) throw joinUrlInvalid('The classroom link must be at most 2,000 characters.');
  return url.href;
}

/**
 * Validates session details for an event of `courseId`: the link fits the delivery mode, every unit is a section of
 * this course and the activity belongs to it. Unknown and foreign ids get the same answer (nothing about other
 * courses is revealed). Units may be hidden and activities unapproved: staff plan ahead, students see them later.
 */
export async function resolveSession(reader: Reader, courseId: string, input: SessionInput): Promise<{ columns: SessionColumns; unitIds: string[] }> {
  const joinUrl = input.joinUrl ? checkJoinUrl(input.joinUrl) : null;
  if (joinUrl && !LIVE_MODES.includes(input.deliveryMode)) throw joinUrlInvalid('Asynchronous sessions have no live classroom link; link a course activity instead.');
  const unitIds = [...new Set(input.unitIds ?? [])];
  if (unitIds.length) {
    const found = await reader.select({ id: sections.id }).from(sections).where(and(eq(sections.courseId, courseId), inArray(sections.id, unitIds)));
    if (found.length !== unitIds.length) throw new ApiProblem(422, 'SESSION_UNIT_INVALID', 'Every unit must be a unit of this course.');
  }
  const activityId = input.activityId ?? null;
  if (activityId) {
    const [found] = await reader
      .select({ id: activities.id })
      .from(activities)
      .innerJoin(sections, eq(sections.id, activities.sectionId))
      .where(and(eq(activities.id, activityId), eq(sections.courseId, courseId)));
    if (!found) throw new ApiProblem(422, 'SESSION_ACTIVITY_INVALID', 'The activity must belong to this course.');
  }
  return { columns: { sessionNumber: input.number, sessionMode: input.deliveryMode, joinUrl, sessionActivityId: activityId }, unitIds };
}

/** Replaces the units of one course event. */
export async function saveUnits(writer: Writer, eventId: string, courseId: string, unitIds: string[]) {
  await writer.delete(calendarEventUnits).where(eq(calendarEventUnits.eventId, eventId));
  if (unitIds.length) await writer.insert(calendarEventUnits).values(unitIds.map((sectionId) => ({ eventId, courseId, sectionId })));
}

/** The unit ids linked to one event (for audit records). */
export async function unitIdsOf(reader: Reader, eventId: string): Promise<string[]> {
  const rows = await reader.select({ id: calendarEventUnits.sectionId }).from(calendarEventUnits).where(eq(calendarEventUnits.eventId, eventId));
  return rows.map((row) => row.id).sort();
}

/** Session details of the given events as `viewerFor(courseId)` may see them; events without a session map to null. */
export async function sessionViews(reader: Reader, rows: readonly EventRecord[], viewerFor: (courseId: string) => SessionViewer): Promise<Map<string, SessionView | null>> {
  const result = new Map<string, SessionView | null>(rows.map((row) => [row.id, null]));
  const sessions = rows.filter((row) => row.sessionMode && row.sessionNumber && row.courseId);
  if (!sessions.length) return result;
  const units = await reader
    .select({ eventId: calendarEventUnits.eventId, id: sections.id, title: sections.title, visible: sections.isVisible })
    .from(calendarEventUnits)
    .innerJoin(sections, eq(sections.id, calendarEventUnits.sectionId))
    .where(inArray(calendarEventUnits.eventId, sessions.map((row) => row.id)))
    .orderBy(asc(sections.position), asc(sections.id));
  const activityIds = [...new Set(sessions.map((row) => row.sessionActivityId).filter((id): id is string => Boolean(id)))];
  const linked = activityIds.length
    ? await reader
        .select({
          id: activities.id,
          title: activities.title,
          approvedTitle: activities.approvedTitle,
          type: activities.type,
          visible: activities.isVisible,
          sectionId: sections.id,
          sectionVisible: sections.isVisible,
          courseId: sections.courseId,
        })
        .from(activities)
        .innerJoin(sections, eq(sections.id, activities.sectionId))
        .where(inArray(activities.id, activityIds))
    : [];
  const activityById = new Map(linked.map((row) => [row.id, row]));
  for (const row of sessions) {
    const viewer = viewerFor(row.courseId!);
    const activity = row.sessionActivityId ? activityById.get(row.sessionActivityId) : undefined;
    // An activity moved to another course is never shown; students see only approved, visible, unlocked ones.
    const shownActivity =
      activity && activity.courseId === row.courseId
        ? viewer.unapprovedActivities
          ? { id: activity.id, title: activity.approvedTitle ?? activity.title, type: activity.type }
          : activity.approvedTitle && activity.visible && activity.sectionVisible && !viewer.lockedSections.has(activity.sectionId)
            ? { id: activity.id, title: activity.approvedTitle, type: activity.type }
            : null
        : null;
    result.set(row.id, {
      number: row.sessionNumber!,
      deliveryMode: row.sessionMode!,
      joinUrl: viewer.anyJoinUrl || row.status === 'published' ? row.joinUrl : null,
      units: units.filter((unit) => unit.eventId === row.id && (viewer.hiddenUnits || unit.visible)).map((unit) => ({ id: unit.id, title: unit.title })),
      activity: shownActivity,
    });
  }
  return result;
}
