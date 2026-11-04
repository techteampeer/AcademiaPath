import type { SourceLanguage } from './text.js';

export type TutorLanguage = 'en' | 'es';

/**
 * What a provider receives: the question, the requested language and numbered approved excerpts.
 * Never names, emails, user ids, grades, submissions or answer keys. Excerpts are data to quote,
 * never instructions to follow.
 */
export type ProviderSource = { ref: number; title: string; excerpt: string; sourceLanguage: SourceLanguage; keyTerms: string[] };
export type AnswerInput = { question: string; language: TutorLanguage; sources: ProviderSource[] };
export type PracticeInput = { topic: string | null; language: TutorLanguage; sources: ProviderSource[] };
export type PracticePrompt = { ref: number; kind: 'explain' | 'key_terms'; text: string };

/**
 * Inference provider boundary. A real model provider can implement this later without changing
 * the API or the frontend; it must keep citations limited to the provided sources.
 */
export interface TutorProvider {
  readonly mode: 'mock';
  label(language: TutorLanguage): string;
  answer(input: AnswerInput): string;
  practice(input: PracticeInput): PracticePrompt[];
}

const LANGUAGE_NAMES: Record<TutorLanguage, Record<'en' | 'es', string>> = {
  en: { en: 'English', es: 'Spanish' },
  es: { en: 'inglés', es: 'español' },
};

const TEXT = {
  en: {
    label: 'Mock AI — local demonstration',
    intro: 'Mock AI — local demonstration. This response quotes approved lessons from this course; it is not written by a language model.',
    found: (n: number) => `I found ${n} approved ${n === 1 ? 'passage' : 'passages'} related to your question:`,
    from: (title: string) => `From “${title}”`,
    language: (source: 'en' | 'es') => `(Source in ${LANGUAGE_NAMES.en[source]}: original text, not translated.)`,
    outro: 'Read the cited lessons for the full context.',
    insufficient:
      'Mock AI — local demonstration. I could not find approved material in this course that addresses your question, so I cannot answer it. Try other keywords or ask your instructor.',
    practice: 'Practice (mock, not graded)',
    explain: (title: string, quote: string) => `In your own words, explain the main idea of this passage from “${title}”: “${quote}”`,
    terms: (title: string, terms: string[]) => `Using the lesson “${title}”, define these terms: ${terms.join(', ')}.`,
  },
  es: {
    label: 'IA simulada — demostración local',
    intro: 'IA simulada — demostración local. Esta respuesta cita lecciones aprobadas de este curso; no la redacta un modelo de lenguaje.',
    found: (n: number) => `Encontré ${n} ${n === 1 ? 'pasaje aprobado relacionado' : 'pasajes aprobados relacionados'} con tu pregunta:`,
    from: (title: string) => `De «${title}»`,
    language: (source: 'en' | 'es') => `(Fuente en ${LANGUAGE_NAMES.es[source]}: texto original, sin traducir.)`,
    outro: 'Revisa las lecciones citadas para ver el contexto completo.',
    insufficient:
      'IA simulada — demostración local. No encontré material aprobado de este curso que trate tu pregunta, así que no puedo responderla. Prueba con otras palabras clave o consulta a tu docente.',
    practice: 'Práctica (simulada, sin calificación)',
    explain: (title: string, quote: string) => `Explica con tus propias palabras la idea principal de este pasaje de «${title}»: “${quote}”`,
    terms: (title: string, terms: string[]) => `A partir de la lección «${title}», define estos términos: ${terms.join(', ')}.`,
  },
} as const;

const languageNote = (language: TutorLanguage, source: SourceLanguage) =>
  source !== 'unknown' && source !== language ? ` ${TEXT[language].language(source)}` : '';

/** First words of an excerpt, verbatim (shortened with "…"). */
function shortQuote(excerpt: string, max = 160): string {
  if (excerpt.length <= max) return excerpt;
  const cut = excerpt.lastIndexOf(' ', max);
  return `${excerpt.slice(0, cut > 40 ? cut : max).trim()}…`;
}

/**
 * Deterministic mock provider. It only arranges fixed English or Spanish wording around verbatim
 * excerpts it was given; it adds no explanations of its own, invents no references, ignores any
 * instructions inside lesson text, never translates sources, and never grades anything.
 */
export const mockTutorProvider: TutorProvider = {
  mode: 'mock',
  label: (language) => TEXT[language].label,
  answer({ language, sources }) {
    const t = TEXT[language];
    if (!sources.length) return t.insufficient;
    const lines = sources.map((s) => `[${s.ref}] ${t.from(s.title)}: “${s.excerpt}”${languageNote(language, s.sourceLanguage)}`);
    return [t.intro, '', t.found(sources.length), '', ...lines, '', t.outro].join('\n');
  },
  practice({ language, sources }) {
    const t = TEXT[language];
    const prompts: PracticePrompt[] = [];
    for (const s of sources) {
      const note = languageNote(language, s.sourceLanguage);
      prompts.push({ ref: s.ref, kind: 'explain', text: `${t.practice} [${s.ref}]: ${t.explain(s.title, shortQuote(s.excerpt))}${note}` });
      if (s.keyTerms.length >= 2) {
        prompts.push({ ref: s.ref, kind: 'key_terms', text: `${t.practice} [${s.ref}]: ${t.terms(s.title, s.keyTerms)}${note}` });
      }
    }
    return prompts.slice(0, 3);
  },
};
