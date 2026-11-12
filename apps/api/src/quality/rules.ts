import type { ActivityConfig } from '../db/schema/index.js';
import { normalizeResourceUrl } from '../content/urls.js';
import { ASSIGNMENT_LIMITS } from '../assignments/model.js';
import { readDocumentConfig } from '../documents/model.js';
import { QUIZ_LIMITS, readSettings, TRUE_FALSE_OPTIONS } from '../quizzes/model.js';

/*
 * AP-029 content quality rules. Pure and deterministic: the same records always give the same findings, nothing
 * is fetched from the network (URLs are only parsed), nothing is written, and no wording is produced here — each
 * finding carries a stable code plus the location and the few machine values the interface needs; the web app
 * holds the English and Spanish descriptions and guidance for every code.
 *
 * Blocking findings are only states the existing editors already refuse to save (so they come from legacy,
 * imported or otherwise inconsistent data) or broken references; submitting or approving such content would
 * publish something invalid. Everything else is a warning and never blocks anything.
 */

export const QUALITY_CODES = [
  // Blocking
  'ACTIVITY_TITLE_EMPTY',
  'PAGE_BODY_EMPTY',
  'LINK_URL_INVALID',
  'QUIZ_NO_QUESTIONS',
  'QUIZ_POOL_TOO_SMALL',
  'QUIZ_POOL_POINTS_MIXED',
  'QUIZ_QUESTION_PROMPT_EMPTY',
  'QUIZ_QUESTION_OPTIONS_INCOMPLETE',
  'QUIZ_QUESTION_ANSWER_INVALID',
  'QUIZ_QUESTION_POINTS_INVALID',
  'ASSIGNMENT_INSTRUCTIONS_EMPTY',
  'ASSIGNMENT_RUBRIC_EMPTY',
  'ASSIGNMENT_RUBRIC_CRITERION_INVALID',
  'ASSIGNMENT_DATES_INVALID',
  'DOCUMENT_REFERENCE_INVALID',
  // Warnings
  'PLACEHOLDER_TEXT',
  'TEXT_LINK_UNSAFE_SCHEME',
  'TEXT_LINK_INSECURE',
  'INTERNAL_LINK_BROKEN',
  'LINK_MEDIA_DESCRIPTION_MISSING',
  'QUIZ_DUPLICATE_OPTIONS',
  'ASSIGNMENT_DEADLINE_PASSED',
  'DOCUMENT_NO_TEXT',
  'DOCUMENT_TEXT_TRUNCATED',
  'SECTION_EMPTY',
  'PREREQUISITE_SECTION_HIDDEN',
  'PREREQUISITE_SECTION_EMPTY',
  'COURSE_DESCRIPTION_MISSING',
  'COURSE_NO_SECTIONS',
  'COURSE_NO_STUDENT_CONTENT',
] as const;
export type QualityCode = (typeof QUALITY_CODES)[number];

const BLOCKING = new Set<QualityCode>([
  'ACTIVITY_TITLE_EMPTY',
  'PAGE_BODY_EMPTY',
  'LINK_URL_INVALID',
  'QUIZ_NO_QUESTIONS',
  'QUIZ_POOL_TOO_SMALL',
  'QUIZ_POOL_POINTS_MIXED',
  'QUIZ_QUESTION_PROMPT_EMPTY',
  'QUIZ_QUESTION_OPTIONS_INCOMPLETE',
  'QUIZ_QUESTION_ANSWER_INVALID',
  'QUIZ_QUESTION_POINTS_INVALID',
  'ASSIGNMENT_INSTRUCTIONS_EMPTY',
  'ASSIGNMENT_RUBRIC_EMPTY',
  'ASSIGNMENT_RUBRIC_CRITERION_INVALID',
  'ASSIGNMENT_DATES_INVALID',
  'DOCUMENT_REFERENCE_INVALID',
]);
export const severityOf = (code: QualityCode): 'blocking' | 'warning' => (BLOCKING.has(code) ? 'blocking' : 'warning');

/** Where a finding is: `field` names the part of the target to correct; `item*` a question or rubric criterion. */
export type QualityField =
  | 'title'
  | 'description'
  | 'summary'
  | 'body'
  | 'url'
  | 'instructions'
  | 'settings'
  | 'questions'
  | 'question'
  | 'option'
  | 'rubric'
  | 'criterion'
  | 'dates'
  | 'document'
  | 'activities'
  | 'prerequisites'
  | 'sections';

export type QualityFinding = {
  code: QualityCode;
  severity: 'blocking' | 'warning';
  target: 'course' | 'section' | 'activity';
  sectionId: string | null;
  activityId: string | null;
  field: QualityField | null;
  /** Question or rubric criterion id, when the finding is about one. */
  itemId: string | null;
  /** 1-based number of that question or criterion, for display. */
  itemNumber: number | null;
  /** One short machine value for the message: a placeholder found, a URL, a number of questions, a section id. */
  value: string | null;
};

export type CourseInput = { id: string; title: string; description: string | null; status: 'draft' | 'published' | 'archived' };
export type SectionInput = { id: string; title: string; summary: string | null; position: number; isVisible: boolean };
export type ActivityInput = {
  id: string;
  sectionId: string;
  type: 'page' | 'link' | 'quiz' | 'assignment' | 'file';
  title: string;
  position: number;
  isVisible: boolean;
  config: ActivityConfig;
  reviewStatus: 'draft' | 'submitted' | 'approved' | 'returned';
  hasLiveVersion: boolean;
};
/** A working-bank question as stored (the answer key is only inspected here, never reported). */
export type QuestionInput = { id: string; activityId: string; position: number; type: string; prompt: string; options: unknown; correctAnswer: unknown; points: number };
export type DocumentInput = { id: string; activityId: string; extractionStatus: 'extracted' | 'no_text'; truncated: boolean };
export type SummaryInput = { id: string; documentId: string; revision: number };
export type PrerequisiteInput = { sectionId: string; requiredSectionId: string };

export type ActivityContext = {
  questions: QuestionInput[];
  documents: ReadonlyMap<string, DocumentInput>;
  summaries: ReadonlyMap<string, SummaryInput>;
  /** Every content activity id of the course (internal links are checked against it). */
  courseActivityIds: ReadonlySet<string>;
  courseId: string;
  now: Date;
};

const MAX_VALUE = 160;
const clip = (value: string) => (value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE - 1)}…` : value);
const blank = (value: unknown) => typeof value !== 'string' || value.trim() === '';

/**
 * Obvious placeholder text. Upper-case markers only (Spanish "todo" is an ordinary word), plus bracketed
 * insertion hints and "lorem ipsum". Returns the first match.
 */
const PLACEHOLDERS: RegExp[] = [
  /\blorem ipsum\b/i,
  /\b(?:TODO|TBD|FIXME)\b/,
  /\bX{3,}\b/,
  /\[\s*(?:insert|insertar|add|añadir|agregar|placeholder|completar|pendiente|tbd|todo)\b[^\]]{0,80}\]/i,
  /\{\{[^{}]{1,80}\}\}/,
  /\bpor (?:completar|definir)\b/i,
];
export function findPlaceholder(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const pattern of PLACEHOLDERS) {
    const match = pattern.exec(text);
    if (match) return clip(match[0]);
  }
  return null;
}

// Only real URI shapes, so prose such as "Big data: …" or "File: notes" is never flagged.
const UNSAFE_SCHEME = /\b(?:(?:javascript|vbscript):[^\s<>"')\]]+|data:[\w.+-]+\/[\w.+-]+[;,][^\s<>"')\]]*|file:\/\/[^\s<>"')\]]*)/i;
const INSECURE_URL = /\bhttp:\/\/[^\s<>"')\]]+/i;
const INTERNAL_LINK = /\/courses\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/activities\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Activity ids referenced as in-app links ("/courses/<id>/activities/<id>") in a text. */
export function internalLinks(text: string | null | undefined): Array<{ path: string; courseId: string; activityId: string }> {
  if (!text) return [];
  return [...text.matchAll(INTERNAL_LINK)].map((match) => ({ path: match[0], courseId: match[1]!.toLowerCase(), activityId: match[2]!.toLowerCase() }));
}

type Emit = (code: QualityCode, at: Partial<Pick<QualityFinding, 'field' | 'itemId' | 'itemNumber' | 'value'>>) => void;

/** Placeholder, unsafe, insecure and broken in-app links in one authored text. */
function inspectText(emit: Emit, field: QualityField, text: string | null | undefined, context: Pick<ActivityContext, 'courseId' | 'courseActivityIds'> | null, item?: { itemId: string; itemNumber: number }) {
  const placeholder = findPlaceholder(text);
  if (placeholder) emit('PLACEHOLDER_TEXT', { field, value: placeholder, ...item });
  if (!context || !text) return;
  const unsafe = UNSAFE_SCHEME.exec(text);
  if (unsafe) emit('TEXT_LINK_UNSAFE_SCHEME', { field, value: clip(unsafe[0]), ...item });
  const insecure = INSECURE_URL.exec(text);
  if (insecure) emit('TEXT_LINK_INSECURE', { field, value: clip(insecure[0]), ...item });
  for (const link of internalLinks(text)) {
    if (link.courseId !== context.courseId.toLowerCase() || !context.courseActivityIds.has(link.activityId)) {
      emit('INTERNAL_LINK_BROKEN', { field, value: clip(link.path), ...item });
    }
  }
}

/** Findings for one activity's working copy (the version that would be submitted and approved). */
export function checkActivity(activity: ActivityInput, context: ActivityContext): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const emit: Emit = (code, at) =>
    findings.push({
      code,
      severity: severityOf(code),
      target: 'activity',
      sectionId: activity.sectionId,
      activityId: activity.id,
      field: at.field ?? null,
      itemId: at.itemId ?? null,
      itemNumber: at.itemNumber ?? null,
      value: at.value ?? null,
    });
  const config = (activity.config ?? {}) as Record<string, unknown>;

  if (blank(activity.title)) emit('ACTIVITY_TITLE_EMPTY', { field: 'title' });
  else inspectText(emit, 'title', activity.title, null);

  switch (activity.type) {
    case 'page': {
      if (blank(config.body)) emit('PAGE_BODY_EMPTY', { field: 'body' });
      else inspectText(emit, 'body', config.body as string, context);
      break;
    }
    case 'link': {
      const url = typeof config.url === 'string' ? config.url : '';
      // The AP-021 link policy (https on a domain name, no credentials) that creating or editing a link enforces.
      if (!normalizeResourceUrl(url)) emit('LINK_URL_INVALID', { field: 'url', value: url ? clip(url) : null });
      const description = typeof config.description === 'string' ? config.description : null;
      if ((config.kind === 'video' || config.kind === 'interactive') && blank(description)) {
        emit('LINK_MEDIA_DESCRIPTION_MISSING', { field: 'description', value: String(config.kind) });
      }
      inspectText(emit, 'description', description, context);
      break;
    }
    case 'quiz':
      checkQuiz(activity, config, context, emit);
      break;
    case 'assignment':
      checkAssignment(activity, config, context, emit);
      break;
    case 'file':
      checkDocument(activity, context, emit);
      break;
  }
  return findings;
}

function checkQuiz(activity: ActivityInput, config: Record<string, unknown>, context: ActivityContext, emit: Emit) {
  const settings = readSettings(config);
  inspectText(emit, 'instructions', settings.instructions, context);
  const questions = context.questions.filter((question) => question.activityId === activity.id).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  // The same rules the submit and approve endpoints apply (QUIZ_HAS_NO_QUESTIONS, validatePool).
  if (!questions.length) {
    emit('QUIZ_NO_QUESTIONS', { field: 'questions' });
    return;
  }
  const drawn = settings.questionsPerAttempt;
  if (drawn !== null && questions.length < drawn) emit('QUIZ_POOL_TOO_SMALL', { field: 'settings', value: String(drawn) });
  if (drawn !== null && new Set(questions.map((question) => question.points)).size > 1) emit('QUIZ_POOL_POINTS_MIXED', { field: 'questions' });

  questions.forEach((question, index) => {
    const item = { itemId: question.id, itemNumber: index + 1 };
    if (blank(question.prompt)) emit('QUIZ_QUESTION_PROMPT_EMPTY', { field: 'question', ...item });
    else inspectText(emit, 'question', question.prompt, null, item);
    if (!Number.isInteger(question.points) || question.points < 1 || question.points > QUIZ_LIMITS.points) {
      emit('QUIZ_QUESTION_POINTS_INVALID', { field: 'question', ...item });
    }
    // The invariants buildQuestion establishes when a question is written through the API.
    const options = Array.isArray(question.options) ? (question.options as Array<{ id?: unknown; text?: unknown }>) : [];
    const ids = options.map((option) => option?.id);
    const validIds = ids.every((id) => typeof id === 'string') && new Set(ids).size === ids.length;
    const optionsOk =
      question.type === 'true_false'
        ? options.length === TRUE_FALSE_OPTIONS.length && TRUE_FALSE_OPTIONS.every((expected) => ids.includes(expected.id))
        : options.length >= QUIZ_LIMITS.minOptions && options.length <= QUIZ_LIMITS.maxOptions && validIds && options.every((option) => !blank(option?.text));
    if (!optionsOk) emit('QUIZ_QUESTION_OPTIONS_INCOMPLETE', { field: 'option', ...item });
    const answer = (question.correctAnswer as { optionIds?: unknown } | null)?.optionIds;
    const chosen = Array.isArray(answer) ? answer : null;
    const answerOk =
      chosen !== null &&
      chosen.every((id) => typeof id === 'string' && ids.includes(id)) &&
      new Set(chosen).size === chosen.length &&
      (question.type === 'multiple_choice' ? chosen.length >= 1 : chosen.length === 1);
    if (!answerOk) emit('QUIZ_QUESTION_ANSWER_INVALID', { field: 'question', ...item });
    if (question.type !== 'true_false') {
      const texts = options.map((option) => (typeof option?.text === 'string' ? option.text.trim().toLowerCase() : '')).filter(Boolean);
      if (new Set(texts).size < texts.length) emit('QUIZ_DUPLICATE_OPTIONS', { field: 'option', ...item });
      for (const option of options) {
        const placeholder = findPlaceholder(typeof option?.text === 'string' ? option.text : null);
        if (placeholder) {
          emit('PLACEHOLDER_TEXT', { field: 'option', value: placeholder, ...item });
          break;
        }
      }
    }
  });
}

function checkAssignment(activity: ActivityInput, config: Record<string, unknown>, context: ActivityContext, emit: Emit) {
  if (blank(config.instructions)) emit('ASSIGNMENT_INSTRUCTIONS_EMPTY', { field: 'instructions' });
  else inspectText(emit, 'instructions', config.instructions as string, context);

  const rubric = Array.isArray(config.rubric) ? (config.rubric as Array<Record<string, unknown>>) : [];
  if (!rubric.length) emit('ASSIGNMENT_RUBRIC_EMPTY', { field: 'rubric' });
  rubric.forEach((criterion, index) => {
    const item = { itemId: typeof criterion?.id === 'string' ? criterion.id : `#${index + 1}`, itemNumber: index + 1 };
    const points = criterion?.maxPoints;
    if (typeof criterion?.id !== 'string' || blank(criterion.title) || !Number.isInteger(points) || (points as number) < 1 || (points as number) > ASSIGNMENT_LIMITS.criterionPoints) {
      emit('ASSIGNMENT_RUBRIC_CRITERION_INVALID', { field: 'criterion', ...item });
      return;
    }
    inspectText(emit, 'criterion', criterion.title as string, null, item);
    inspectText(emit, 'criterion', typeof criterion.description === 'string' ? criterion.description : null, null, item);
  });

  // The date rules assignmentFromInput applies when an assignment is saved.
  const due = typeof config.dueAt === 'string' ? Date.parse(config.dueAt) : Number.NaN;
  const lateRaw = config.lateUntil;
  const late = typeof lateRaw === 'string' ? Date.parse(lateRaw) : lateRaw == null ? null : Number.NaN;
  const windowMs = ASSIGNMENT_LIMITS.lateWindowDays * 24 * 60 * 60 * 1000;
  if (Number.isNaN(due) || (late !== null && (Number.isNaN(late) || late <= due || late - due > windowMs))) {
    emit('ASSIGNMENT_DATES_INVALID', { field: 'dates' });
    return;
  }
  // Content still being prepared whose submission window has already closed: students could never hand it in.
  const closes = late ?? due;
  if (activity.reviewStatus !== 'approved' && closes < context.now.getTime()) {
    emit('ASSIGNMENT_DEADLINE_PASSED', { field: 'dates', value: new Date(closes).toISOString() });
  }
}

function checkDocument(activity: ActivityInput, context: ActivityContext, emit: Emit) {
  const reference = readDocumentConfig(activity.config);
  const document = reference ? context.documents.get(reference.documentId) : undefined;
  const summary = reference ? context.summaries.get(reference.summaryId) : undefined;
  if (!reference || !document || document.activityId !== activity.id || !summary || summary.documentId !== document.id || summary.revision !== reference.summaryRevision) {
    emit('DOCUMENT_REFERENCE_INVALID', { field: 'document' });
    return;
  }
  if (document.extractionStatus === 'no_text') emit('DOCUMENT_NO_TEXT', { field: 'document', value: reference.fileName });
  else if (document.truncated) emit('DOCUMENT_TEXT_TRUNCATED', { field: 'document', value: reference.fileName });
}

/** Course- and section-level findings (structure, prerequisites, metadata). */
export function checkStructure(
  course: CourseInput,
  sections: SectionInput[],
  activities: ActivityInput[],
  prerequisites: PrerequisiteInput[],
): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const add = (code: QualityCode, target: 'course' | 'section', sectionId: string | null, field: QualityField | null, value: string | null = null) =>
    findings.push({ code, severity: severityOf(code), target, sectionId, activityId: null, field, itemId: null, itemNumber: null, value });

  if (blank(course.description)) add('COURSE_DESCRIPTION_MISSING', 'course', null, 'description');
  for (const [field, text] of [['title', course.title], ['description', course.description]] as const) {
    const placeholder = findPlaceholder(text);
    if (placeholder) add('PLACEHOLDER_TEXT', 'course', null, field, placeholder);
  }
  if (!sections.length) add('COURSE_NO_SECTIONS', 'course', null, 'sections');

  const bySection = new Map<string, ActivityInput[]>(sections.map((section) => [section.id, []]));
  for (const activity of activities) bySection.get(activity.sectionId)?.push(activity);
  // What students can actually open: approved, visible activities in visible sections.
  const studentVisible = (sectionId: string) => (bySection.get(sectionId) ?? []).some((activity) => activity.isVisible && activity.hasLiveVersion);
  const sectionById = new Map(sections.map((section) => [section.id, section]));

  if (course.status === 'published' && sections.length && !sections.some((section) => section.isVisible && studentVisible(section.id))) {
    add('COURSE_NO_STUDENT_CONTENT', 'course', null, 'sections');
  }
  for (const section of sections) {
    if (!(bySection.get(section.id) ?? []).length) add('SECTION_EMPTY', 'section', section.id, 'activities');
    for (const [field, text] of [['title', section.title], ['summary', section.summary]] as const) {
      const placeholder = findPlaceholder(text);
      if (placeholder) add('PLACEHOLDER_TEXT', 'section', section.id, field, placeholder);
    }
  }
  // Prerequisite semantics of the progress model: a hidden required section is ignored, and a required section
  // without published activities counts as complete, so in both cases the requirement holds nothing back.
  for (const prerequisite of prerequisites) {
    const dependent = sectionById.get(prerequisite.sectionId);
    const required = sectionById.get(prerequisite.requiredSectionId);
    if (!dependent || !required || !dependent.isVisible) continue;
    if (!required.isVisible) add('PREREQUISITE_SECTION_HIDDEN', 'section', dependent.id, 'prerequisites', required.id);
    else if (!studentVisible(required.id)) add('PREREQUISITE_SECTION_EMPTY', 'section', dependent.id, 'prerequisites', required.id);
  }
  return findings;
}
