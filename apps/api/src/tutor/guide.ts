import { createHash } from 'node:crypto';
import { GUIDE_TEXT, type GuideText } from './guide-text.js';
import type { Material, QuizInfo } from './materials.js';
import type { TutorLanguage } from './provider.js';
import { minimumMatches } from './retrieval.js';
import { fold, keyTerms, matchedTerms, searchTerms, splitPassages, type SourceLanguage } from './text.js';

/*
 * AP-030D guided demo tutor: deterministic, explainable learning actions over the approved course material the
 * caller may read. Nothing here calls a model, fetches a URL or writes anything. Every course-specific statement
 * in a response is a verbatim quote (or a verbatim fragment) of an approved lesson or document, with its reference;
 * the tutor's own words (GUIDE_TEXT) only frame, introduce and label. Study tips are general advice, marked as such.
 */

export const GUIDE_ACTIONS = ['start', 'explain', 'again', 'summarize', 'simpler', 'example', 'detail', 'review', 'next', 'practice', 'material', 'quiz_prep', 'ask'] as const;
export type GuideAction = (typeof GUIDE_ACTIONS)[number];
/** Actions offered as buttons (suggestions and follow-ups). */
export type SuggestedAction = Exclude<GuideAction, 'start' | 'ask'>;

export type Block = { kind: 'text' | 'quote' | 'list' | 'tip'; text: string | null; items: string[]; ref: number | null; sourceLanguage: SourceLanguage | null };
export type ReferenceType = 'page' | 'file' | 'link' | 'quiz' | 'assignment';
export type Reference = {
  ref: number;
  activityId: string;
  sectionId: string;
  sectionTitle: string;
  title: string;
  type: ReferenceType;
  sourceLanguage: SourceLanguage | null;
  matchesRequestedLanguage: boolean;
};
export type PracticeQuestion = { questionId: string; kind: 'term' | 'source'; prompt: string; statement: string; options: Array<{ id: string; text: string }>; ref: number };
export type Grounding = 'grounded' | 'guidance' | 'insufficient_material';
export type GuideResult = {
  action: GuideAction;
  grounding: Grounding;
  variant: number;
  /** The material the response is about, so follow-ups stay on it. */
  focus: { activityId: string; title: string } | null;
  blocks: Block[];
  references: Reference[];
  practice: PracticeQuestion | null;
  followUps: SuggestedAction[];
};

export type NextStep =
  | { kind: 'activity'; activityId: string; sectionId: string; sectionTitle: string; title: string; type: ReferenceType }
  | { kind: 'done'; lockedSections: boolean }
  | { kind: 'end' };

export type GuideInput = {
  action: Exclude<GuideAction, 'ask'>;
  language: TutorLanguage;
  courseTitle: string;
  materials: Material[];
  /** The lesson or document the student is studying (already checked to be readable), or none. */
  lesson: Material | null;
  /** Search terms of a topic to focus on (from a free-text question). */
  topicTerms: string[];
  variant: number;
  quizzes?: QuizInfo[];
  next?: NextStep;
  isStudent: boolean;
};

const LIMITS = { summary: 6, detail: 6, review: 6, courseItems: 8, examples: 2, related: 5, options: 4 } as const;

// ------------------------------------------------------------------------------------------- text analysis

/** Sentences of a passage, verbatim. */
export function sentences(passage: string): string[] {
  return passage
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

const COPULAS = ['is', 'are', 'means', 'es', 'son', 'significa'];
const TWO_WORD_COPULAS = ['refers to', 'consiste en'];
const ARTICLES = new Set(['the', 'a', 'an', 'el', 'la', 'los', 'las', 'un', 'una']);
const NOT_SUBJECTS = new Set(
  'it this these those that each every they we you there here if when for while because en si cuando para por esto esta este estos estas eso esa ese cada ello hay'.split(' '),
);

/**
 * "X is …" / "X means …" / "X es …" definitions, with the defined term as written (articles excluded). A simple,
 * documented heuristic; sentences it does not recognise are simply not used for term questions.
 */
export function definitionOf(sentence: string): { subject: string; start: number; end: number } | null {
  const tokens = [...sentence.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’()-]*/gu)].map((m) => ({ word: fold(m[0]), index: m.index! }));
  for (let i = 1; i < Math.min(tokens.length - 1, 8); i += 1) {
    const one = tokens[i]!.word;
    const two = `${one} ${tokens[i + 1]?.word ?? ''}`;
    const length = TWO_WORD_COPULAS.includes(two) ? 2 : COPULAS.includes(one) ? 1 : 0;
    if (!length) continue;
    // "Start where you are means …": the first copula is part of the subject when another follows it.
    if (COPULAS.includes(tokens[i + length]?.word ?? '')) continue;
    const startToken = ARTICLES.has(tokens[0]!.word) ? 1 : 0;
    if (startToken >= i) return null;
    const first = tokens[startToken]!.word;
    const start = tokens[startToken]!.index;
    const end = tokens[i]!.index;
    const subject = sentence.slice(start, end).trim();
    const count = i - startToken;
    if (count > 6 || subject.length < 3 || subject.length > 60 || /[,;:]/.test(subject)) return null;
    // Quoted phrases ("“Registration form tested” is a better …") are examples, not defined terms.
    if (/["“”«»]/.test(sentence.slice(0, end + 1))) return null;
    // A leading gerund without an article ("Running the payroll is …") describes an activity, not a term.
    if (NOT_SUBJECTS.has(first) || NOT_SUBJECTS.has(tokens[0]!.word) || (startToken === 0 && /(ing|ando|iendo)$/.test(first))) return null;
    return { subject, start, end: start + subject.length };
  }
  return null;
}

const EXAMPLE = /\b(for example|for instance|e\.g\.|such as|por ejemplo|como ejemplo|un ejemplo|a modo de ejemplo)\b/i;
export const isExample = (sentence: string) => EXAMPLE.test(sentence);

/** "… are a, b, c and d." or "…: a, b, c, and d." → the listed parts, verbatim; null when it is not a list. */
export function enumeration(sentence: string): string[] | null {
  const colon = sentence.indexOf(':');
  let rest: string | null = null;
  if (colon > 0) rest = sentence.slice(colon + 1);
  else rest = /\b(?:are|is|include|includes|son|es|incluye|incluyen)\s+(.+)$/i.exec(sentence)?.[1] ?? null;
  if (!rest) return null;
  const parts = rest
    .replace(/[.;]\s*$/, '')
    .split(/,\s*/)
    .map((part) => part.replace(/^(?:and|or|y|e|o)\s+/i, '').trim())
    .filter(Boolean);
  return parts.length >= 3 && parts.every((part) => part.length <= 80) ? parts : null;
}

const passagesOf = (material: Material) => splitPassages(material.text);
const firstSentence = (passage: string) => sentences(passage)[0] ?? passage;

type Hit = { material: Material; passage: string; score: number };

/** Passages matching search terms (same rule as the existing tutor: enough distinct terms in one passage). */
export function searchMaterials(materials: Material[], terms: string[]): Hit[] {
  if (!terms.length) return [];
  const needed = minimumMatches(terms);
  const hits: Array<Hit & { order: number; index: number }> = [];
  for (const material of materials) {
    const titleBonus = matchedTerms(material.title, terms) > 0 ? 0.5 : 0;
    passagesOf(material).forEach((passage, index) => {
      const score = matchedTerms(passage, terms);
      if (score >= needed) hits.push({ material, passage, score: score + titleBonus, order: material.order, index });
    });
  }
  return hits.sort((a, b) => b.score - a.score || a.order - b.order || a.index - b.index);
}

// ------------------------------------------------------------------------------------------- free text

const INTENTS: Array<[SuggestedAction, RegExp]> = [
  ['practice', /\b(practi[cs]e|practicar|practica|quiz me|test me|ask me|hazme una pregunta|preguntame|evaluame)\b/],
  ['quiz_prep', /\b(quiz|quizzes|exam|exams|examen|examenes|cuestionario|cuestionarios|prueba)\b/],
  ['summarize', /\b(summar\w*|resum\w*|sintesis|overview)\b/],
  ['simpler', /\b(simpl\w*|easier|plain words|sencill\w*|facil\w*)\b/],
  ['example', /\b(examples?|instance|ejemplos?)\b/],
  ['next', /\b(next|siguiente|what should i study|que (?:debo )?estudiar|que sigue|despues)\b/],
  ['review', /\b(review|revise|repas\w*|key concepts|conceptos clave|important\w*)\b/],
  ['material', /\b(materials?|readings?|lecturas?|recursos?|resources?|where can i (?:find|read))\b/],
  ['again', /\b(again|otra vez|de nuevo|otra forma|another way)\b/],
  ['explain', /\b(explain\w*|explica\w*|what (?:is|are)|que (?:es|son)|define|defin\w*|meaning|significa\w*)\b/],
];
/** Words that only express the request, not the topic (accent-folded). */
const REQUEST_WORDS = new Set(
  'explain explaining explica explicame explicar example examples ejemplo ejemplos summary summarize summarise resumen resume resumir resumeme simpler simple simply sencillo sencilla facil easier plain words practice practise practica practicar quiz quizzes exam exams examen examenes cuestionario cuestionarios prueba review revise repaso repasar next siguiente material materials reading readings lectura lecturas recurso recursos resource resources again otra vez nuevo please favor lesson lessons leccion lecciones topic tema about sobre give dame show muestra muestrame help ayuda ayudame prepare preparing preparar preparo prepara preparame study estudiar estudio concept concepts concepto conceptos more mas want quiero need necesito tell dime what que means meaning significa define definicion important importante importantes key clave claves this esto esta este course curso another instance way forma find where donde read leer test ask hazme pregunta preguntame evaluame'.split(' '),
);

/** Requests about the course or the student's progress, not a topic: leftover words never turn them into a topic search. */
const TOPICLESS: ReadonlySet<SuggestedAction> = new Set(['next', 'quiz_prep', 'again']);

/** Intent and topic of a free-text question: fixed keyword rules (English and Spanish), no model. */
export function resolveQuestion(question: string): { intent: SuggestedAction | null; topicTerms: string[] } {
  const folded = fold(question);
  const intent = INTENTS.find(([, pattern]) => pattern.test(folded))?.[0] ?? null;
  return { intent, topicTerms: searchTerms(question).filter((term) => !REQUEST_WORDS.has(term)) };
}

// ------------------------------------------------------------------------------------------- practice

type Candidate = { kind: 'term' | 'source'; material: Material; sentence: string; answer: string; distractors: string[]; statement: string };

const distinctFold = (values: string[]) => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = fold(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Items after `index` in course order, wrapping around (a fixed, reproducible choice of distractors). */
const cyclicAfter = <T>(items: T[], index: number) => [...items.slice(index + 1), ...items.slice(0, Math.max(0, index))];

type Definition = { material: Material; sentence: string; subject: string; folded: string; start: number; end: number };
/** Definition sentences of one request's materials, extracted once per request (the list is rebuilt for each request). */
const definitionCache = new WeakMap<Material[], Definition[]>();
function definitionsOf(materials: Material[]): Definition[] {
  let definitions = definitionCache.get(materials);
  if (!definitions) {
    definitions = materials.flatMap((m) =>
      passagesOf(m).flatMap((passage) =>
        sentences(passage).flatMap((sentence) => {
          const definition = definitionOf(sentence);
          return definition ? [{ material: m, sentence, folded: fold(definition.subject), ...definition }] : [];
        }),
      ),
    );
    definitionCache.set(materials, definitions);
  }
  return definitions;
}

/**
 * Up to three other defined terms, in course order after this one: terms in the material's own language first, then
 * the others; never the answer itself, a term that appears in the sentence, or a duplicate. Stops once it has enough.
 */
function distractorsFor(definitions: Definition[], index: number): string[] {
  const own = definitions[index]!;
  const sentence = fold(own.sentence);
  const order = cyclicAfter(definitions, index);
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const sameLanguage of [true, false]) {
    for (const other of order) {
      if (picked.length === LIMITS.options - 1) return picked;
      if ((other.material.language === own.material.language) !== sameLanguage) continue;
      if (other.folded === own.folded || seen.has(other.folded) || sentence.includes(other.folded)) continue;
      seen.add(other.folded);
      picked.push(other.subject);
    }
  }
  return picked;
}

/**
 * Practice candidates of one material, in a fixed order. "term" questions blank the defined term of a definition
 * sentence; the other options are terms defined elsewhere in the same course. "source" questions ask which lesson a
 * sentence comes from; the other options are other lesson titles. Questions never come from quizzes.
 */
export function practiceCandidates(material: Material, materials: Material[]): Candidate[] {
  const definitions = definitionsOf(materials);
  const out: Candidate[] = [];
  definitions.forEach((definition, index) => {
    if (definition.material !== material) return;
    const distractors = distractorsFor(definitions, index);
    if (distractors.length >= 2) {
      out.push({
        kind: 'term',
        material,
        sentence: definition.sentence,
        answer: definition.subject,
        distractors,
        statement: `${definition.sentence.slice(0, definition.start)}_____${definition.sentence.slice(definition.end)}`,
      });
    }
  });
  const index = materials.indexOf(material);
  const titles = distinctFold(cyclicAfter(materials, index).map((m) => m.title)).filter((title) => fold(title) !== fold(material.title));
  for (const passage of passagesOf(material)) {
    const sentence = firstSentence(passage);
    if (sentence.length < 40 || sentence.length > 320 || !titles.length) continue;
    out.push({ kind: 'source', material, sentence, answer: material.title, distractors: titles.slice(0, LIMITS.options - 1), statement: sentence });
  }
  return out;
}

const optionsOf = (candidate: Candidate) =>
  [candidate.answer, ...candidate.distractors]
    .sort((a, b) => fold(a).localeCompare(fold(b)) || a.localeCompare(b))
    .map((text, index) => ({ id: 'abcd'[index]!, text }));

/** `<activity id>~<candidate index>~<fingerprint>`: the question is rebuilt on check; the fingerprint proves it is unchanged. */
export const QUESTION_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})~(\d{1,3})~([0-9a-f]{8})$/;
/** Short digest of what the student saw (statement and options), so an answer is never checked against changed material. */
const fingerprint = (candidate: Candidate) => createHash('sha256').update(JSON.stringify([candidate.statement, optionsOf(candidate)])).digest('hex').slice(0, 8);

// ------------------------------------------------------------------------------------------- responses

class Response {
  blocks: Block[] = [];
  references: Reference[] = [];
  grounded = false;
  constructor(readonly language: TutorLanguage) {}

  cite(material: Material): number {
    return this.reference({ activityId: material.activityId, sectionId: material.sectionId, sectionTitle: material.sectionTitle, title: material.title, type: material.type, sourceLanguage: material.language });
  }
  reference(item: Omit<Reference, 'ref' | 'matchesRequestedLanguage'>): number {
    const existing = this.references.find((reference) => reference.activityId === item.activityId);
    if (existing) return existing.ref;
    const ref = this.references.length + 1;
    this.references.push({ ...item, ref, matchesRequestedLanguage: item.sourceLanguage === null || item.sourceLanguage === 'unknown' || item.sourceLanguage === this.language });
    return ref;
  }
  text(text: string) {
    this.blocks.push({ kind: 'text', text, items: [], ref: null, sourceLanguage: null });
  }
  tip(text: string) {
    this.blocks.push({ kind: 'tip', text, items: [], ref: null, sourceLanguage: null });
  }
  quote(text: string, material: Material) {
    this.grounded = true;
    this.blocks.push({ kind: 'quote', text, items: [], ref: this.cite(material), sourceLanguage: material.language });
  }
  /** A list of verbatim fragments of one material (ref) or of several (ref null, each cited separately). */
  list(items: string[], material: Material | null, sourceLanguage: SourceLanguage | null = material?.language ?? null) {
    if (!items.length) return;
    this.grounded = true;
    this.blocks.push({ kind: 'list', text: null, items, ref: material ? this.cite(material) : null, sourceLanguage });
  }
  /** One note when quoted material is in the other language: shown as written, never translated. */
  finish(): void {
    const other = this.references.find((reference) => !reference.matchesRequestedLanguage && (reference.sourceLanguage === 'en' || reference.sourceLanguage === 'es'));
    if (other) this.text(GUIDE_TEXT[this.language].sourceLanguage(other.sourceLanguage as 'en' | 'es'));
  }
}

const FOLLOW_UPS: Record<Exclude<GuideAction, 'ask' | 'start'>, SuggestedAction[]> = {
  explain: ['simpler', 'example', 'detail', 'practice', 'again'],
  again: ['simpler', 'example', 'practice', 'again'],
  summarize: ['explain', 'review', 'practice'],
  simpler: ['example', 'detail', 'practice'],
  example: ['practice', 'explain', 'material'],
  detail: ['simpler', 'example', 'practice'],
  review: ['practice', 'quiz_prep', 'next'],
  next: ['explain', 'practice'],
  practice: ['practice', 'explain', 'material'],
  material: ['explain', 'practice'],
  quiz_prep: ['practice', 'review'],
};

export function suggestionsFor(lesson: Material | null, hasQuizzes: boolean): SuggestedAction[] {
  const base: SuggestedAction[] = lesson
    ? ['explain', 'summarize', 'simpler', 'example', 'practice', 'review', 'material', 'next']
    : ['review', 'summarize', 'practice', 'next', 'material'];
  return hasQuizzes ? [...base, 'quiz_prep'] : base;
}

/** Builds one guided response. Deterministic: the same material, action and variant give the same response. */
export function guide(input: GuideInput): GuideResult {
  const t = GUIDE_TEXT[input.language];
  const response = new Response(input.language);
  const { materials, variant } = input;
  let grounding: Grounding | null = null;
  let practice: PracticeQuestion | null = null;
  let followUps: SuggestedAction[] = input.action === 'start' ? [] : FOLLOW_UPS[input.action];

  // Focus: a topic match wins, then the lesson being studied; course-level otherwise.
  const hits = searchMaterials(materials, input.topicTerms);
  const focus = input.topicTerms.length ? (hits[0]?.material ?? null) : input.lesson;
  if (input.topicTerms.length && !hits.length) return unsupported(input, t, response, t.notFoundTopic);

  if (!materials.length && input.action !== 'next') {
    response.text(t.noMaterial);
    return result(input, response, 'insufficient_material', null, [], null);
  }

  switch (input.action) {
    case 'start': {
      // Variant 0 opens the conversation; a later start (another lesson chosen mid-conversation) only states the context.
      if (variant === 0) response.text(t.greeting(input.courseTitle));
      response.text(input.lesson ? t.lessonContext(input.lesson.title) : t.courseContext);
      if (variant === 0) response.text(t.canDo);
      followUps = suggestionsFor(input.lesson, Boolean(input.quizzes?.length));
      grounding = 'guidance';
      break;
    }
    case 'explain':
    case 'again': {
      if (input.topicTerms.length && hits.length && input.action === 'explain') {
        response.text(t.explainTopic);
        for (const hit of distinctMaterials(hits).slice(0, 2)) response.quote(hit.passage, hit.material);
        break;
      }
      const material = focus ?? materials[0]!;
      const passages = passagesOf(material);
      const index = variant % passages.length;
      response.text(input.action === 'again' ? t.explainAgain(material.title) : t.explain(material.title));
      response.quote(passages[index]!, material);
      break;
    }
    case 'summarize': {
      if (focus) {
        response.text(t.summarize(focus.title));
        response.list(passagesOf(focus).map(firstSentence).slice(0, LIMITS.summary), focus);
      } else {
        response.text(t.summarizeCourse(input.courseTitle));
        courseLines(response, materials, (m) => firstSentence(passagesOf(m)[0] ?? ''));
      }
      break;
    }
    case 'simpler': {
      const material = focus ?? materials[0]!;
      const passages = passagesOf(material);
      const passage = (input.topicTerms.length ? hits[0]?.passage : undefined) ?? passages[variant % passages.length]!;
      const central = sentences(passage).find((sentence) => definitionOf(sentence)) ?? firstSentence(passage);
      response.text(t.simpler);
      response.quote(central, material);
      const parts = enumeration(central);
      if (parts) {
        response.text(t.simplerList(parts.length));
        response.list(parts, material);
      }
      const terms = keyTerms(passage);
      if (terms.length) {
        response.text(t.keyTerms);
        response.list(terms, material);
      }
      break;
    }
    case 'example': {
      const material = focus ?? materials[0]!;
      const own = passagesOf(material).flatMap(sentences).filter(isExample).slice(0, LIMITS.examples);
      if (own.length) {
        response.text(t.example(material.title));
        for (const sentence of own) response.quote(sentence, material);
        break;
      }
      // Another approved material with an example: same section first, then one sharing the material's key terms.
      const terms = keyTerms(material.text).map(fold);
      const others = materials
        .filter((m) => m !== material)
        .sort((a, b) => Number(b.sectionId === material.sectionId) - Number(a.sectionId === material.sectionId) || a.order - b.order);
      const related = others
        .map((m) => ({ m, sentence: passagesOf(m).flatMap(sentences).find((s) => isExample(s) && (m.sectionId === material.sectionId || matchedTerms(s, terms) > 0)) }))
        .find((entry) => entry.sentence);
      if (related?.sentence) {
        response.text(t.exampleElsewhere(related.m.title));
        response.quote(related.sentence, related.m);
      } else {
        response.text(t.noExample);
        response.tip(t.exampleTip);
        grounding = 'guidance';
      }
      break;
    }
    case 'detail': {
      const material = focus ?? materials[0]!;
      response.text(t.detail(material.title));
      for (const passage of passagesOf(material).slice(0, LIMITS.detail)) response.quote(passage, material);
      break;
    }
    case 'review': {
      if (focus) {
        const definitions = passagesOf(focus).flatMap(sentences).filter((sentence) => definitionOf(sentence)).slice(0, LIMITS.review);
        if (definitions.length) {
          response.text(t.review(focus.title));
          response.list(definitions, focus);
        } else {
          response.text(t.reviewNone);
          response.list(passagesOf(focus).map(firstSentence).slice(0, LIMITS.review), focus);
        }
        const terms = keyTerms(focus.text);
        if (terms.length) {
          response.text(t.keyTerms);
          response.list(terms, focus);
        }
      } else {
        response.text(t.reviewCourse(input.courseTitle));
        courseLines(response, materials, (m) => passagesOf(m).flatMap(sentences).find((sentence) => definitionOf(sentence)) ?? firstSentence(passagesOf(m)[0] ?? ''));
      }
      break;
    }
    case 'material': {
      if (input.topicTerms.length) {
        response.text(t.materialTopic);
        for (const hit of distinctMaterials(hits).slice(0, LIMITS.related)) response.cite(hit.material);
      } else {
        response.text(t.material);
        const anchor = focus ?? materials[0]!;
        const terms = keyTerms(anchor.text).map(fold);
        const related = [anchor, ...materials.filter((m) => m !== anchor && m.sectionId === anchor.sectionId), ...materials.filter((m) => m !== anchor && m.sectionId !== anchor.sectionId && matchedTerms(m.text, terms) >= 2)];
        for (const m of distinctBy(related, (m) => m.activityId).slice(0, LIMITS.related)) response.cite(m);
      }
      grounding = 'grounded';
      break;
    }
    case 'next': {
      const next = input.next ?? { kind: 'end' as const };
      if (next.kind === 'activity') {
        const material = materials.find((m) => m.activityId === next.activityId);
        response.reference({ activityId: next.activityId, sectionId: next.sectionId, sectionTitle: next.sectionTitle, title: next.title, type: next.type, sourceLanguage: material?.language ?? null });
        response.text(input.isStudent ? t.nextStudent(next.title, next.sectionTitle) : t.nextStaff(next.title, next.sectionTitle));
        if (material) response.quote(firstSentence(passagesOf(material)[0] ?? ''), material);
        grounding = 'grounded';
      } else if (next.kind === 'done') {
        response.text(t.nextDone);
        if (next.lockedSections) response.text(t.nextLocked);
        followUps = ['review', 'practice'];
        grounding = 'guidance';
      } else {
        response.text(t.nextNone);
        followUps = ['review', 'practice'];
        grounding = 'guidance';
      }
      break;
    }
    case 'practice': {
      const pool = focus ? practiceCandidates(focus, materials) : materials.flatMap((m) => practiceCandidates(m, materials));
      if (!pool.length) {
        response.text(t.practiceNone);
        grounding = 'insufficient_material';
        break;
      }
      const candidate = pool[variant % pool.length]!;
      const own = focus ? pool : practiceCandidates(candidate.material, materials);
      const index = own.findIndex((c) => c.kind === candidate.kind && c.sentence === candidate.sentence);
      const ref = response.cite(candidate.material);
      response.grounded = true;
      response.text(t.practiceNote);
      practice = {
        questionId: `${candidate.material.activityId}~${index}~${fingerprint(candidate)}`,
        kind: candidate.kind,
        prompt: candidate.kind === 'term' ? t.practiceTerm(candidate.material.title) : t.practiceSource,
        statement: candidate.statement,
        options: optionsOf(candidate),
        ref,
      };
      return result(input, response, 'grounded', { activityId: candidate.material.activityId, title: candidate.material.title }, [], practice);
    }
    case 'quiz_prep': {
      const quizzes = input.quizzes ?? [];
      if (!quizzes.length) {
        response.text(t.quizNone);
        response.tip(t.quizTip);
        followUps = ['practice', 'review'];
        grounding = 'guidance';
        break;
      }
      const ordered = focus ? [...quizzes].sort((a, b) => Number(b.sectionId === focus.sectionId) - Number(a.sectionId === focus.sectionId)) : quizzes;
      response.text(t.quizIntro);
      response.list(
        ordered.map((quiz) => t.quizFacts(quiz.title, quiz.questionCount, quiz.attemptLimit, quiz.timeLimitMinutes, quiz.passingScorePercent)),
        null,
        null,
      );
      for (const quiz of ordered) response.reference({ activityId: quiz.activityId, sectionId: quiz.sectionId, sectionTitle: quiz.sectionTitle, title: quiz.title, type: 'quiz', sourceLanguage: null });
      const first = ordered[0]!;
      const lessons = materials.filter((m) => m.sectionId === first.sectionId);
      if (lessons.length) {
        response.text(t.quizLessons(first.title));
        for (const lesson of lessons) response.cite(lesson);
      }
      response.tip(t.quizTip);
      grounding = 'grounded';
      break;
    }
  }
  return result(input, response, grounding, focus ? { activityId: focus.activityId, title: focus.title } : null, followUps, practice);
}

function result(input: GuideInput, response: Response, grounding: Grounding | null, focus: GuideResult['focus'], followUps: SuggestedAction[], practice: PracticeQuestion | null): GuideResult {
  response.finish();
  return {
    action: input.action,
    grounding: grounding ?? (response.grounded ? 'grounded' : 'guidance'),
    variant: input.variant,
    focus,
    blocks: response.blocks,
    references: response.references,
    practice,
    followUps,
  };
}

/** A clear limitation plus what the tutor can do: supported actions and the lessons it can use. */
function unsupported(input: GuideInput, t: GuideText, response: Response, message: string): GuideResult {
  response.text(message);
  for (const material of input.materials.slice(0, LIMITS.courseItems)) response.cite(material);
  return result(input, response, 'insufficient_material', null, suggestionsFor(input.lesson, false), null);
}

/** One line per material ("Title: sentence"), each material cited. */
function courseLines(response: Response, materials: Material[], pick: (m: Material) => string) {
  const chosen = materials.slice(0, LIMITS.courseItems).filter((m) => pick(m));
  for (const m of chosen) response.cite(m);
  const languages = new Set(chosen.map((m) => m.language));
  response.list(
    chosen.map((m) => `${m.title}: ${pick(m)}`),
    null,
    languages.size === 1 ? [...languages][0]! : 'unknown',
  );
}

const distinctBy = <T>(items: T[], key: (item: T) => string) => {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(key(item)) ? false : (seen.add(key(item)), true)));
};
const distinctMaterials = (hits: Hit[]) => distinctBy(hits, (hit) => hit.material.activityId);

/** Free text: a recognised request (optionally about a topic), a topic search, or a clear limitation. */
export function answerQuestion(question: string, input: Omit<GuideInput, 'action' | 'topicTerms'>): GuideResult & { intent: SuggestedAction | null } {
  const { intent, topicTerms } = resolveQuestion(question);
  const t = GUIDE_TEXT[input.language];
  if (intent) return { ...guide({ ...input, action: intent, topicTerms: TOPICLESS.has(intent) ? [] : topicTerms }), intent };
  if (topicTerms.length && searchMaterials(input.materials, topicTerms).length) return { ...guide({ ...input, action: 'explain', topicTerms }), intent: null };
  return { ...unsupported({ ...input, action: 'explain', topicTerms }, t, new Response(input.language), t.unsupported), intent: null };
}

/** Checks a practice answer by rebuilding the question from the current approved material (nothing is stored). */
export function checkPractice(
  questionId: string,
  optionId: string,
  language: TutorLanguage,
  materials: Material[],
): { status: 'correct' | 'incorrect' | 'unavailable'; correctOptionId: string | null; blocks: Block[]; references: Reference[]; followUps: SuggestedAction[]; focus: GuideResult['focus'] } {
  const t = GUIDE_TEXT[language];
  const response = new Response(language);
  const match = QUESTION_ID.exec(questionId);
  const material = match ? materials.find((m) => m.activityId === match[1]) : undefined;
  const candidate = material ? practiceCandidates(material, materials)[Number(match![2])] : undefined;
  // Unavailable when the material is no longer readable or the question changed since it was asked.
  if (!material || !candidate || fingerprint(candidate) !== match![3]) {
    response.text(t.practiceUnavailable);
    return { status: 'unavailable', correctOptionId: null, blocks: response.blocks, references: [], followUps: ['practice'], focus: null };
  }
  const options = optionsOf(candidate);
  const correct = options.find((option) => option.text === candidate.answer)!;
  const chosen = options.find((option) => option.id === optionId);
  const right = chosen?.id === correct.id;
  response.text(right ? t.correct : t.incorrect(chosen?.text ?? optionId));
  response.quote(candidate.sentence, material);
  if (!right) response.text(t.reviewLesson(material.title));
  response.finish();
  return {
    status: right ? 'correct' : 'incorrect',
    correctOptionId: correct.id,
    blocks: response.blocks,
    references: response.references,
    followUps: right ? ['practice', 'explain', 'material'] : ['explain', 'simpler', 'practice'],
    focus: { activityId: material.activityId, title: material.title },
  };
}
