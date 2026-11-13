import { and, asc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { activities, courseDocuments, sections } from '../db/schema/index.js';
import { readDocumentConfig } from '../documents/model.js';
import { approvedLessons, type TutorScope } from './retrieval.js';
import { detectLanguage, type SourceLanguage } from './text.js';

type Executor = Pick<Database, 'select'>;

/** Bounds of what one guided-tutor request reads (far above the demo courses; documented limitation). */
export const MATERIAL_LIMITS = { materials: 100, documentChars: 20_000, quizzes: 20 } as const;

/**
 * One approved learning material the caller may read: a lesson (`page`, its approved text) or a document
 * (`file`, the extracted text of the exact document version that was approved). Never a working copy.
 */
export type Material = {
  activityId: string;
  sectionId: string;
  sectionTitle: string;
  type: 'page' | 'file';
  title: string;
  text: string;
  language: SourceLanguage;
  /** Position in course order (sections, then activities). */
  order: number;
};

/** Facts about an approved quiz that a student may already see before attempting it — never its questions. */
export type QuizInfo = {
  activityId: string;
  sectionId: string;
  sectionTitle: string;
  title: string;
  questionCount: number;
  attemptLimit: number;
  timeLimitMinutes: number | null;
  passingScorePercent: number | null;
};

/**
 * Approved, readable materials of one course in course order: two indexed queries (activities with their
 * sections, then the referenced documents' extracted text). Students only reach visible content outside
 * sections a prerequisite still locks (the same scope as the existing tutor retrieval).
 */
export async function loadMaterials(executor: Executor, scope: TutorScope): Promise<Material[]> {
  const rows = await executor
    .select({
      activityId: activities.id,
      sectionId: activities.sectionId,
      sectionTitle: sections.title,
      type: activities.type,
      title: activities.approvedTitle,
      config: activities.approvedConfig,
    })
    .from(activities)
    .innerJoin(sections, eq(sections.id, activities.sectionId))
    .where(approvedLessons(scope, ['page', 'file']))
    .orderBy(asc(sections.position), asc(sections.id), asc(activities.position), asc(activities.id))
    .limit(MATERIAL_LIMITS.materials);

  const documentIds = rows.flatMap((row) => {
    const reference = row.type === 'file' ? readDocumentConfig(row.config) : null;
    return reference ? [reference.documentId] : [];
  });
  const documents = documentIds.length
    ? await executor
        .select({ id: courseDocuments.id, activityId: courseDocuments.activityId, segments: courseDocuments.segments })
        .from(courseDocuments)
        .where(inArray(courseDocuments.id, documentIds))
    : [];
  const documentText = new Map(
    documents.map((document) => [
      document.id,
      { activityId: document.activityId, text: (document.segments ?? []).map((segment) => segment.text.trim()).filter(Boolean).join('\n\n').slice(0, MATERIAL_LIMITS.documentChars) },
    ]),
  );

  const materials: Material[] = [];
  rows.forEach((row, order) => {
    let text = '';
    if (row.type === 'page') {
      const body = (row.config as { body?: unknown } | null)?.body;
      text = typeof body === 'string' ? body : '';
    } else {
      const reference = readDocumentConfig(row.config);
      const document = reference ? documentText.get(reference.documentId) : undefined;
      // Only the document this activity's approved version points at, and only if it belongs to the activity.
      text = document && document.activityId === row.activityId ? document.text : '';
    }
    if (!text.trim() || !row.title) return; // missing or empty material is skipped, never invented
    materials.push({
      activityId: row.activityId,
      sectionId: row.sectionId,
      sectionTitle: row.sectionTitle,
      type: row.type as Material['type'],
      title: row.title,
      text,
      language: detectLanguage(text.slice(0, 4000)),
      order,
    });
  });
  return materials;
}

/**
 * Approved quizzes the caller may see, with the facts shown on a quiz page (number of questions, attempts, time
 * limit, passing score). Computed in SQL from the approved version, so questions and answer keys never leave the
 * database.
 */
export async function loadQuizzes(executor: Executor, scope: TutorScope): Promise<QuizInfo[]> {
  const config = activities.approvedConfig;
  const rows = await executor
    .select({
      activityId: activities.id,
      sectionId: activities.sectionId,
      sectionTitle: sections.title,
      title: activities.approvedTitle,
      questionCount: sql<number>`coalesce(jsonb_array_length(${config} -> 'questions'), 0)`.mapWith(Number),
      attemptLimit: sql<number | null>`(${config} ->> 'attemptLimit')::int`,
      timeLimitMinutes: sql<number | null>`(${config} ->> 'timeLimitMinutes')::int`,
      passingScorePercent: sql<number | null>`(${config} ->> 'passingScorePercent')::int`,
    })
    .from(activities)
    .innerJoin(sections, eq(sections.id, activities.sectionId))
    .where(
      and(
        eq(sections.courseId, scope.courseId),
        eq(activities.type, 'quiz'),
        isNotNull(config),
        isNotNull(activities.approvedTitle),
        scope.includeHidden ? undefined : and(eq(sections.isVisible, true), eq(activities.isVisible, true)),
        scope.excludedSectionIds.length ? notInArray(sections.id, scope.excludedSectionIds) : undefined,
      ),
    )
    .orderBy(asc(sections.position), asc(sections.id), asc(activities.position), asc(activities.id))
    .limit(MATERIAL_LIMITS.quizzes);
  return rows.map((row) => ({
    activityId: row.activityId,
    sectionId: row.sectionId,
    sectionTitle: row.sectionTitle,
    title: row.title ?? '',
    questionCount: row.questionCount,
    attemptLimit: row.attemptLimit ?? 1,
    timeLimitMinutes: row.timeLimitMinutes ?? null,
    passingScorePercent: row.passingScorePercent ?? null,
  }));
}
