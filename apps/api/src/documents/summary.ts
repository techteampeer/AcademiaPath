import type { DocumentSegment, DocumentSummaryPoint, DocumentSummaryStatus } from '../db/schema/index.js';
import { isStopword, words } from '../tutor/text.js';

export type SummaryInput = { segments: DocumentSegment[]; revision: number };
export type SummaryOutput = { status: DocumentSummaryStatus; strategy: SummaryStrategy; points: DocumentSummaryPoint[] };
export type SummaryStrategy = 'key_sentences' | 'section_coverage';

/**
 * Summary provider boundary. A real model provider (for example on Google Cloud) can implement this
 * later without changing the API or the frontend: it receives only the document's extracted text and
 * must return points backed by verbatim evidence from that text.
 */
export interface DocumentSummaryProvider {
  readonly id: string;
  readonly mode: 'mock';
  /** Shown with every summary so nobody mistakes it for model output. */
  readonly label: string;
  summarize(input: SummaryInput): Promise<SummaryOutput>;
}

export const SUMMARY_LIMITS = { minSentenceWords: 6, minSentenceChars: 40, maxSentenceChars: 500, pointChars: 200, maxPoints: 5, minPoints: 3 } as const;

type Sentence = { order: number; segmentIndex: number; label: string; text: string; terms: Set<string>; first: boolean };

/**
 * Sentence candidates of one segment. Line breaks inside a sentence (common in PDFs) are joined with a
 * space; nothing else in the text is changed, so every sentence is the original wording.
 */
function sentencesOf(segment: DocumentSegment): Omit<Sentence, 'order'>[] {
  const units: string[] = [];
  for (const line of segment.text.split('\n')) {
    const previous = units.at(-1);
    if (previous !== undefined && !/[.!?:;…]$/.test(previous) && /^[a-záéíóúüñ(]/.test(line)) units[units.length - 1] = `${previous} ${line}`;
    else units.push(line);
  }
  const out: Omit<Sentence, 'order'>[] = [];
  for (const unit of units) {
    for (const raw of unit.split(/(?<=[.!?…])\s+(?=[\p{Lu}¿¡"“(\d])/u)) {
      const text = raw.trim();
      const tokens = words(text);
      if (tokens.length < SUMMARY_LIMITS.minSentenceWords || text.length < SUMMARY_LIMITS.minSentenceChars || text.length > SUMMARY_LIMITS.maxSentenceChars) continue;
      const terms = new Set(tokens.filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !isStopword(token)));
      if (!terms.size) continue;
      out.push({ segmentIndex: segment.index, label: segment.label, text, terms, first: out.length === 0 });
    }
  }
  return out;
}

/** Shortens a sentence for the point text at a word boundary (the evidence keeps the full sentence). */
function shorten(text: string): string {
  if (text.length <= SUMMARY_LIMITS.pointChars) return text;
  const cut = text.lastIndexOf(' ', SUMMARY_LIMITS.pointChars - 1);
  return `${text.slice(0, cut > 60 ? cut : SUMMARY_LIMITS.pointChars - 1).trimEnd()}…`;
}

const overlap = (a: Set<string>, b: Set<string>) => {
  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  return shared / Math.max(1, Math.min(a.size, b.size));
};

/**
 * Deterministic extractive summary (no language model). Sentences are scored by how often their
 * significant words occur across the document; the same text and revision always give the same
 * result. Odd revisions pick the highest-scoring sentences ("key sentences"); even revisions pick the
 * best sentence from each part of the document ("section coverage"), so a refresh shows a different
 * selection. Every point is an original sentence with its page, slide or paragraph reference; the
 * provider never paraphrases, translates or adds facts.
 */
export const mockSummaryProvider: DocumentSummaryProvider = {
  id: 'mock-extractive-v1',
  mode: 'mock',
  label: 'Mock AI summary — local demonstration',
  async summarize({ segments, revision }) {
    const strategy: SummaryStrategy = revision % 2 === 1 ? 'key_sentences' : 'section_coverage';
    const sentences: Sentence[] = segments.flatMap(sentencesOf).map((sentence, order) => ({ ...sentence, order }));
    const characters = segments.reduce((total, segment) => total + segment.text.length, 0);
    if (sentences.length < 2 || characters < 150) return { status: 'insufficient_text', strategy, points: [] };

    const frequency = new Map<string, number>();
    for (const sentence of sentences) for (const term of sentence.terms) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    const score = (sentence: Sentence) => {
      let total = 0;
      for (const term of sentence.terms) total += frequency.get(term) ?? 0;
      return (total / Math.sqrt(sentence.terms.size + 1)) * (sentence.first ? 1.1 : 1);
    };
    const byScore = (a: Sentence, b: Sentence) => score(b) - score(a) || a.order - b.order;
    const target = Math.min(SUMMARY_LIMITS.maxPoints, Math.max(SUMMARY_LIMITS.minPoints, Math.ceil(sentences.length / 6)), sentences.length);

    const chosen: Sentence[] = [];
    const tryAdd = (sentence: Sentence | undefined) => {
      if (sentence && chosen.length < target && !chosen.some((other) => overlap(other.terms, sentence.terms) > 0.7)) chosen.push(sentence);
    };
    if (strategy === 'key_sentences') {
      for (const sentence of [...sentences].sort(byScore)) tryAdd(sentence);
    } else {
      // Split the document into `target` consecutive parts and take the best sentence of each.
      for (let part = 0; part < target; part += 1) {
        const start = Math.floor((part * sentences.length) / target);
        const end = Math.floor(((part + 1) * sentences.length) / target);
        tryAdd(sentences.slice(start, end).sort(byScore)[0]);
      }
    }
    const points = chosen
      .sort((a, b) => a.order - b.order)
      .map((sentence) => ({ text: shorten(sentence.text), evidence: { segmentIndex: sentence.segmentIndex, label: sentence.label, quote: sentence.text } }));
    return points.length ? { status: 'ready', strategy, points } : { status: 'insufficient_text', strategy, points: [] };
  },
};
