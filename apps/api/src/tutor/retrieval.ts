import { and, asc, desc, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { activities, sections } from '../db/schema/index.js';
import { detectLanguage, excerpt, keyTerms, matchedTerms, splitPassages, TUTOR_LIMITS, type SourceLanguage } from './text.js';

type Executor = Pick<Database, 'select'>;

/**
 * Which approved lessons the caller may read: always one course; students only visible ones, outside
 * sections that are still locked by a prerequisite.
 */
export type TutorScope = { courseId: string; includeHidden: boolean; excludedSectionIds: string[] };

export type TutorSource = {
  activityId: string;
  sectionId: string;
  title: string;
  excerpt: string;
  sourceLanguage: SourceLanguage;
  keyTerms: string[];
};

type LessonRow = { activityId: string; sectionId: string; title: string | null; body: string };

// Accent folding in SQL (both cases, because lower() may not fold non-ASCII under the C collation).
const SQL_ACCENTED = 'áàäâéèëêíìïîóòöôúùüûñçÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛÑÇ';
const SQL_UNACCENTED = 'aaaaeeeeiiiioooouuuuncaaaaeeeeiiiioooouuuunc';

/** Only the approved copy of a lesson is ever read: working copies and other activity types are not. */
const approvedBody = sql<string>`coalesce(${activities.approvedConfig} ->> 'body', '')`;

/**
 * Approved lessons in exactly one course. Only `page` activities with an approved version are
 * considered, and only their approved title and text. Draft, submitted and returned working copies,
 * quizzes (and answer keys), assignments, submissions, grades, review comments and audit entries
 * are stored in other columns or tables and are never read here. Students see visible lessons in
 * visible sections only.
 */
function approvedLessons(scope: TutorScope) {
  return and(
    eq(sections.courseId, scope.courseId),
    eq(activities.type, 'page'),
    isNotNull(activities.approvedConfig),
    isNotNull(activities.approvedTitle),
    isNotNull(activities.approvedAt),
    scope.includeHidden ? undefined : and(eq(sections.isVisible, true), eq(activities.isVisible, true)),
    scope.excludedSectionIds.length ? notInArray(sections.id, scope.excludedSectionIds) : undefined,
  );
}

/** PostgreSQL full-text search (simple dictionary, accent-folded, prefix terms) over approved lessons. */
export async function searchApprovedLessons(db: Executor, scope: TutorScope, terms: string[]): Promise<LessonRow[]> {
  if (!terms.length) return [];
  // Terms contain only [a-z0-9] (see searchTerms), so this tsquery string cannot carry operators.
  const query = terms.map((term) => `${term}:*`).join(' | ');
  const document = sql`to_tsvector('simple', lower(translate(coalesce(${activities.approvedTitle}, '') || ' ' || ${approvedBody}, ${SQL_ACCENTED}, ${SQL_UNACCENTED})))`;
  const tsQuery = sql`to_tsquery('simple', ${query})`;
  const rank = sql<number>`ts_rank(${document}, ${tsQuery})`;
  return db
    .select({ activityId: activities.id, sectionId: activities.sectionId, title: activities.approvedTitle, body: approvedBody })
    .from(activities)
    .innerJoin(sections, eq(sections.id, activities.sectionId))
    .where(and(approvedLessons(scope), sql`${document} @@ ${tsQuery}`))
    .orderBy(desc(rank), asc(sections.position), asc(activities.position), asc(activities.id))
    .limit(TUTOR_LIMITS.candidateLessons);
}

/** The first approved lessons in course order (practice prompts without a topic). */
export async function firstApprovedLessons(db: Executor, scope: TutorScope): Promise<LessonRow[]> {
  return db
    .select({ activityId: activities.id, sectionId: activities.sectionId, title: activities.approvedTitle, body: approvedBody })
    .from(activities)
    .innerJoin(sections, eq(sections.id, activities.sectionId))
    .where(approvedLessons(scope))
    .orderBy(asc(sections.position), asc(activities.position), asc(activities.id))
    .limit(TUTOR_LIMITS.citations);
}

/** Questions with three or more significant terms need at least two of them in the same passage. */
export const minimumMatches = (terms: string[]) => (terms.length <= 2 ? 1 : 2);

function toSource(lesson: LessonRow, passage: string, terms: string[]): TutorSource {
  return {
    activityId: lesson.activityId,
    sectionId: lesson.sectionId,
    title: lesson.title ?? '',
    excerpt: excerpt(passage, terms),
    sourceLanguage: detectLanguage(lesson.body.slice(0, 4000)),
    keyTerms: keyTerms(passage),
  };
}

/**
 * The best passage of each lesson; a lesson qualifies only when that passage itself contains enough
 * of the search terms (title-only matches do not). At most three sources, best first.
 */
export function selectSources(lessons: LessonRow[], terms: string[]): TutorSource[] {
  const needed = minimumMatches(terms);
  const candidates: Array<{ lesson: LessonRow; passage: string; score: number; order: number }> = [];
  lessons.forEach((lesson, order) => {
    let best: { passage: string; score: number } | null = null;
    for (const passage of splitPassages(lesson.body)) {
      const score = matchedTerms(passage, terms);
      if (score > (best?.score ?? 0)) best = { passage, score };
    }
    if (best && best.score >= needed) candidates.push({ lesson, ...best, order });
  });
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates.slice(0, TUTOR_LIMITS.citations).map((c) => toSource(c.lesson, c.passage, terms));
}

/** Opening passage of each lesson (no search terms). */
export function openingSources(lessons: LessonRow[]): TutorSource[] {
  return lessons.flatMap((lesson) => {
    const [first] = splitPassages(lesson.body);
    return first ? [toSource(lesson, first, [])] : [];
  });
}
