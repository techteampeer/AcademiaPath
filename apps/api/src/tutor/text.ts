/**
 * Deterministic text helpers for lexical retrieval. No language model, translation or stemming:
 * lowercase, accent-insensitive word matching (prefix match, so "incidente" finds "incidentes").
 */

export type SourceLanguage = 'en' | 'es' | 'unknown';

export const TUTOR_LIMITS = {
  question: 500,
  topic: 200,
  maxTerms: 12,
  minTermLength: 3,
  candidateLessons: 5,
  passageChars: 500,
  passagesPerLesson: 40,
  excerptChars: 400,
  citations: 3,
  practicePrompts: 3,
} as const;

/** Characters folded for matching; must stay in sync with the SQL translate() in retrieval. */
export const ACCENTED = 'áàäâéèëêíìïîóòöôúùüûñç';
export const UNACCENTED = 'aaaaeeeeiiiioooouuuunc';

const EN_STOPWORDS = new Set(
  'the a an and or not of to in on at by for with from into about as is are was were be been being this that these those it its what which who whom whose how why when where can could should would will do does did have has had you your yours we our they their there here than then also more most such only very just over under between'.split(' '),
);
const ES_STOPWORDS = new Set(
  'el la los las un una unos unas y o u ni de del al a en con por para sin sobre entre que como cual cuales quien quienes cuyo cuando donde porque pero mas muy ya se su sus lo le les es son ser fue era estan esta este esto estos estas ese esa eso esos esas hay tiene tienen puede pueden qué cómo cuál dónde cuándo por qué'.split(' ').map(fold),
);
/** Words that would be parsed as operators by PostgreSQL text-search parsers. */
const RESERVED = new Set(['and', 'not']);

export function fold(value: string): string {
  let out = '';
  for (const char of value.toLowerCase()) {
    const index = ACCENTED.indexOf(char);
    out += index >= 0 ? UNACCENTED[index] : char;
  }
  return out;
}

/** Common English or Spanish function word (expects accent-folded lowercase input). */
export function isStopword(word: string): boolean {
  return EN_STOPWORDS.has(word) || ES_STOPWORDS.has(word) || RESERVED.has(word);
}

/** Accent-folded lowercase words (letters and digits only). */
export function words(value: string): string[] {
  return fold(value).split(/[^a-z0-9]+/).filter(Boolean);
}

/** Distinct significant search terms from a question or topic: no stopwords, bounded count. */
export function searchTerms(value: string): string[] {
  const terms: string[] = [];
  for (const word of words(value)) {
    if (word.length < TUTOR_LIMITS.minTermLength || EN_STOPWORDS.has(word) || ES_STOPWORDS.has(word) || RESERVED.has(word)) continue;
    if (!terms.includes(word)) terms.push(word);
    if (terms.length === TUTOR_LIMITS.maxTerms) break;
  }
  return terms;
}

/** Number of distinct terms that start a word in the text (prefix match). */
export function matchedTerms(text: string, terms: string[]): number {
  const tokens = words(text);
  return terms.filter((term) => tokens.some((token) => token.startsWith(term))).length;
}

/** Simple, documented heuristic: counts common English vs Spanish function words. */
export function detectLanguage(text: string): SourceLanguage {
  let en = 0;
  let es = 0;
  for (const word of words(text)) {
    if (EN_STOPWORDS.has(word)) en += 1;
    if (ES_STOPWORDS.has(word)) es += 1;
  }
  if (Math.max(en, es) < 2 || en === es) return 'unknown';
  return en > es ? 'en' : 'es';
}

/** Splits lesson text into bounded passages (paragraphs, then sentence groups). Text is never rewritten. */
export function splitPassages(body: string): string[] {
  const passages: string[] = [];
  for (const paragraph of body.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (trimmed.length <= TUTOR_LIMITS.passageChars) {
      passages.push(trimmed);
    } else {
      let current = '';
      for (const sentence of trimmed.split(/(?<=[.!?;:])\s+/)) {
        if (current && current.length + 1 + sentence.length > TUTOR_LIMITS.passageChars) {
          passages.push(current);
          current = '';
        }
        current = current ? `${current} ${sentence}` : sentence;
        while (current.length > TUTOR_LIMITS.passageChars) {
          passages.push(current.slice(0, TUTOR_LIMITS.passageChars));
          current = current.slice(TUTOR_LIMITS.passageChars);
        }
      }
      if (current) passages.push(current);
    }
    if (passages.length >= TUTOR_LIMITS.passagesPerLesson) break;
  }
  return passages.slice(0, TUTOR_LIMITS.passagesPerLesson);
}

/**
 * A verbatim excerpt of at most `excerptChars` characters (plus "…" where shortened), centred on
 * the first matching term. Only shortens; never paraphrases or translates.
 */
export function excerpt(passage: string, terms: string[]): string {
  const max = TUTOR_LIMITS.excerptChars;
  if (passage.length <= max) return passage;
  const folded = fold(passage);
  const hits = terms.map((term) => folded.search(new RegExp(`(^|[^a-z0-9])${term}`))).filter((index) => index >= 0);
  const first = hits.length ? Math.min(...hits) : 0;
  let start = Math.max(0, first - 120);
  if (start > 0) {
    const space = passage.indexOf(' ', start);
    start = space >= 0 && space < first ? space + 1 : start;
  }
  let end = Math.min(passage.length, start + max);
  if (end < passage.length) {
    const space = passage.lastIndexOf(' ', end);
    end = space > start ? space : end;
  }
  return `${start > 0 ? '…' : ''}${passage.slice(start, end).trim()}${end < passage.length ? '…' : ''}`;
}

/** Up to three distinctive words as they appear in the source (for key-term practice prompts). */
export function keyTerms(passage: string): string[] {
  const counts = new Map<string, { word: string; count: number; first: number }>();
  const original = passage.match(/[\p{L}\p{N}]+/gu) ?? [];
  original.forEach((word, index) => {
    const key = fold(word);
    if (key.length < 5 || EN_STOPWORDS.has(key) || ES_STOPWORDS.has(key) || /^\d+$/.test(key)) return;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { word, count: 1, first: index });
  });
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || b.word.length - a.word.length || a.first - b.first)
    .slice(0, 3)
    .map((entry) => entry.word);
}
