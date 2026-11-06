import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { canInCourse, type CourseAccess } from '../auth/authorization.js';
import type { Database } from '../db/client.js';
import { activities, activityCompletions, sectionPrerequisites, sections } from '../db/schema/index.js';
import { ApiProblem } from '../http/errors.js';

type Executor = Pick<Database, 'select'>;

/**
 * Activities that count towards progress. Reading activities are completed by the student's own mark;
 * quizzes and assignments are completed by the server-written records of a submission.
 */
export const READING_TYPES = ['page', 'link', 'file'] as const;
export const TRACKED_TYPES = [...READING_TYPES, 'quiz', 'assignment'] as const;
export type TrackedType = (typeof TRACKED_TYPES)[number];

export const isReadingType = (type: string): boolean => (READING_TYPES as readonly string[]).includes(type);

/**
 * Eligibility (the denominator), shared by every progress figure: approved activities of a tracked type
 * that students can see: visible, in a visible section of this course. Draft-only content, hidden
 * activities, hidden sections and unsupported types (SCORM, LTI) never count. Activities in sections that
 * are locked by a prerequisite still count, so a course total does not change as sections unlock.
 */
export const eligibleActivity = (courseId: string) =>
  and(
    eq(sections.courseId, courseId),
    eq(sections.isVisible, true),
    eq(activities.isVisible, true),
    isNotNull(activities.approvedConfig),
    inArray(activities.type, [...TRACKED_TYPES]),
  );

/**
 * When the student completed an activity, or null. Correlated subqueries name the outer table
 * explicitly. Quiz: the first submitted attempt (passing is not required; scores are never read).
 * Assignment: the final submission. Reading: the student's own mark.
 */
export const completedAtSql = (userIdColumn: ReturnType<typeof sql>) =>
  sql`CASE "activities"."type"
    WHEN 'quiz' THEN (SELECT min(qa.submitted_at) FROM quiz_attempts qa WHERE qa.activity_id = "activities"."id" AND qa.user_id = ${userIdColumn} AND qa.status = 'submitted')
    WHEN 'assignment' THEN (SELECT sub.submitted_at FROM assignment_submissions sub WHERE sub.activity_id = "activities"."id" AND sub.user_id = ${userIdColumn})
    WHEN 'page' THEN (SELECT ac.completed_at FROM activity_completions ac WHERE ac.activity_id = "activities"."id" AND ac.user_id = ${userIdColumn})
    WHEN 'link' THEN (SELECT ac.completed_at FROM activity_completions ac WHERE ac.activity_id = "activities"."id" AND ac.user_id = ${userIdColumn})
    WHEN 'file' THEN (SELECT ac.completed_at FROM activity_completions ac WHERE ac.activity_id = "activities"."id" AND ac.user_id = ${userIdColumn})
  END`;

export type ProgressState = 'no_activities' | 'not_started' | 'in_progress' | 'completed';

/** Counts and the server-calculated percentage (rounded down, so 100 means everything is done). */
export type ProgressSummary = { completedCount: number; totalCount: number; percent: number | null; state: ProgressState };

export function summarize(completedCount: number, totalCount: number): ProgressSummary {
  if (totalCount === 0) return { completedCount: 0, totalCount: 0, percent: null, state: 'no_activities' };
  const state: ProgressState = completedCount === 0 ? 'not_started' : completedCount >= totalCount ? 'completed' : 'in_progress';
  return { completedCount, totalCount, percent: Math.floor((completedCount * 100) / totalCount), state };
}

export type LearnerActivity = {
  activityId: string;
  sectionId: string;
  type: TrackedType;
  title: string;
  completedAt: Date | null;
};

type VisibleSection = { id: string; title: string; position: number };

export type LearnerSection = VisibleSection & {
  summary: ProgressSummary;
  locked: boolean;
  /** Visible sections this one requires (hidden requirements are ignored and never named). */
  requiredSections: Array<{ sectionId: string; title: string; completed: boolean }>;
  activities: LearnerActivity[];
};

export type LearnerProgress = {
  summary: ProgressSummary;
  sections: LearnerSection[];
  /** First incomplete activity in an open section, in course order. */
  continueAt: { sectionId: string; activityId: string; type: TrackedType; title: string } | null;
};

async function visibleSections(executor: Executor, courseId: string): Promise<VisibleSection[]> {
  return executor
    .select({ id: sections.id, title: sections.title, position: sections.position })
    .from(sections)
    .where(and(eq(sections.courseId, courseId), eq(sections.isVisible, true)))
    .orderBy(asc(sections.position), asc(sections.id));
}

async function learnerActivities(executor: Executor, courseId: string, userId: string): Promise<LearnerActivity[]> {
  const rows = await executor
    .select({
      activityId: activities.id,
      sectionId: activities.sectionId,
      type: activities.type,
      title: activities.approvedTitle,
      completedAt: completedAtSql(sql`${userId}::uuid`).mapWith(activityCompletions.completedAt),
    })
    .from(activities)
    .innerJoin(sections, eq(sections.id, activities.sectionId))
    .where(eligibleActivity(courseId))
    .orderBy(asc(sections.position), asc(sections.id), asc(activities.position), asc(activities.id));
  return rows.map((row) => ({ ...row, type: row.type as TrackedType, title: row.title ?? '', completedAt: row.completedAt ?? null }));
}

async function coursePrerequisites(executor: Executor, courseId: string) {
  return executor
    .select({ sectionId: sectionPrerequisites.sectionId, requiredSectionId: sectionPrerequisites.requiredSectionId })
    .from(sectionPrerequisites)
    .where(eq(sectionPrerequisites.courseId, courseId));
}

/**
 * The student's progress in one course, computed from stored records on every request. A section is
 * complete when all of its eligible activities are (a section without eligible activities counts as
 * complete). A section is locked while any visible section it requires is incomplete.
 */
export async function learnerProgress(executor: Executor, courseId: string, userId: string): Promise<LearnerProgress> {
  // Sequential: a transaction is one connection (callers use a repeatable-read snapshot).
  const sectionRows = await visibleSections(executor, courseId);
  const activityRows = await learnerActivities(executor, courseId, userId);
  const prerequisiteRows = await coursePrerequisites(executor, courseId);
  const bySection = new Map<string, LearnerActivity[]>(sectionRows.map((section) => [section.id, []]));
  for (const activity of activityRows) bySection.get(activity.sectionId)?.push(activity);
  const sectionDone = (sectionId: string) => (bySection.get(sectionId) ?? []).every((activity) => activity.completedAt !== null);
  const titles = new Map(sectionRows.map((section) => [section.id, section.title]));

  const learnerSections: LearnerSection[] = sectionRows.map((section) => {
    const items = bySection.get(section.id) ?? [];
    const requiredSections = prerequisiteRows
      .filter((row) => row.sectionId === section.id && titles.has(row.requiredSectionId))
      .map((row) => ({ sectionId: row.requiredSectionId, title: titles.get(row.requiredSectionId)!, completed: sectionDone(row.requiredSectionId) }))
      .sort((a, b) => sectionRows.findIndex((s) => s.id === a.sectionId) - sectionRows.findIndex((s) => s.id === b.sectionId));
    return {
      ...section,
      summary: summarize(items.filter((activity) => activity.completedAt !== null).length, items.length),
      locked: requiredSections.some((required) => !required.completed),
      requiredSections,
      activities: items,
    };
  });

  const next = learnerSections.filter((section) => !section.locked).flatMap((section) => section.activities).find((activity) => activity.completedAt === null);
  return {
    summary: summarize(activityRows.filter((activity) => activity.completedAt !== null).length, activityRows.length),
    sections: learnerSections,
    continueAt: next ? { sectionId: next.sectionId, activityId: next.activityId, type: next.type, title: next.title } : null,
  };
}

/** Sections the student may not open yet. Courses without prerequisites cost one indexed lookup. */
export async function lockedSectionIds(executor: Executor, courseId: string, userId: string): Promise<Set<string>> {
  const [any] = await executor
    .select({ id: sectionPrerequisites.id })
    .from(sectionPrerequisites)
    .where(eq(sectionPrerequisites.courseId, courseId))
    .limit(1);
  if (!any) return new Set();
  const progress = await learnerProgress(executor, courseId, userId);
  return new Set(progress.sections.filter((section) => section.locked).map((section) => section.id));
}

export const sectionLocked = () =>
  new ApiProblem(403, 'SECTION_LOCKED', 'This section opens after you complete the sections it requires.');

/**
 * Server-side prerequisite enforcement for every student content route. Staff and administrators
 * (who may see unapproved content) are never locked out.
 */
export async function assertSectionOpen(executor: Executor, access: CourseAccess, sectionId: string): Promise<void> {
  if (canInCourse(access, 'content.viewUnapproved')) return;
  if ((await lockedSectionIds(executor, access.course.id, access.userId)).has(sectionId)) throw sectionLocked();
}

/** Locked sections for a caller (always empty for staff and administrators). */
export async function lockedSectionsFor(executor: Executor, access: CourseAccess): Promise<Set<string>> {
  if (canInCourse(access, 'content.viewUnapproved')) return new Set();
  return lockedSectionIds(executor, access.course.id, access.userId);
}

/** True if adding `edges` (section → required section) would create a cycle. */
export function hasCycle(edges: Array<{ sectionId: string; requiredSectionId: string }>): boolean {
  const next = new Map<string, string[]>();
  for (const edge of edges) next.set(edge.sectionId, [...(next.get(edge.sectionId) ?? []), edge.requiredSectionId]);
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (node: string): boolean => {
    const current = state.get(node);
    if (current === 'visiting') return true;
    if (current === 'done') return false;
    state.set(node, 'visiting');
    for (const required of next.get(node) ?? []) if (visit(required)) return true;
    state.set(node, 'done');
    return false;
  };
  return [...next.keys()].some(visit);
}
