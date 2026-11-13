import { and, asc, eq, inArray } from 'drizzle-orm';
import type { CourseAccess } from '../auth/authorization.js';
import type { Database } from '../db/client.js';
import { activities, courseDocuments, documentSummaries, quizQuestions, sectionPrerequisites, sections } from '../db/schema/index.js';
import { readDocumentConfig } from '../documents/model.js';
import { ApiProblem } from '../http/errors.js';
import { CONTENT_TYPES } from '../routes/activity-schemas.js';
import {
  checkActivity,
  checkStructure,
  internalLinks,
  type ActivityContext,
  type ActivityInput,
  type DocumentInput,
  type QualityFinding,
  type SummaryInput,
} from './rules.js';

type Executor = Pick<Database, 'select'>;

/**
 * Most activities one course report inspects (far above real courses). A larger course gets an explicit
 * QUALITY_REPORT_TOO_LARGE refusal, never a partial report: a partial one could read as "no issues" and its
 * course-level findings (empty sections, prerequisites) would be wrong. Activity reports, and the submit and approve
 * guards that use them, always inspect their one activity in full whatever the course size.
 */
export const QUALITY_ACTIVITY_LIMIT = 1000;

export const reportTooLarge = () =>
  new ApiProblem(
    422,
    'QUALITY_REPORT_TOO_LARGE',
    `This course has more than ${QUALITY_ACTIVITY_LIMIT} activities, too many to check in one course report. Check activities one at a time from their pages; submitting and approving still check each activity in full.`,
  );

export type QualityReport = {
  courseId: string;
  scope: 'course' | 'activity';
  activityId: string | null;
  checkedAt: string;
  summary: { blocking: number; warnings: number; sections: number; activities: number; questions: number };
  /** Authored titles, so findings can be labelled and linked without further requests. */
  sections: Array<{ id: string; title: string; position: number; isVisible: boolean }>;
  activities: Array<{ id: string; sectionId: string; type: ActivityInput['type']; title: string; reviewStatus: ActivityInput['reviewStatus'] }>;
  findings: QualityFinding[];
};

const activityColumns = {
  id: activities.id,
  sectionId: activities.sectionId,
  type: activities.type,
  title: activities.title,
  position: activities.position,
  isVisible: activities.isVisible,
  config: activities.config,
  reviewStatus: activities.reviewStatus,
  approvedAt: activities.approvedAt,
};

/**
 * Builds a quality report from the stored working copies, on demand (nothing is persisted, so a report always
 * reflects the content as it is now). A bounded number of indexed queries whatever the course size: sections,
 * activities, the quiz questions of those quizzes, the referenced documents and summary revisions, the
 * prerequisites — never document text, file bytes or anything outside the course.
 */
export async function buildQualityReport(executor: Executor, access: CourseAccess, now: Date, activityId?: string): Promise<QualityReport> {
  const courseId = access.course.id;
  const scopedToActivity = activityId !== undefined;

  const activityRows = await executor
    .select(activityColumns)
    .from(activities)
    .innerJoin(sections, eq(sections.id, activities.sectionId))
    .where(
      and(
        eq(sections.courseId, courseId),
        inArray(activities.type, CONTENT_TYPES),
        scopedToActivity ? eq(activities.id, activityId) : undefined,
      ),
    )
    .orderBy(asc(sections.position), asc(sections.id), asc(activities.position), asc(activities.id))
    .limit(scopedToActivity ? 1 : QUALITY_ACTIVITY_LIMIT + 1);
  // One row past the limit is enough to know the course is too large: refuse instead of reporting on a part of it.
  if (!scopedToActivity && activityRows.length > QUALITY_ACTIVITY_LIMIT) throw reportTooLarge();
  const inspected: ActivityInput[] = activityRows.map((row) => ({
    id: row.id,
    sectionId: row.sectionId,
    type: row.type as ActivityInput['type'],
    title: row.title,
    position: row.position,
    isVisible: row.isVisible,
    config: row.config,
    reviewStatus: row.reviewStatus,
    hasLiveVersion: row.approvedAt !== null,
  }));

  const sectionRows = await executor
    .select({ id: sections.id, title: sections.title, summary: sections.summary, position: sections.position, isVisible: sections.isVisible })
    .from(sections)
    .where(and(eq(sections.courseId, courseId), scopedToActivity ? inArray(sections.id, inspected.map((a) => a.sectionId)) : undefined))
    .orderBy(asc(sections.position), asc(sections.id));

  const quizIds = inspected.filter((activity) => activity.type === 'quiz').map((activity) => activity.id);
  const questions = quizIds.length
    ? await executor
        .select({
          id: quizQuestions.id,
          activityId: quizQuestions.activityId,
          position: quizQuestions.position,
          type: quizQuestions.type,
          prompt: quizQuestions.prompt,
          options: quizQuestions.options,
          correctAnswer: quizQuestions.correctAnswer,
          points: quizQuestions.points,
        })
        .from(quizQuestions)
        .where(inArray(quizQuestions.activityId, quizIds))
    : [];

  const references = inspected.flatMap((activity) => (activity.type === 'file' ? [readDocumentConfig(activity.config)] : [])).filter((ref) => ref !== null);
  const documentIds = [...new Set(references.map((ref) => ref.documentId))].filter(isUuid);
  const summaryIds = [...new Set(references.map((ref) => ref.summaryId))].filter(isUuid);
  const documents = documentIds.length
    ? await executor
        .select({ id: courseDocuments.id, activityId: courseDocuments.activityId, extractionStatus: courseDocuments.extractionStatus, truncated: courseDocuments.truncated })
        .from(courseDocuments)
        .where(inArray(courseDocuments.id, documentIds))
    : [];
  const summaries = summaryIds.length
    ? await executor
        .select({ id: documentSummaries.id, documentId: documentSummaries.documentId, revision: documentSummaries.revision })
        .from(documentSummaries)
        .where(inArray(documentSummaries.id, summaryIds))
    : [];

  // In-app links are checked against the course's activities: the loaded set for a course report, otherwise a
  // single lookup of just the ids the activity's texts mention.
  let courseActivityIds: Set<string>;
  if (!scopedToActivity) {
    courseActivityIds = new Set(inspected.map((activity) => activity.id));
  } else {
    const mentioned = [...new Set(inspected.flatMap((activity) => linkedTexts(activity).flatMap((text) => internalLinks(text).map((link) => link.activityId))))];
    const found = mentioned.length
      ? await executor
          .select({ id: activities.id })
          .from(activities)
          .innerJoin(sections, eq(sections.id, activities.sectionId))
          .where(and(eq(sections.courseId, courseId), inArray(activities.id, mentioned)))
      : [];
    courseActivityIds = new Set(found.map((row) => row.id));
  }

  const context: ActivityContext = {
    questions,
    documents: new Map<string, DocumentInput>(documents.map((row) => [row.id, row])),
    summaries: new Map<string, SummaryInput>(summaries.map((row) => [row.id, row])),
    courseActivityIds,
    courseId,
    now,
  };
  const findings = inspected.flatMap((activity) => checkActivity(activity, context));
  if (!scopedToActivity) {
    const prerequisites = await executor
      .select({ sectionId: sectionPrerequisites.sectionId, requiredSectionId: sectionPrerequisites.requiredSectionId })
      .from(sectionPrerequisites)
      .where(eq(sectionPrerequisites.courseId, courseId));
    findings.unshift(
      ...checkStructure(
        { id: courseId, title: access.course.title, description: access.course.description, status: access.course.status },
        sectionRows,
        inspected,
        prerequisites,
      ),
    );
  }
  // Blocking first; otherwise course, then sections and activities in course order (already the emit order).
  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocking' ? -1 : 1));

  return {
    courseId,
    scope: scopedToActivity ? 'activity' : 'course',
    activityId: activityId ?? null,
    checkedAt: now.toISOString(),
    summary: {
      blocking: findings.filter((finding) => finding.severity === 'blocking').length,
      warnings: findings.filter((finding) => finding.severity === 'warning').length,
      sections: sectionRows.length,
      activities: inspected.length,
      questions: questions.length,
    },
    sections: sectionRows.map(({ id, title, position, isVisible }) => ({ id, title, position, isVisible })),
    activities: inspected.map(({ id, sectionId, type, title, reviewStatus }) => ({ id, sectionId, type, title, reviewStatus })),
    findings,
  };
}

/** Texts of an activity that may contain in-app links. */
function linkedTexts(activity: ActivityInput): string[] {
  const config = activity.config as Record<string, unknown>;
  return [config.body, config.description, config.instructions].filter((value): value is string => typeof value === 'string');
}

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Blocking findings of one activity, for the submit and approve guards. */
export async function blockingFindings(executor: Executor, access: CourseAccess, now: Date, activityId: string): Promise<QualityFinding[]> {
  const report = await buildQualityReport(executor, access, now, activityId);
  return report.findings.filter((finding) => finding.severity === 'blocking');
}
