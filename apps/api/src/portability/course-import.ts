/**
 * AP-038B course portability, import side: validation and planning of an AP-038A course package (format v1).
 *
 * `analyzePackage` never touches the database. It checks the format and version, rebuilds the package in the exact
 * shape the export hashes and verifies `contentHash`, validates every value with the same limits as the authoring API
 * (text lengths, safe https links, quiz answer keys, rubric points), resolves every package-local key, and reports what
 * cannot be imported: document activities (their files are not in v1 packages; AP-040), activity types that are not
 * portable yet, and fields this version does not know (ignored). The result is a preview plus, when the package is
 * valid, an import plan that `routes/course-import.ts` turns into a new draft course inside one transaction.
 *
 * Package keys are only ever used as map keys here: nothing in a package is treated as a database identifier.
 */
import { RESOURCE_KINDS, normalizeResourceUrl, type ResourceKind } from '../content/urls.js';
import type { QuizQuestionType } from '../db/schema/index.js';
import { hasCycle } from '../progress/model.js';
import { QUIZ_LIMITS, type QuestionInput } from '../quizzes/model.js';
import { ASSIGNMENT_LIMITS } from '../assignments/model.js';
import {
  EXPORT_ACTIVITY_LIMIT,
  EXPORT_MAX_BYTES,
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  packageContentHash,
  type CoursePackage,
  type PackageActivity,
  type PackageAsset,
  type PackageContent,
  type PackageQuestion,
  type PackageUnit,
  type PackageVersion,
} from './course-package.js';

/** Largest package accepted (the export's own limit). */
export const IMPORT_MAX_BYTES = EXPORT_MAX_BYTES;
export const IMPORT_LIMITS = {
  units: 200,
  foldersPerUnit: 100,
  activities: EXPORT_ACTIVITY_LIMIT,
  assets: EXPORT_ACTIVITY_LIMIT,
  prerequisitesPerUnit: 20,
  /** Most issues and unknown-field paths listed in one preview (the count is always exact). */
  reported: 100,
} as const;

const ACTIVITY_TYPES = ['page', 'link', 'quiz', 'assignment', 'file', 'scorm', 'lti'] as const;
const IMPORTABLE_TYPES = ['page', 'link', 'quiz', 'assignment'] as const;
const READING_TYPES = ['page', 'link', 'file'];
const REVIEW_STATUSES = ['draft', 'submitted', 'approved', 'returned'] as const;
const QUESTION_TYPES = ['single_choice', 'multiple_choice', 'true_false'] as const;
const DOCUMENT_FORMATS = ['pdf', 'docx', 'pptx'] as const;
const COURSE_STATUSES = ['draft', 'published', 'archived'] as const;
const KEY = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

type ImportableType = (typeof IMPORTABLE_TYPES)[number];
export type ImportIssue = { path: string; code: string; message: string };
export type SkipReason = 'DOCUMENT_NOT_BUNDLED' | 'UNSUPPORTED_ACTIVITY_TYPE';
export type SkippedActivity = { key: string; unitKey: string; type: string; title: string; reason: SkipReason };
export type VersionPreference = 'approved' | 'working';

export type PlannedActivity = {
  key: string;
  type: ImportableType;
  title: string;
  visible: boolean;
  folderKey: string | null;
  /** Which package version the draft is built from. */
  source: 'approved' | 'working';
  page?: { body: string };
  link?: { url: string; description: string | null; kind: ResourceKind };
  quiz?: {
    settings: { instructions: string | null; attemptLimit: number; timeLimitMinutes: number | null; shuffleQuestions: boolean; shuffleOptions: boolean; passingScorePercent: number | null; showFeedback: boolean; questionsPerAttempt: number | null };
    questions: QuestionInput[];
  };
  assignment?: { instructions: string; rubric: Array<{ title: string; description: string | null; maxPoints: number }> };
};
export type PlannedUnit = { key: string; title: string; summary: string | null; visible: boolean; requiresUnitKeys: string[]; folders: Array<{ key: string; title: string }>; activities: PlannedActivity[] };
export type ImportPlan = { title: string; description: string | null; units: PlannedUnit[] };

export type ImportPreview = {
  valid: boolean;
  format: string | null;
  formatVersion: number | null;
  supportedFormatVersion: number;
  contentHash: string | null;
  hashVerified: boolean;
  source: { title: string | null; description: string | null; courseCode: string | null; courseStatus: string | null; exportedAt: string | null };
  counts: { units: number; folders: number; activities: number; activitiesByType: Record<string, number>; questions: number; importableActivities: number; skippedActivities: number; assignments: number };
  documents: Array<{ assetKey: string; fileName: string; format: string; byteSize: number; sha256: string; availability: 'not_bundled' | 'missing_at_source'; activityKeys: string[] }>;
  skipped: SkippedActivity[];
  unsupportedFields: string[];
  unsupportedFieldCount: number;
  errors: ImportIssue[];
  errorCount: number;
  packageWarnings: Array<{ code: string; target: string }>;
  requiresAcknowledgement: boolean;
  requiresDueDate: boolean;
};

export type PackageAnalysis = { preview: ImportPreview; plan: ImportPlan | null; fatal: 'format' | 'version' | 'hash' | 'invalid' | null };

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const isIsoDate = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));

/**
 * Collects issues and unknown fields while walking the package. Every check that fails records an issue and returns a
 * safe placeholder, so one pass reports every problem rather than the first one.
 */
class Walker {
  readonly issues: ImportIssue[] = [];
  readonly unknown: string[] = [];

  issue(path: string, code: string, message: string) {
    this.issues.push({ path, code, message });
  }

  /** Records fields outside `known` (ignored by this reader) and returns the object. */
  fields(value: Obj, path: string, known: readonly string[]) {
    for (const key of Object.keys(value)) if (!known.includes(key)) this.unknown.push(`${path}.${key}`);
  }

  object(value: unknown, path: string): Obj | null {
    if (isObj(value)) return value;
    this.issue(path, 'INVALID_TYPE', 'Expected an object.');
    return null;
  }

  array(value: unknown, path: string, max: number, label: string): unknown[] {
    if (!Array.isArray(value)) {
      this.issue(path, 'INVALID_TYPE', 'Expected a list.');
      return [];
    }
    if (value.length > max) {
      this.issue(path, 'TOO_MANY_ITEMS', `At most ${max} ${label} can be imported.`);
      return value.slice(0, max);
    }
    return value;
  }

  /** A string within limits; `required` text must also contain a non-space character. */
  text(value: unknown, path: string, max: number, required: boolean): string {
    if (typeof value !== 'string') {
      this.issue(path, 'INVALID_TYPE', 'Expected text.');
      return '';
    }
    if (value.length > max) this.issue(path, 'TOO_LONG', `At most ${max} characters.`);
    else if (required && !/\S/.test(value)) this.issue(path, 'REQUIRED', 'This text cannot be empty.');
    return value;
  }

  nullableText(value: unknown, path: string, max: number): string | null {
    if (value === null) return null;
    return this.text(value, path, max, false);
  }

  int(value: unknown, path: string, min: number, max: number): number {
    if (!isInt(value)) {
      this.issue(path, 'INVALID_TYPE', 'Expected a whole number.');
      return min;
    }
    if (value < min || value > max) this.issue(path, 'OUT_OF_RANGE', `Expected a whole number from ${min} to ${max}.`);
    return value;
  }

  nullableInt(value: unknown, path: string, min: number, max: number): number | null {
    return value === null ? null : this.int(value, path, min, max);
  }

  bool(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') {
      this.issue(path, 'INVALID_TYPE', 'Expected true or false.');
      return false;
    }
    return value;
  }

  oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      this.issue(path, 'INVALID_VALUE', `Expected one of: ${allowed.join(', ')}.`);
      return allowed[0]!;
    }
    return value as T;
  }

  key(value: unknown, path: string, seen: Set<string>): string {
    if (typeof value !== 'string' || !KEY.test(value)) {
      this.issue(path, 'INVALID_KEY', 'Keys use 1 to 64 letters, digits, dots, dashes or underscores.');
      return `invalid-${this.issues.length}`;
    }
    if (seen.has(value)) this.issue(path, 'DUPLICATE_KEY', `The key ${value} is used more than once.`);
    seen.add(value);
    return value;
  }
}

/** Rebuilds one activity content in the export's exact key order, validating it on the way. */
function readContent(w: Walker, type: (typeof ACTIVITY_TYPES)[number], value: unknown, path: string, assetKeys: Set<string>): PackageContent {
  if (type === 'scorm' || type === 'lti') {
    if (value !== null) w.issue(path, 'INVALID_VALUE', `Content of ${type} activities must be null in this package version.`);
    return null;
  }
  if (type === 'file' && value === null) return null;
  const c = w.object(value, path);
  if (!c) return null;
  switch (type) {
    case 'page': {
      w.fields(c, path, ['body']);
      return { body: w.text(c.body, `${path}.body`, 20000, true) };
    }
    case 'link': {
      w.fields(c, path, ['url', 'description', 'kind']);
      const url = w.text(c.url, `${path}.url`, 2048, true);
      if (url && !normalizeResourceUrl(url)) w.issue(`${path}.url`, 'UNSAFE_URL', 'Only https links on a domain name, without embedded credentials, can be imported.');
      return { url, description: w.nullableText(c.description, `${path}.description`, 1000), kind: w.oneOf(c.kind, `${path}.kind`, RESOURCE_KINDS) };
    }
    case 'quiz': {
      w.fields(c, path, ['instructions', 'attemptLimit', 'timeLimitMinutes', 'shuffleQuestions', 'shuffleOptions', 'passingScorePercent', 'showFeedback', 'questionsPerAttempt', 'questions']);
      const content = {
        instructions: w.nullableText(c.instructions, `${path}.instructions`, QUIZ_LIMITS.instructions),
        attemptLimit: w.int(c.attemptLimit, `${path}.attemptLimit`, 1, QUIZ_LIMITS.attemptLimit),
        timeLimitMinutes: w.nullableInt(c.timeLimitMinutes, `${path}.timeLimitMinutes`, 1, QUIZ_LIMITS.timeLimitMinutes),
        shuffleQuestions: w.bool(c.shuffleQuestions, `${path}.shuffleQuestions`),
        shuffleOptions: w.bool(c.shuffleOptions, `${path}.shuffleOptions`),
        passingScorePercent: w.nullableInt(c.passingScorePercent, `${path}.passingScorePercent`, 1, 100),
        showFeedback: w.bool(c.showFeedback, `${path}.showFeedback`),
        questionsPerAttempt: w.nullableInt(c.questionsPerAttempt, `${path}.questionsPerAttempt`, 1, QUIZ_LIMITS.questions),
        questions: [] as PackageQuestion[],
      };
      const questionKeys = new Set<string>();
      content.questions = w.array(c.questions, `${path}.questions`, QUIZ_LIMITS.questions, 'questions per quiz').map((raw, index) => readQuestion(w, raw, `${path}.questions[${index}]`, questionKeys));
      return content;
    }
    case 'assignment': {
      w.fields(c, path, ['instructions', 'dueAt', 'lateUntil', 'rubric']);
      const instructions = w.text(c.instructions, `${path}.instructions`, ASSIGNMENT_LIMITS.instructions, true);
      const dueAt = isIsoDate(c.dueAt) ? c.dueAt : (w.issue(`${path}.dueAt`, 'INVALID_DATE', 'Expected a date and time.'), '');
      const lateUntil = c.lateUntil === null ? null : isIsoDate(c.lateUntil) ? c.lateUntil : (w.issue(`${path}.lateUntil`, 'INVALID_DATE', 'Expected a date and time or null.'), null);
      const criterionKeys = new Set<string>();
      const rubric = w.array(c.rubric, `${path}.rubric`, ASSIGNMENT_LIMITS.criteria, 'rubric criteria').map((raw, index) => {
        const cp = `${path}.rubric[${index}]`;
        const r = w.object(raw, cp) ?? {};
        w.fields(r, cp, ['key', 'title', 'description', 'maxPoints']);
        return {
          key: w.key(r.key, `${cp}.key`, criterionKeys),
          title: w.text(r.title, `${cp}.title`, ASSIGNMENT_LIMITS.criterionTitle, true),
          description: w.nullableText(r.description, `${cp}.description`, ASSIGNMENT_LIMITS.criterionDescription),
          maxPoints: w.int(r.maxPoints, `${cp}.maxPoints`, 1, ASSIGNMENT_LIMITS.criterionPoints),
        };
      });
      if (Array.isArray(c.rubric) && c.rubric.length === 0) w.issue(`${path}.rubric`, 'REQUIRED', 'An assignment needs at least one rubric criterion.');
      return { instructions, dueAt, lateUntil, rubric };
    }
    case 'file': {
      w.fields(c, path, ['assetKey', 'fileName', 'format']);
      let assetKey: string | null = null;
      if (c.assetKey !== null) {
        assetKey = typeof c.assetKey === 'string' ? c.assetKey : (w.issue(`${path}.assetKey`, 'INVALID_TYPE', 'Expected an asset key or null.'), null);
        if (assetKey !== null && !assetKeys.has(assetKey)) w.issue(`${path}.assetKey`, 'UNKNOWN_REFERENCE', `The asset ${assetKey} is not in this package.`);
      }
      return { assetKey, fileName: w.text(c.fileName, `${path}.fileName`, 255, true), format: w.oneOf(c.format, `${path}.format`, DOCUMENT_FORMATS) };
    }
  }
}

function readQuestion(w: Walker, raw: unknown, path: string, keys: Set<string>): PackageQuestion {
  const q = w.object(raw, path) ?? {};
  w.fields(q, path, ['key', 'type', 'prompt', 'points', 'options', 'correctOptionKeys']);
  const key = w.key(q.key, `${path}.key`, keys);
  const type = w.oneOf(q.type, `${path}.type`, QUESTION_TYPES);
  const prompt = w.text(q.prompt, `${path}.prompt`, QUIZ_LIMITS.prompt, true);
  const points = w.int(q.points, `${path}.points`, 1, QUIZ_LIMITS.points);
  const optionKeys = new Set<string>();
  const options = w.array(q.options, `${path}.options`, QUIZ_LIMITS.maxOptions, 'options per question').map((rawOption, index) => {
    const op = `${path}.options[${index}]`;
    const o = w.object(rawOption, op) ?? {};
    w.fields(o, op, ['key', 'text']);
    return { key: w.key(o.key, `${op}.key`, optionKeys), text: w.text(o.text, `${op}.text`, QUIZ_LIMITS.optionText, true) };
  });
  const correct = w.array(q.correctOptionKeys, `${path}.correctOptionKeys`, QUIZ_LIMITS.maxOptions, 'correct options').map((value, index) =>
    typeof value === 'string' ? value : (w.issue(`${path}.correctOptionKeys[${index}]`, 'INVALID_TYPE', 'Expected an option key.'), ''),
  );
  // Answer keys: every key names an option of this question, once; the count fits the question type.
  if (new Set(correct).size !== correct.length) w.issue(`${path}.correctOptionKeys`, 'INVALID_ANSWER_KEY', 'An option is listed as correct more than once.');
  for (const value of correct) if (value && !optionKeys.has(value)) w.issue(`${path}.correctOptionKeys`, 'INVALID_ANSWER_KEY', `The answer key names ${value}, which is not an option of this question.`);
  if (type === 'true_false') {
    if (options.length !== 2 || options[0]?.key !== 'true' || options[1]?.key !== 'false') w.issue(`${path}.options`, 'INVALID_OPTIONS', 'A true/false question has exactly the options true and false.');
    if (correct.length !== 1) w.issue(`${path}.correctOptionKeys`, 'INVALID_ANSWER_KEY', 'A true/false question has exactly one correct option.');
  } else {
    if (options.length < QUIZ_LIMITS.minOptions) w.issue(`${path}.options`, 'INVALID_OPTIONS', `A choice question needs ${QUIZ_LIMITS.minOptions} to ${QUIZ_LIMITS.maxOptions} options.`);
    if (type === 'single_choice' && correct.length !== 1) w.issue(`${path}.correctOptionKeys`, 'INVALID_ANSWER_KEY', 'A single-answer question has exactly one correct option.');
    if (type === 'multiple_choice' && correct.length < 1) w.issue(`${path}.correctOptionKeys`, 'INVALID_ANSWER_KEY', 'A multiple-answer question needs at least one correct option.');
  }
  return { key, type, prompt, points, options, correctOptionKeys: correct };
}

function readVersion(w: Walker, type: (typeof ACTIVITY_TYPES)[number], value: unknown, path: string, assetKeys: Set<string>): PackageVersion {
  const v = w.object(value, path) ?? {};
  w.fields(v, path, ['title', 'content']);
  return { title: w.text(v.title, `${path}.title`, 200, true), content: readContent(w, type, v.content, `${path}.content`, assetKeys) };
}

/** Items in `position` order (list order for equal positions), as the export lists them. */
const byPosition = <T extends { position: number }>(items: readonly T[]): T[] =>
  items.map((item, index) => ({ item, index })).sort((a, b) => a.item.position - b.item.position || a.index - b.index).map(({ item }) => item);

/** Converts a validated package question into the authoring API's question input (fresh option ids are made later). */
function questionInput(question: PackageQuestion): QuestionInput {
  if (question.type === 'true_false') return { type: 'true_false', prompt: question.prompt, points: question.points, correctAnswer: question.correctOptionKeys[0] === 'true' };
  const correct = new Set(question.correctOptionKeys);
  return { type: question.type as Exclude<QuizQuestionType, 'true_false'>, prompt: question.prompt, points: question.points, options: question.options.map((option) => ({ text: option.text, isCorrect: correct.has(option.key) })) };
}

/**
 * Validates a parsed package and plans its import. Never throws for bad input: problems are reported in the preview.
 * `preference` chooses which version becomes the imported draft when an activity has both.
 */
export function analyzePackage(input: unknown, preference: VersionPreference = 'approved'): PackageAnalysis {
  const w = new Walker();
  const preview: ImportPreview = {
    valid: false,
    format: null,
    formatVersion: null,
    supportedFormatVersion: PACKAGE_FORMAT_VERSION,
    contentHash: null,
    hashVerified: false,
    source: { title: null, description: null, courseCode: null, courseStatus: null, exportedAt: null },
    counts: { units: 0, folders: 0, activities: 0, activitiesByType: {}, questions: 0, importableActivities: 0, skippedActivities: 0, assignments: 0 },
    documents: [],
    skipped: [],
    unsupportedFields: [],
    unsupportedFieldCount: 0,
    errors: [],
    errorCount: 0,
    packageWarnings: [],
    requiresAcknowledgement: false,
    requiresDueDate: false,
  };
  const finish = (fatal: PackageAnalysis['fatal'], plan: ImportPlan | null): PackageAnalysis => {
    preview.errors = w.issues.slice(0, IMPORT_LIMITS.reported);
    preview.errorCount = w.issues.length;
    preview.unsupportedFields = w.unknown.slice(0, IMPORT_LIMITS.reported);
    preview.unsupportedFieldCount = w.unknown.length;
    preview.valid = fatal === null;
    return { preview, plan: fatal === null ? plan : null, fatal };
  };

  const root = w.object(input, '$');
  if (!root) return finish('format', null);
  preview.format = typeof root.format === 'string' ? root.format.slice(0, 100) : null;
  if (root.format !== PACKAGE_FORMAT) {
    w.issue('$.format', 'UNSUPPORTED_FORMAT', `This is not an AcademiaPath course package (expected format ${PACKAGE_FORMAT}).`);
    return finish('format', null);
  }
  preview.formatVersion = isInt(root.formatVersion) ? root.formatVersion : null;
  if (root.formatVersion !== PACKAGE_FORMAT_VERSION) {
    w.issue('$.formatVersion', 'UNSUPPORTED_VERSION', `Only course package version ${PACKAGE_FORMAT_VERSION} can be imported.`);
    return finish('version', null);
  }
  w.fields(root, '$', ['format', 'formatVersion', 'exportedAt', 'contentHash', 'source', 'course', 'assets', 'warnings', 'excludedData', 'counts']);
  preview.contentHash = typeof root.contentHash === 'string' && HASH.test(root.contentHash) ? root.contentHash : null;
  if (!preview.contentHash) w.issue('$.contentHash', 'INVALID_VALUE', 'Expected sha256: followed by 64 hexadecimal characters.');
  preview.source.exportedAt = isIsoDate(root.exportedAt) ? root.exportedAt : null;
  const source = isObj(root.source) ? root.source : {};
  preview.source.courseCode = typeof source.courseCode === 'string' ? source.courseCode.slice(0, 64) : null;
  preview.source.courseStatus = typeof source.courseStatus === 'string' && (COURSE_STATUSES as readonly string[]).includes(source.courseStatus) ? source.courseStatus : null;

  // Assets first: activity contents refer to them.
  const assetKeySet = new Set<string>();
  const assets: PackageAsset[] = w.array(root.assets, '$.assets', IMPORT_LIMITS.assets, 'document references').map((raw, index) => {
    const path = `$.assets[${index}]`;
    const a = w.object(raw, path) ?? {};
    w.fields(a, path, ['key', 'kind', 'fileName', 'format', 'byteSize', 'sha256', 'bundled']);
    const key = w.key(a.key, `${path}.key`, assetKeySet);
    const kind = w.oneOf(a.kind, `${path}.kind`, ['document'] as const);
    const fileName = w.text(a.fileName, `${path}.fileName`, 255, true);
    const format = w.oneOf(a.format, `${path}.format`, DOCUMENT_FORMATS);
    const byteSize = w.int(a.byteSize, `${path}.byteSize`, 1, Number.MAX_SAFE_INTEGER);
    const sha256 = typeof a.sha256 === 'string' && SHA256.test(a.sha256) ? a.sha256 : (w.issue(`${path}.sha256`, 'INVALID_VALUE', 'Expected 64 hexadecimal characters.'), '');
    if (a.bundled !== false) w.issue(`${path}.bundled`, 'UNSUPPORTED_VALUE', 'Version 1 packages never include file contents.');
    return { key, kind, fileName, format, byteSize, sha256, bundled: false as const };
  });

  const course = w.object(root.course, '$.course') ?? {};
  w.fields(course, '$.course', ['title', 'description', 'units']);
  const title = w.text(course.title, '$.course.title', 200, true);
  const description = w.nullableText(course.description, '$.course.description', 2000);
  preview.source.title = title.slice(0, 200);
  preview.source.description = description?.slice(0, 2000) ?? null;

  const unitKeys = new Set<string>();
  const activityKeys = new Set<string>();
  const folderKeys = new Set<string>();
  const rawUnits = w.array(course.units, '$.course.units', IMPORT_LIMITS.units, 'units');
  let activityTotal = 0;
  const units: PackageUnit[] = rawUnits.map((raw, unitIndex) => {
    const path = `$.course.units[${unitIndex}]`;
    const u = w.object(raw, path) ?? {};
    w.fields(u, path, ['key', 'title', 'summary', 'position', 'visible', 'requiresUnitKeys', 'folders', 'activities']);
    const key = w.key(u.key, `${path}.key`, unitKeys);
    const unitFolderKeys = new Set<string>();
    const folders = w.array(u.folders, `${path}.folders`, IMPORT_LIMITS.foldersPerUnit, 'folders per unit').map((rawFolder, index) => {
      const fp = `${path}.folders[${index}]`;
      const f = w.object(rawFolder, fp) ?? {};
      w.fields(f, fp, ['key', 'title', 'position']);
      const folderKey = w.key(f.key, `${fp}.key`, folderKeys);
      unitFolderKeys.add(folderKey);
      return { key: folderKey, title: w.text(f.title, `${fp}.title`, 120, true), position: w.int(f.position, `${fp}.position`, 0, 1_000_000) };
    });
    const rawActivities = w.array(u.activities, `${path}.activities`, IMPORT_LIMITS.activities, 'activities');
    activityTotal += rawActivities.length;
    const activities: PackageActivity[] = rawActivities.map((rawActivity, index) => {
      const ap = `${path}.activities[${index}]`;
      const a = w.object(rawActivity, ap) ?? {};
      w.fields(a, ap, ['key', 'type', 'position', 'visible', 'folderKey', 'reviewStatus', 'working', 'approved']);
      const activityKey = w.key(a.key, `${ap}.key`, activityKeys);
      const type = w.oneOf(a.type, `${ap}.type`, ACTIVITY_TYPES);
      let folderKey: string | null = null;
      if (a.folderKey !== null) {
        if (typeof a.folderKey !== 'string') w.issue(`${ap}.folderKey`, 'INVALID_TYPE', 'Expected a folder key or null.');
        else {
          folderKey = a.folderKey;
          // Folders hold reading activities of their own unit only (as in the course itself).
          if (!unitFolderKeys.has(folderKey)) w.issue(`${ap}.folderKey`, 'UNKNOWN_REFERENCE', `The folder ${folderKey} is not a folder of this unit.`);
          if (!READING_TYPES.includes(type)) w.issue(`${ap}.folderKey`, 'INVALID_VALUE', 'Only lessons, links and documents can be in a folder.');
        }
      }
      return {
        key: activityKey,
        type,
        position: w.int(a.position, `${ap}.position`, 0, 1_000_000),
        visible: w.bool(a.visible, `${ap}.visible`),
        folderKey,
        reviewStatus: w.oneOf(a.reviewStatus, `${ap}.reviewStatus`, REVIEW_STATUSES),
        working: readVersion(w, type, a.working, `${ap}.working`, assetKeySet),
        approved: a.approved === null ? null : readVersion(w, type, a.approved, `${ap}.approved`, assetKeySet),
      };
    });
    const requires = w.array(u.requiresUnitKeys, `${path}.requiresUnitKeys`, IMPORT_LIMITS.prerequisitesPerUnit, 'prerequisites per unit').map((value, index) =>
      typeof value === 'string' ? value : (w.issue(`${path}.requiresUnitKeys[${index}]`, 'INVALID_TYPE', 'Expected a unit key.'), ''),
    );
    return {
      key,
      title: w.text(u.title, `${path}.title`, 200, true),
      summary: w.nullableText(u.summary, `${path}.summary`, 2000),
      position: w.int(u.position, `${path}.position`, 0, 1_000_000),
      visible: w.bool(u.visible, `${path}.visible`),
      requiresUnitKeys: requires,
      folders,
      activities,
    };
  });
  if (activityTotal > IMPORT_LIMITS.activities) w.issue('$.course.units', 'TOO_MANY_ITEMS', `At most ${IMPORT_LIMITS.activities} activities can be imported.`);

  // Prerequisites name other units of this package, without self-references or cycles.
  const edges: Array<{ sectionId: string; requiredSectionId: string }> = [];
  units.forEach((unit, unitIndex) => {
    if (new Set(unit.requiresUnitKeys).size !== unit.requiresUnitKeys.length) w.issue(`$.course.units[${unitIndex}].requiresUnitKeys`, 'DUPLICATE_KEY', 'A prerequisite is listed more than once.');
    for (const required of unit.requiresUnitKeys) {
      if (required === unit.key) w.issue(`$.course.units[${unitIndex}].requiresUnitKeys`, 'INVALID_REFERENCE', 'A unit cannot require itself.');
      else if (!unitKeys.has(required)) w.issue(`$.course.units[${unitIndex}].requiresUnitKeys`, 'UNKNOWN_REFERENCE', `The unit ${required} is not in this package.`);
      else edges.push({ sectionId: unit.key, requiredSectionId: required });
    }
  });
  if (hasCycle(edges)) w.issue('$.course.units', 'PREREQUISITE_CYCLE', 'The unit prerequisites form a cycle.');

  // The package must be exactly what was exported: recompute the hash over the rebuilt, export-shaped content.
  const rebuilt = { title, description, units };
  preview.hashVerified = preview.contentHash !== null && packageContentHash(rebuilt, assets) === preview.contentHash;

  const warnings = Array.isArray(root.warnings) ? root.warnings.slice(0, IMPORT_LIMITS.reported) : [];
  preview.packageWarnings = warnings.filter(isObj).map((warning) => ({ code: String(warning.code ?? '').slice(0, 40), target: String(warning.target ?? '').slice(0, 120) }));
  const missingAtSource = new Set(preview.packageWarnings.filter((warning) => warning.code === 'ASSET_MISSING').map((warning) => warning.target));

  // Counts, document references and what cannot be imported.
  const documentActivities = new Map<string, string[]>();
  const plan: ImportPlan = { title, description, units: [] };
  for (const unit of byPosition(units)) {
    preview.counts.units += 1;
    preview.counts.folders += unit.folders.length;
    const planned: PlannedUnit = { key: unit.key, title: unit.title, summary: unit.summary, visible: unit.visible, requiresUnitKeys: unit.requiresUnitKeys, folders: byPosition(unit.folders).map(({ key, title: folderTitle }) => ({ key, title: folderTitle })), activities: [] };
    for (const activity of byPosition(unit.activities)) {
      preview.counts.activities += 1;
      preview.counts.activitiesByType[activity.type] = (preview.counts.activitiesByType[activity.type] ?? 0) + 1;
      const chosen = preference === 'approved' && activity.approved ? activity.approved : activity.working;
      const sourceVersion = chosen === activity.working ? 'working' : 'approved';
      const content = chosen.content;
      if (activity.type === 'file') {
        for (const version of [activity.working, activity.approved]) {
          const assetKey = version?.content && 'assetKey' in version.content ? version.content.assetKey : null;
          if (assetKey) documentActivities.set(assetKey, [...new Set([...(documentActivities.get(assetKey) ?? []), activity.key])]);
        }
        preview.skipped.push({ key: activity.key, unitKey: unit.key, type: activity.type, title: chosen.title.slice(0, 200), reason: 'DOCUMENT_NOT_BUNDLED' });
        continue;
      }
      if (activity.type === 'scorm' || activity.type === 'lti') {
        preview.skipped.push({ key: activity.key, unitKey: unit.key, type: activity.type, title: chosen.title.slice(0, 200), reason: 'UNSUPPORTED_ACTIVITY_TYPE' });
        continue;
      }
      const entry: PlannedActivity = { key: activity.key, type: activity.type, title: chosen.title, visible: activity.visible, folderKey: activity.folderKey, source: sourceVersion };
      if (content && 'body' in content) entry.page = { body: content.body };
      else if (content && 'url' in content) entry.link = { url: normalizeResourceUrl(content.url) ?? content.url, description: content.description?.trim() || null, kind: content.kind };
      else if (content && 'questions' in content) {
        preview.counts.questions += content.questions.length;
        const { questions, ...settings } = content;
        entry.quiz = { settings: { ...settings, instructions: settings.instructions?.trim() || null }, questions: questions.map(questionInput) };
      } else if (content && 'rubric' in content) {
        preview.counts.assignments += 1;
        entry.assignment = { instructions: content.instructions, rubric: content.rubric.map(({ title: criterion, description: detail, maxPoints }) => ({ title: criterion, description: detail, maxPoints })) };
      }
      planned.activities.push(entry);
      preview.counts.importableActivities += 1;
    }
    plan.units.push(planned);
  }
  preview.counts.skippedActivities = preview.skipped.length;
  preview.documents = assets.map((asset) => ({
    assetKey: asset.key,
    fileName: asset.fileName,
    format: asset.format,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
    availability: missingAtSource.has(asset.key) ? 'missing_at_source' : 'not_bundled',
    activityKeys: documentActivities.get(asset.key) ?? [],
  }));
  preview.requiresAcknowledgement = preview.skipped.length > 0;
  preview.requiresDueDate = preview.counts.assignments > 0;

  if (w.issues.length) return finish('invalid', null);
  if (!preview.hashVerified) {
    w.issue('$.contentHash', 'HASH_MISMATCH', 'The content does not match the package hash: the file was changed after it was exported.');
    return finish('hash', null);
  }
  return finish(null, plan);
}

export type { CoursePackage };
