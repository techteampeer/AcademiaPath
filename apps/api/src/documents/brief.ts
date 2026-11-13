import type { DocumentExtractionStatus, DocumentFormat, DocumentSegment } from '../db/schema/index.js';
import { definitionOf, enumeration } from '../tutor/guide.js';
import { detectLanguage, fold, keyTerms, type SourceLanguage } from '../tutor/text.js';
import { overlap, sentenceScorer, sentencesOf, type Sentence } from './summary.js';

/*
 * AP-031D study brief: a deterministic, extractive study aid built from a document's already-extracted text (AP-014).
 * Nothing is generated, paraphrased or translated: every overview sentence, concept, excerpt and list item is the
 * document's own wording, with the page, slide or paragraph it comes from (the extraction's own labels; no other
 * location is ever invented). Headings and keywords are selected by fixed rules. The response carries no sentences
 * of its own, so the interface words it in English or Spanish. No model, no network, no database writes.
 */

/** Conservative bounds of one brief. Extraction stores up to 400,000 characters; a brief reads at most these. */
export const BRIEF_LIMITS = {
  characters: 120_000,
  segments: 2_000,
  overview: 2,
  outline: 12,
  keywords: 8,
  concepts: 6,
  excerpts: 6,
  reviewPoints: 6,
  /** Excerpts-only fallback (too little sentence structure for a reliable selection). */
  fallbackBlocks: 8,
  fallbackChars: 400,
  headingChars: 90,
  headingWords: 10,
  /** Fewer sentences or characters than this cannot be condensed reliably. */
  minSentences: 2,
  minCharacters: 150,
} as const;

export type BriefInput = {
  title: string;
  fileName: string;
  format: DocumentFormat;
  extractionStatus: DocumentExtractionStatus;
  extractionDetail: string | null;
  truncated: boolean;
  segments: DocumentSegment[];
};

/** Where a piece of text comes from: the extraction's own block (PDF page, PPTX slide or DOCX paragraph). */
export type BriefReference = { segmentIndex: number; kind: DocumentSegment['kind']; label: string };
export type BriefLanguage = Exclude<SourceLanguage, 'unknown'> | null;
export type BriefStatus = 'complete' | 'partial' | 'excerpts_only' | 'no_text';
export type BriefLimitationCode = 'extraction_truncated' | 'brief_limit' | 'pages_without_text' | 'few_sentences' | 'no_text';
export type BriefLimitation = { code: BriefLimitationCode; processed: number | null; total: number | null };
export type BriefText = { text: string; ref: BriefReference; language: BriefLanguage; shortened: boolean };
export type BriefConcept = { term: string; text: string; ref: BriefReference; language: BriefLanguage };
export type BriefHeading = { text: string; ref: BriefReference };
export type BriefReviewPoint = { kind: 'concept' | 'list' | 'section' | 'excerpt'; term: string | null; items: string[]; ref: BriefReference; language: BriefLanguage };

export type StudyBrief = {
  status: BriefStatus;
  language: { primary: BriefLanguage; mixed: boolean };
  coverage: { processedSegments: number; totalSegments: number; processedCharacters: number; totalCharacters: number };
  overview: BriefText[];
  outline: BriefHeading[];
  outlineTotal: number;
  keywords: string[];
  concepts: BriefConcept[];
  excerpts: BriefText[];
  /**
   * How many excerpts there were to choose from: `excerpts_only`, the text blocks of the processed text (only the
   * first `excerpts.length` are shown); otherwise the distinct sentences the excerpts were selected from.
   */
  excerptsAvailable: number;
  reviewPoints: BriefReviewPoint[];
  limitations: BriefLimitation[];
  cleanup: { repeatedLinesRemoved: number; duplicateSentencesRemoved: number };
};

const reference = (segment: DocumentSegment): BriefReference => ({ segmentIndex: segment.index, kind: segment.kind, label: segment.label });
const normalized = (text: string) => fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
/** The rule by which `sentencesOf` joins a line to the line before it: no sentence end before, lower case after. */
const continuesSentence = (previous: string, line: string) => previous !== '' && !/[.!?:;…]$/.test(previous) && /^[a-záéíóúüñ(]/.test(line);
/** Page numbers and "Page 3 of 10" lines (running footers), in English or Spanish. */
const PAGE_NUMBER = /^(?:(?:page|p[aá]gina|p[aá]g\.?|slide|diapositiva)\s*)?\d{1,4}(?:\s*(?:of|de|\/)\s*\d{1,4})?$/i;
const SENTENCE_END = /[.!?;,…]$/;

/** A short line that reads like a title: no sentence punctuation, few words, starts with a capital or a number. */
export function headingLike(line: string): boolean {
  const text = line.trim();
  if (text.length < 3 || text.length > BRIEF_LIMITS.headingChars || SENTENCE_END.test(text) || PAGE_NUMBER.test(text)) return false;
  if (text.split(/\s+/).length > BRIEF_LIMITS.headingWords) return false;
  return /^[\p{Lu}\d¿¡]/u.test(text) && /\p{L}{2}/u.test(text);
}

/** Whole segments up to the brief's limits; a first segment that alone exceeds them is cut at a sentence end. */
function boundedSegments(segments: DocumentSegment[]) {
  const kept: DocumentSegment[] = [];
  let characters = 0;
  for (const segment of segments) {
    const room = BRIEF_LIMITS.characters - characters;
    if (kept.length >= BRIEF_LIMITS.segments || room <= 0) break;
    if (segment.text.length > room) {
      if (kept.length === 0) {
        const end = Math.max(segment.text.lastIndexOf('. ', room), segment.text.lastIndexOf('.\n', room));
        const text = segment.text.slice(0, end > 0 ? end + 1 : room);
        kept.push({ ...segment, text });
        characters += text.length;
      }
      break;
    }
    kept.push(segment);
    characters += segment.text.length;
  }
  return { kept, characters };
}

/** Lines repeated on at least half of the pages or slides (running headers and footers) and bare page numbers. */
function repeatedLines(format: DocumentFormat, segments: DocumentSegment[]): Set<string> {
  const repeated = new Set<string>();
  if (format === 'docx' || segments.length < 3) return repeated;
  const counts = new Map<string, number>();
  for (const segment of segments) {
    const unique = new Set(segment.text.split('\n').map(normalized).filter((line) => line && line.length <= 120));
    for (const line of unique) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(segments.length / 2));
  for (const [line, count] of counts) if (count >= threshold) repeated.add(line);
  return repeated;
}

/**
 * Consecutive text of one segment under one heading. `cutBefore`/`cutAfter`: a removed line (running header, footer
 * or page number) interrupted a sentence at the block's start or end, so the text there is not a whole sentence.
 */
type Block = { segment: DocumentSegment; section: number; text: string; last: string; cutBefore: boolean; cutAfter: boolean };

/**
 * Splits the text into blocks under detected headings. DOCX: a one-line, title-like paragraph followed by more text.
 * PPTX: a slide's first line when it is title-like. PDF: a title-like line that starts a paragraph and is followed by
 * text on the same page. The document's own title is recognised but not listed as a section.
 * Linear in the number of lines: neighbouring lines are found in one pass each way, never by copying the line list.
 */
function structure(input: BriefInput, segments: DocumentSegment[], removed: Set<string>) {
  const titles = new Set([normalized(input.title), normalized(input.fileName.replace(/\.(pdf|docx|pptx)$/i, ''))]);
  const headings: BriefHeading[] = [];
  const seenHeadings = new Set<string>();
  const blocks: Block[] = [];
  let repeatedLinesRemoved = 0;
  let current: Block | null = null;
  const addHeading = (text: string, segment: DocumentSegment, first: boolean) => {
    const key = normalized(text);
    if (first && titles.has(key)) return true; // the document title, not a section
    if (!seenHeadings.has(key)) {
      seenHeadings.add(key);
      headings.push({ text: text.trim(), ref: reference(segment) });
    }
    current = null;
    return true;
  };
  const sectionIndex = () => headings.length - 1;
  const newBlock = (segment: DocumentSegment, cutBefore: boolean): Block => {
    const block: Block = { segment, section: sectionIndex(), text: '', last: '', cutBefore, cutAfter: false };
    blocks.push(block);
    return block;
  };
  /** `afterRemoved`: a removed line came right before this one. Text is never joined across it into one sentence. */
  const append = (segment: DocumentSegment, line: string, afterRemoved: boolean) => {
    if (!current || current.segment !== segment || current.section !== sectionIndex()) current = newBlock(segment, false);
    else if (afterRemoved && continuesSentence(current.last, line)) {
      current.cutAfter = true;
      current = newBlock(segment, true);
    }
    current.text += `${line}\n`;
    current.last = line;
  };

  segments.forEach((segment, position) => {
    // Lines left after clean-up, each flagged when a removed line came directly before it.
    const lines: string[] = [];
    const afterRemoved: boolean[] = [];
    let removedBefore = false;
    for (const line of segment.text.split('\n')) {
      const key = normalized(line);
      if (key !== '' && (removed.has(key) || PAGE_NUMBER.test(line.trim()))) {
        repeatedLinesRemoved += 1;
        removedBefore = true;
        continue;
      }
      lines.push(line);
      afterRemoved.push(removedBefore);
      removedBefore = false;
    }
    const first = position === 0;
    if (input.format === 'docx') {
      const content = lines.filter((line) => line.trim());
      const isHeading = content.length === 1 && headingLike(content[0]!) && position < segments.length - 1;
      if (isHeading) addHeading(content[0]!, segment, first);
      else lines.forEach((line, index) => append(segment, line, afterRemoved[index]!));
      return;
    }
    // The nearest non-empty line before and after each line: one pass each way (linear, no copies of the list).
    const previous: string[] = new Array<string>(lines.length);
    const next: string[] = new Array<string>(lines.length);
    for (let index = 0, last = ''; index < lines.length; index += 1) {
      previous[index] = last;
      if (lines[index]!.trim()) last = lines[index]!;
    }
    for (let index = lines.length - 1, last = ''; index >= 0; index -= 1) {
      next[index] = last;
      if (lines[index]!.trim()) last = lines[index]!;
    }
    let seenText = false;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) {
        if (current?.segment === segment) append(segment, '', afterRemoved[index]!);
        return;
      }
      const startsParagraph = !seenText || lines[index - 1]?.trim() === '' || /[.!?:;…]$/.test(previous[index]!.trim());
      const isHeading =
        headingLike(trimmed) &&
        (input.format === 'pptx' ? !seenText : startsParagraph && next[index] !== '' && /^[\p{Lu}\d¿¡"“(]/u.test(next[index]!.trim()));
      if (isHeading) addHeading(trimmed, segment, first && !seenText);
      else append(segment, line, afterRemoved[index]!);
      seenText = true;
    });
  });
  return { headings, blocks, repeatedLinesRemoved };
}

type Ranked = Sentence & { section: number; ref: BriefReference; language: BriefLanguage };

const languageOf = (text: string): BriefLanguage => {
  const language = detectLanguage(text);
  return language === 'unknown' ? null : language;
};

/** The longest prefix of a text that fits, cut at a word boundary (marked as shortened). */
function shortened(text: string, limit: number): { text: string; shortened: boolean } {
  const clean = text.replace(/\s*\n\s*/g, ' ').trim();
  if (clean.length <= limit) return { text: clean, shortened: false };
  const cut = clean.lastIndexOf(' ', limit - 1);
  return { text: `${clean.slice(0, cut > limit / 2 ? cut : limit - 1).trimEnd()}…`, shortened: true };
}

/** Builds the study brief of one document from its stored extraction. Deterministic: same input, same brief. */
export function buildStudyBrief(input: BriefInput): StudyBrief {
  const totalSegments = input.segments.length;
  const totalCharacters = input.segments.reduce((total, segment) => total + segment.text.length, 0);
  const empty = (status: BriefStatus, limitations: BriefLimitation[], processedSegments = 0, processedCharacters = 0): StudyBrief => ({
    status,
    language: { primary: null, mixed: false },
    coverage: { processedSegments, totalSegments, processedCharacters, totalCharacters },
    overview: [],
    outline: [],
    outlineTotal: 0,
    keywords: [],
    concepts: [],
    excerpts: [],
    excerptsAvailable: 0,
    reviewPoints: [],
    limitations,
    cleanup: { repeatedLinesRemoved: 0, duplicateSentencesRemoved: 0 },
  });
  if (input.extractionStatus === 'no_text' || totalCharacters === 0) return empty('no_text', [{ code: 'no_text', processed: null, total: null }]);

  // Limits and the extraction's own partial-coverage facts, stated rather than hidden.
  const { kept, characters } = boundedSegments(input.segments);
  const limitations: BriefLimitation[] = [];
  if (input.truncated) limitations.push({ code: 'extraction_truncated', processed: null, total: null });
  if (kept.length < totalSegments || characters < totalCharacters) limitations.push({ code: 'brief_limit', processed: characters, total: totalCharacters });
  const pages = input.format === 'pdf' ? /^(\d+) of (\d+) pages contain selectable text/.exec(input.extractionDetail ?? '') : null;
  if (pages) limitations.push({ code: 'pages_without_text', processed: Number(pages[1]), total: Number(pages[2]) });

  const removed = repeatedLines(input.format, kept);
  const { headings, blocks, repeatedLinesRemoved } = structure(input, kept, removed);

  // Original sentences in document order, without exact repetitions (repeated paragraphs, slides or sections).
  // The two parts of a sentence that a removed line interrupted are not whole sentences, so neither is ever quoted.
  const sentences: Ranked[] = [];
  const seen = new Set<string>();
  let duplicateSentencesRemoved = 0;
  for (const block of blocks) {
    const found = sentencesOf({ ...block.segment, text: block.text.trim() });
    const flat = block.cutBefore || block.cutAfter ? collapse(block.text) : '';
    for (const [index, sentence] of found.entries()) {
      const text = collapse(sentence.text);
      if ((block.cutBefore && index === 0 && flat.startsWith(text)) || (block.cutAfter && index === found.length - 1 && flat.endsWith(text))) continue;
      const key = normalized(sentence.text);
      if (seen.has(key)) {
        duplicateSentencesRemoved += 1;
        continue;
      }
      seen.add(key);
      sentences.push({ ...sentence, order: sentences.length, section: block.section, ref: reference(block.segment), language: languageOf(sentence.text) });
    }
  }

  // Language: per sentence, so documents mixing English and Spanish are recognised as such.
  const counts = { en: 0, es: 0 };
  for (const sentence of sentences) if (sentence.language) counts[sentence.language] += 1;
  const primary: BriefLanguage = counts.en || counts.es ? (counts.en >= counts.es ? 'en' : 'es') : languageOf(kept.map((s) => s.text).join('\n').slice(0, 20_000));
  const minority = Math.min(counts.en, counts.es);
  const language = { primary, mixed: minority >= 2 && minority / (counts.en + counts.es) >= 0.2 };
  const cleanup = { repeatedLinesRemoved, duplicateSentencesRemoved };
  const coverage = { processedSegments: kept.length, totalSegments, processedCharacters: characters, totalCharacters };
  const outline = headings.slice(0, BRIEF_LIMITS.outline);
  const body = blocks.map((block) => block.text).join('\n');

  if (sentences.length < BRIEF_LIMITS.minSentences || body.replace(/\s+/g, ' ').trim().length < BRIEF_LIMITS.minCharacters) {
    // Too little sentence structure to select from reliably: the text itself, block by block, clearly marked. Only the
    // first blocks are shown (`excerptsAvailable` says how many there are); a block that a removed line interrupted
    // mid-sentence is marked "…" on that side, so the two parts are never shown as one continuous quote.
    const textBlocks = blocks.filter((block) => block.text.trim());
    const excerpts = textBlocks.slice(0, BRIEF_LIMITS.fallbackBlocks).map((block) => {
      const short = shortened(block.text, BRIEF_LIMITS.fallbackChars);
      const text = `${block.cutBefore ? '…' : ''}${short.text}${block.cutAfter && !short.shortened ? '…' : ''}`;
      return { text, shortened: short.shortened || block.cutBefore || block.cutAfter, ref: reference(block.segment), language: languageOf(block.text) };
    });
    if (!excerpts.length && !outline.length) return { ...empty('no_text', [...limitations, { code: 'no_text', processed: null, total: null }], kept.length, characters), cleanup };
    return {
      ...empty('excerpts_only', [...limitations, { code: 'few_sentences', processed: sentences.length, total: null }], kept.length, characters),
      language,
      outline,
      outlineTotal: headings.length,
      keywords: keyTerms(body, BRIEF_LIMITS.keywords, 2),
      excerpts,
      excerptsAvailable: textBlocks.length,
      cleanup,
    };
  }

  const score = sentenceScorer(sentences);
  const byScore = (a: Ranked, b: Ranked) => score(b) - score(a) || a.order - b.order;
  const chosen: Ranked[] = [];
  const distinct = (sentence: Ranked) => !chosen.some((other) => other === sentence || overlap(other.terms, sentence.terms) > 0.7);
  const asText = (sentence: Ranked): BriefText => ({ text: sentence.text, ref: sentence.ref, language: sentence.language ?? primary, shortened: false });

  // Overview: the opening sentence and the most central sentence of the document, in document order.
  const overview: Ranked[] = [sentences[0]!];
  chosen.push(sentences[0]!);
  const central = [...sentences].sort(byScore).find(distinct);
  if (central && overview.length < BRIEF_LIMITS.overview) {
    overview.push(central);
    chosen.push(central);
  }
  overview.sort((a, b) => a.order - b.order);

  // Concepts: sentences that define a term ("X is …", "X significa …"), as written.
  const concepts: BriefConcept[] = [];
  const terms = new Set<string>();
  for (const sentence of sentences) {
    if (concepts.length >= BRIEF_LIMITS.concepts) break;
    const definition = definitionOf(sentence.text);
    if (!definition || terms.has(normalized(definition.subject))) continue;
    terms.add(normalized(definition.subject));
    concepts.push({ term: definition.subject, text: sentence.text, ref: sentence.ref, language: sentence.language ?? primary });
    if (!chosen.includes(sentence)) chosen.push(sentence);
  }

  // Key excerpts: the best sentence of each section (or of each part of the document when it has no headings),
  // then the next best overall, never repeating what the overview or concepts already show.
  const excerpts: Ranked[] = [];
  // Concise: about one excerpt per four sentences of the document, two at least, never more than the limit.
  const excerptTarget = Math.min(BRIEF_LIMITS.excerpts, Math.max(2, Math.ceil(sentences.length / 4)));
  const take = (sentence: Ranked | undefined) => {
    if (sentence && excerpts.length < excerptTarget && distinct(sentence)) {
      excerpts.push(sentence);
      chosen.push(sentence);
    }
  };
  if (headings.length >= 2) {
    for (let section = -1; section < headings.length; section += 1) take(sentences.filter((s) => s.section === section).sort(byScore).find(distinct));
  } else {
    const parts = Math.min(excerptTarget, sentences.length);
    for (let part = 0; part < parts; part += 1) {
      take(sentences.slice(Math.floor((part * sentences.length) / parts), Math.floor(((part + 1) * sentences.length) / parts)).sort(byScore).find(distinct));
    }
  }
  for (const sentence of [...sentences].sort(byScore)) take(sentence);
  excerpts.sort((a, b) => a.order - b.order);

  // Review points: selected by rule from the concepts, lists and sections above (the interface words the prompt).
  const fromConcepts: BriefReviewPoint[] = concepts.slice(0, 2).map((concept) => ({ kind: 'concept', term: concept.term, items: [], ref: concept.ref, language: concept.language }));
  const fromLists: BriefReviewPoint[] = [];
  for (const sentence of sentences) {
    if (fromLists.length >= 2) break;
    const items = enumeration(sentence.text);
    if (items) fromLists.push({ kind: 'list', term: null, items, ref: sentence.ref, language: sentence.language ?? primary });
  }
  const fromSections: BriefReviewPoint[] = headings
    .map((heading, index) => ({ heading, index }))
    .filter(({ index }) => sentences.some((sentence) => sentence.section === index))
    .slice(0, 2)
    .map(({ heading }) => ({ kind: 'section', term: heading.text, items: [], ref: heading.ref, language: languageOf(heading.text) ?? primary }));
  const reviewPoints = [...fromConcepts, ...fromLists, ...fromSections];
  for (const concept of concepts.slice(2)) {
    if (reviewPoints.length >= BRIEF_LIMITS.reviewPoints) break;
    reviewPoints.push({ kind: 'concept', term: concept.term, items: [], ref: concept.ref, language: concept.language });
  }
  // Without definitions, lists or sections: re-read and explain the selected excerpts (located, never quoted again).
  for (const excerpt of excerpts) {
    if (reviewPoints.length >= 2) break;
    reviewPoints.push({ kind: 'excerpt', term: null, items: [], ref: excerpt.ref, language: excerpt.language ?? primary });
  }

  return {
    status: limitations.length ? 'partial' : 'complete',
    language,
    coverage,
    overview: overview.map(asText),
    outline,
    outlineTotal: headings.length,
    keywords: keyTerms(sentences.map((sentence) => sentence.text).join('\n'), BRIEF_LIMITS.keywords, 2),
    concepts,
    excerpts: excerpts.map(asText),
    excerptsAvailable: sentences.length,
    reviewPoints: reviewPoints.slice(0, BRIEF_LIMITS.reviewPoints),
    limitations,
    cleanup,
  };
}
