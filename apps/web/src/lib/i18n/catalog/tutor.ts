/**
 * Tutor interface. The interface follows the application language; answers come from the API in the
 * requested response language (fixed mock templates) and quoted lesson text is never translated.
 */
const en = {
  heading: 'Course tutor',
  mock: 'Mock AI — local demonstration',
  mockNote: 'Answers quote approved lessons from this course. No language model or external service is used, and nothing is translated.',
  language: 'Response language',
  askHeading: 'Ask a question',
  question: 'Your question',
  questionHint: (n: number) => `Up to ${n} characters. Do not include personal information.`,
  ask: 'Ask the tutor',
  asking: 'Searching approved lessons…',
  empty: 'Enter a question.',
  response: 'Response',
  insufficient: 'Not enough approved material',
  sources: 'Sources',
  openLesson: 'Open lesson',
  sourceIn: (lang: string) => `Source in ${lang} (original text, not translated)`,
  sourceUnknown: 'Source language not detected',
  practiceHeading: 'Practice prompts',
  topic: 'Topic (optional)',
  suggest: 'Suggest practice prompts',
  suggesting: 'Preparing prompts…',
  noPractice: 'No approved lesson material matches this topic.',
  practiceNote: 'Practice prompts are for self-study only. They are not graded and contain no assessment answers.',
  usage: (used: number, limit: number, minutes: number) => `${used} of ${limit} requests used in the last ${minutes} minutes.`,
  loading: 'Loading tutor…',
  unavailable: 'The tutor is not available to you in this course.',
  langNames: { en: 'English', es: 'Spanish' } as Record<string, string>,
};

export type TutorMessages = typeof en;

const es: TutorMessages = {
  heading: 'Tutor del curso',
  mock: 'IA simulada — demostración local',
  mockNote: 'Las respuestas citan lecciones aprobadas de este curso. No se usa un modelo de lenguaje ni servicios externos, y nada se traduce.',
  language: 'Idioma de la respuesta',
  askHeading: 'Haz una pregunta',
  question: 'Tu pregunta',
  questionHint: (n: number) => `Hasta ${n} caracteres. No incluyas datos personales.`,
  ask: 'Preguntar al tutor',
  asking: 'Buscando en lecciones aprobadas…',
  empty: 'Escribe una pregunta.',
  response: 'Respuesta',
  insufficient: 'No hay material aprobado suficiente',
  sources: 'Fuentes',
  openLesson: 'Abrir lección',
  sourceIn: (lang: string) => `Fuente en ${lang} (texto original, sin traducir)`,
  sourceUnknown: 'Idioma de la fuente no detectado',
  practiceHeading: 'Preguntas de práctica',
  topic: 'Tema (opcional)',
  suggest: 'Sugerir preguntas de práctica',
  suggesting: 'Preparando preguntas…',
  noPractice: 'Ninguna lección aprobada coincide con este tema.',
  practiceNote: 'Las preguntas de práctica son solo para estudiar. No se califican y no contienen respuestas de evaluaciones.',
  usage: (used: number, limit: number, minutes: number) => `${used} de ${limit} solicitudes usadas en los últimos ${minutes} minutos.`,
  loading: 'Cargando tutor…',
  unavailable: 'El tutor no está disponible para ti en este curso.',
  langNames: { en: 'inglés', es: 'español' },
};

export const tutor = { en, es };
