/**
 * AP-038A course portability, export side: a versioned, self-describing JSON package of one course's reusable
 * content (format documented in docs/course-package-format.md and in the OpenAPI contract, `CoursePackage`).
 *
 * The package holds content and structure only: units (sections) in order with their prerequisites and resource
 * folders, and every activity with its working copy and, when approved, the approved version students see, plus
 * quiz questions with answer keys and assignment rubrics. It never holds people or their work (enrollments,
 * attempts, submissions, grades, completions, messages), credentials, audit records, database identifiers or
 * institution-specific placements (program, term, template). Documents are listed as asset references (name,
 * format, size, SHA-256): their bytes are not bundled yet.
 *
 * Every row is read with a filter on this course, so nothing from another course can appear; references that do not
 * resolve inside the course are dropped and reported as warnings instead. Identifiers are package-local keys
 * assigned in course order (`unit-1`, `activity-3`, `q2`, `o1`…), so the same content always produces the same
 * package (apart from `exportedAt`) and an import can map each key to a newly created row.
 */
import { createHash } from 'node:crypto';
import { asc, count, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  activities,
  courseDocuments,
  courses,
  quizQuestions,
  resourceFolders,
  sectionPrerequisites,
  sections,
  type ActivityConfig,
  type QuizAnswer,
  type QuizOption,
  type QuizQuestionType,
} from '../db/schema/index.js';
import { readAssignment } from '../assignments/model.js';
import { RESOURCE_KINDS, type ResourceKind } from '../content/urls.js';
import { readDocumentConfig } from '../documents/model.js';
import type { DocumentStorage } from '../documents/storage.js';
import { ApiProblem } from '../http/errors.js';
import { readSettings, readSnapshotQuestions } from '../quizzes/model.js';

export const PACKAGE_FORMAT = 'academiapath.course-package';
/** Bumped only for changes an older reader could misread; additive fields keep the version. */
export const PACKAGE_FORMAT_VERSION = 1;
/** Most activities one package holds (the same ceiling as the course quality report). */
export const EXPORT_ACTIVITY_LIMIT = 1000;
/** Largest serialized package (UTF-8 bytes). */
export const EXPORT_MAX_BYTES = 20 * 1024 * 1024;

/** Categories of data a package never contains (also stated in the package itself). */
export const EXCLUDED_DATA = [
  'people',
  'enrollments',
  'student_work',
  'grades',
  'progress',
  'communications',
  'calendar',
  'certificates',
  'grading_policy',
  'credentials',
  'audit_log',
  'review_comments',
  'database_identifiers',
  'institution_placement',
  'document_text',
  'file_bytes',
] as const;

type Executor = Pick<Database, 'select'>;
type ActivityRow = typeof activities.$inferSelect;

export type PackageWarning = { code: 'ASSET_NOT_BUNDLED' | 'ASSET_MISSING' | 'INVALID_REFERENCE' | 'UNSUPPORTED_ACTIVITY_TYPE'; target: string; detail: string };
export type PackageQuestion = { key: string; type: QuizQuestionType; prompt: string; points: number; options: Array<{ key: string; text: string }>; correctOptionKeys: string[] };
export type PackageContent =
  | { body: string }
  | { url: string; description: string | null; kind: ResourceKind }
  | {
      instructions: string | null;
      attemptLimit: number;
      timeLimitMinutes: number | null;
      shuffleQuestions: boolean;
      shuffleOptions: boolean;
      passingScorePercent: number | null;
      showFeedback: boolean;
      questionsPerAttempt: number | null;
      questions: PackageQuestion[];
    }
  | { instructions: string; dueAt: string; lateUntil: string | null; rubric: Array<{ key: string; title: string; description: string | null; maxPoints: number }> }
  | { assetKey: string | null; fileName: string; format: string }
  | null;
export type PackageVersion = { title: string; content: PackageContent };
export type PackageActivity = {
  key: string;
  type: ActivityRow['type'];
  position: number;
  visible: boolean;
  folderKey: string | null;
  reviewStatus: ActivityRow['reviewStatus'];
  working: PackageVersion;
  approved: PackageVersion | null;
};
export type PackageUnit = {
  key: string;
  title: string;
  summary: string | null;
  position: number;
  visible: boolean;
  requiresUnitKeys: string[];
  folders: Array<{ key: string; title: string; position: number }>;
  activities: PackageActivity[];
};
export type PackageAsset = { key: string; kind: 'document'; fileName: string; format: string; byteSize: number; sha256: string; bundled: false };
export type CoursePackage = {
  format: typeof PACKAGE_FORMAT;
  formatVersion: number;
  exportedAt: string;
  contentHash: string;
  source: { courseCode: string; courseStatus: string };
  course: { title: string; description: string | null; units: PackageUnit[] };
  assets: PackageAsset[];
  warnings: PackageWarning[];
  excludedData: readonly string[];
  counts: { units: number; folders: number; activities: number; approvedActivities: number; questions: number; assets: number };
};

export const exportTooLarge = (detail: string) => new ApiProblem(422, 'COURSE_EXPORT_TOO_LARGE', detail);

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const asText = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const asNullableText = (value: unknown): string | null => (typeof value === 'string' && value.length ? value : null);

/**
 * Builds the package of one course. Reads only (nothing is written); the caller checks permissions. Throws
 * COURSE_EXPORT_TOO_LARGE above the activity limit (before loading content) or the size limit.
 */
export async function buildCoursePackage(db: Executor, courseId: string, storage: Pick<DocumentStorage, 'exists'>, now: Date): Promise<CoursePackage> {
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) throw new ApiProblem(404, 'NOT_FOUND', 'Course not found.');

  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(activities)
    .innerJoin(sections, eq(sections.id, activities.sectionId))
    .where(eq(sections.courseId, courseId));
  if (total > EXPORT_ACTIVITY_LIMIT) {
    throw exportTooLarge(`This course has more than ${EXPORT_ACTIVITY_LIMIT} activities, too many for one course package.`);
  }

  const unitRows = await db.select().from(sections).where(eq(sections.courseId, courseId)).orderBy(asc(sections.position), asc(sections.id));
  const folderRows = await db.select().from(resourceFolders).where(eq(resourceFolders.courseId, courseId)).orderBy(asc(resourceFolders.position), asc(resourceFolders.id));
  const prerequisiteRows = await db.select().from(sectionPrerequisites).where(eq(sectionPrerequisites.courseId, courseId));
  const activityRows = (
    await db
      .select({ activity: activities })
      .from(activities)
      .innerJoin(sections, eq(sections.id, activities.sectionId))
      .where(eq(sections.courseId, courseId))
      .orderBy(asc(sections.position), asc(sections.id), asc(activities.position), asc(activities.id))
  ).map((row) => row.activity);
  const activityIds = activityRows.map((row) => row.id);
  const quizIds = activityRows.filter((row) => row.type === 'quiz').map((row) => row.id);
  const questionRows = quizIds.length
    ? await db.select().from(quizQuestions).where(inArray(quizQuestions.activityId, quizIds)).orderBy(asc(quizQuestions.activityId), asc(quizQuestions.position), asc(quizQuestions.id))
    : [];
  // Only documents attached to this course's own activities can become assets.
  const documentRows = activityIds.length
    ? await db
        .select({ id: courseDocuments.id, storageKey: courseDocuments.storageKey, fileName: courseDocuments.fileName, format: courseDocuments.format, byteSize: courseDocuments.byteSize, sha256: courseDocuments.sha256 })
        .from(courseDocuments)
        .where(inArray(courseDocuments.activityId, activityIds))
    : [];

  const warnings: PackageWarning[] = [];
  const unitKeys = new Map(unitRows.map((unit, index) => [unit.id, `unit-${index + 1}`]));
  const folderKeys = new Map<string, string>();
  const activityKeys = new Map(activityRows.map((activity, index) => [activity.id, `activity-${index + 1}`]));
  const questionsByQuiz = new Map<string, typeof questionRows>();
  for (const question of questionRows) questionsByQuiz.set(question.activityId, [...(questionsByQuiz.get(question.activityId) ?? []), question]);
  const documents = new Map(documentRows.map((document) => [document.id, document]));
  const assetKeys = new Map<string, string>();
  const assets: PackageAsset[] = [];
  const storageKeys = new Map<string, string>();

  // Folders are numbered across the course in unit order, so keys do not depend on query order.
  for (const unit of unitRows) {
    for (const folder of folderRows.filter((row) => row.sectionId === unit.id)) folderKeys.set(folder.id, `folder-${folderKeys.size + 1}`);
  }

  const assetFor = (documentId: string, target: string): string | null => {
    const document = documents.get(documentId);
    if (!document) {
      warnings.push({ code: 'INVALID_REFERENCE', target, detail: 'The document this activity refers to is not part of this course.' });
      return null;
    }
    let key = assetKeys.get(document.id);
    if (!key) {
      key = `asset-${assets.length + 1}`;
      assetKeys.set(document.id, key);
      assets.push({ key, kind: 'document', fileName: document.fileName, format: document.format, byteSize: document.byteSize, sha256: document.sha256, bundled: false });
      storageKeys.set(key, document.storageKey);
    }
    return key;
  };

  const questionsOf = (rows: ReadonlyArray<{ type: QuizQuestionType; prompt: string; points: number; options: QuizOption[]; correctAnswer: QuizAnswer }>, target: string): PackageQuestion[] =>
    rows.map((question, index) => {
      const options = Array.isArray(question.options) ? question.options : [];
      // True/false options keep their fixed keys; choice options are numbered in their stored order.
      const optionKeys = new Map(options.map((option, position) => [option.id, question.type === 'true_false' ? option.id : `o${position + 1}`]));
      const correct = Array.isArray(question.correctAnswer?.optionIds) ? question.correctAnswer.optionIds : [];
      const correctOptionKeys = correct.map((id) => optionKeys.get(id)).filter((key): key is string => Boolean(key));
      if (correctOptionKeys.length !== correct.length) {
        warnings.push({ code: 'INVALID_REFERENCE', target: `${target}/q${index + 1}`, detail: 'An answer key refers to an option the question does not have; it was left out.' });
      }
      return {
        key: `q${index + 1}`,
        type: question.type,
        prompt: question.prompt,
        points: question.points,
        options: options.map((option) => ({ key: optionKeys.get(option.id)!, text: option.text })),
        correctOptionKeys,
      };
    });

  const contentOf = (activity: ActivityRow, config: ActivityConfig | null, version: 'working' | 'approved', target: string): PackageContent => {
    const value = config ?? {};
    switch (activity.type) {
      case 'page':
        return { body: asText(value.body) };
      case 'link':
        return {
          url: asText(value.url),
          description: asNullableText(value.description),
          kind: (RESOURCE_KINDS as readonly string[]).includes(String(value.kind)) ? (value.kind as ResourceKind) : 'website',
        };
      case 'quiz': {
        const settings = readSettings(config);
        const questions = version === 'working' ? questionsOf(questionsByQuiz.get(activity.id) ?? [], target) : questionsOf(readSnapshotQuestions(config), target);
        return { ...settings, questions };
      }
      case 'assignment': {
        const assignment = readAssignment(config);
        return {
          instructions: assignment.instructions,
          dueAt: assignment.dueAt,
          lateUntil: assignment.lateUntil,
          rubric: assignment.rubric.map((criterion, index) => ({ key: `c${index + 1}`, title: criterion.title, description: criterion.description ?? null, maxPoints: criterion.maxPoints })),
        };
      }
      case 'file': {
        const document = readDocumentConfig(config);
        if (!document) {
          warnings.push({ code: 'INVALID_REFERENCE', target, detail: 'This document activity has no valid document reference.' });
          return null;
        }
        return { assetKey: assetFor(document.documentId, target), fileName: document.fileName, format: document.format };
      }
      default:
        warnings.push({ code: 'UNSUPPORTED_ACTIVITY_TYPE', target, detail: `Activities of type ${activity.type} are not portable yet; only the title is included.` });
        return null;
    }
  };

  const packagedActivities = new Map<string, PackageActivity[]>();
  for (const activity of activityRows) {
    const key = activityKeys.get(activity.id)!;
    let folderKey: string | null = null;
    if (activity.folderId) {
      folderKey = folderKeys.get(activity.folderId) ?? null;
      if (!folderKey) warnings.push({ code: 'INVALID_REFERENCE', target: key, detail: 'The folder of this activity is not part of this course; the activity is placed outside folders.' });
    }
    const entry: PackageActivity = {
      key,
      type: activity.type,
      position: activity.position,
      visible: activity.isVisible,
      folderKey,
      reviewStatus: activity.reviewStatus,
      working: { title: activity.title, content: contentOf(activity, activity.config, 'working', `${key}/working`) },
      approved:
        activity.approvedConfig && activity.approvedTitle !== null
          ? { title: activity.approvedTitle, content: contentOf(activity, activity.approvedConfig, 'approved', `${key}/approved`) }
          : null,
    };
    packagedActivities.set(activity.sectionId, [...(packagedActivities.get(activity.sectionId) ?? []), entry]);
  }

  const units: PackageUnit[] = unitRows.map((unit) => {
    const requires = prerequisiteRows
      .filter((row) => row.sectionId === unit.id)
      .map((row) => unitKeys.get(row.requiredSectionId))
      .filter((key): key is string => {
        if (!key) warnings.push({ code: 'INVALID_REFERENCE', target: unitKeys.get(unit.id)!, detail: 'A prerequisite refers to a unit that is not part of this course; it was left out.' });
        return Boolean(key);
      })
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    return {
      key: unitKeys.get(unit.id)!,
      title: unit.title,
      summary: unit.summary,
      position: unit.position,
      visible: unit.isVisible,
      requiresUnitKeys: requires,
      folders: folderRows.filter((row) => row.sectionId === unit.id).map((row) => ({ key: folderKeys.get(row.id)!, title: row.title, position: row.position })),
      activities: packagedActivities.get(unit.id) ?? [],
    };
  });

  // File bytes stay in the institution's storage: report each asset, and any that is missing there.
  for (const asset of assets) {
    if (!(await storage.exists(storageKeys.get(asset.key)!))) {
      warnings.push({ code: 'ASSET_MISSING', target: asset.key, detail: 'The stored file of this document was not found; only its description is included.' });
    }
  }
  if (assets.length) {
    warnings.unshift({ code: 'ASSET_NOT_BUNDLED', target: 'assets', detail: 'Document files are described (name, format, size, SHA-256) but not included in this package.' });
  }

  const body = { title: course.title, description: course.description, units };
  const packaged: CoursePackage = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    // The same content always gives the same hash, whatever the export time or the state of file storage.
    contentHash: `sha256:${sha256(JSON.stringify({ formatVersion: PACKAGE_FORMAT_VERSION, course: body, assets }))}`,
    source: { courseCode: course.code, courseStatus: course.status },
    course: body,
    assets,
    warnings,
    excludedData: EXCLUDED_DATA,
    counts: {
      units: units.length,
      folders: folderKeys.size,
      activities: activityRows.length,
      approvedActivities: activityRows.filter((row) => row.approvedConfig !== null).length,
      questions: units.reduce(
        (total, unit) =>
          total +
          unit.activities.reduce((sum, activity) => {
            const content = activity.working.content;
            return sum + (content && 'questions' in content ? content.questions.length : 0);
          }, 0),
        0,
      ),
      assets: assets.length,
    },
  };
  return packaged;
}

/** Serializes a package, refusing one above the size limit. */
export function serializePackage(packaged: CoursePackage): string {
  const json = JSON.stringify(packaged);
  if (Buffer.byteLength(json, 'utf8') > EXPORT_MAX_BYTES) {
    throw exportTooLarge(`This course's package would exceed ${EXPORT_MAX_BYTES / (1024 * 1024)} MB.`);
  }
  return json;
}
