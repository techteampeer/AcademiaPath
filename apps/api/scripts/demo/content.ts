/**
 * DEVELOPMENT ONLY: the AcademiaPath demonstration dataset. Every account, text, score and document is
 * synthetic and original (written for this demo); no real student, staff or institutional data.
 */
import type { CourseRole } from '../../src/db/schema/index.js';
import type { SyntheticUser } from '../seed-dev-users.js';
import { demoDocx, demoPdf } from './documents.js';

export const ACCOUNTS = {
  admin: 'admin@academiapath.example',
  instructor: 'instructor@academiapath.example',
  reviewer: 'reviewer@academiapath.example',
  ta: 'ta@academiapath.example',
  student: 'student@academiapath.example',
  learnerA: 'learner.a@academiapath.example',
  learnerB: 'learner.b@academiapath.example',
} as const;
export type Persona = keyof typeof ACCOUNTS;

/** Two extra synthetic learners so gradebooks show more than one student (the other accounts are the dev seed). */
export const DEMO_LEARNERS: ReadonlyArray<SyntheticUser> = [
  { email: ACCOUNTS.learnerA, givenName: 'Demo', familyName: 'Learner A', systemRole: 'user' },
  { email: ACCOUNTS.learnerB, givenName: 'Demo', familyName: 'Learner B', systemRole: 'user' },
];

export const PROGRAMS = [
  { code: 'GTI', name: 'IT Service and Project Management', description: 'Synthetic demo program: IT service management and project delivery.' },
  { code: 'CDIA', name: 'Data Science and Artificial Intelligence', description: 'Synthetic demo program: data, machine learning and responsible AI.' },
] as const;

export const TERMS = [
  { code: '2026-1', name: 'Semestre 2026-1', startsOn: '2026-03-16', endsOn: '2026-07-10' },
  { code: '2026-2', name: 'Semestre 2026-2', startsOn: '2026-08-17', endsOn: '2026-12-11' },
] as const;
export const DEMO_TERM = '2026-2';

/** 23:59 on 4 December 2026 in Lima (UTC-5): inside term 2026-2 and after the demo date. */
const DUE = '2026-12-05T04:59:00.000Z';

export type ReviewTarget = 'approved' | 'submitted' | 'returned' | 'draft';
export type QuestionSpec =
  | { type: 'single_choice' | 'multiple_choice'; prompt: string; points: number; options: Array<{ text: string; correct?: boolean }> }
  | { type: 'true_false'; prompt: string; points: number; answer: boolean };
export type ActivitySpec = { title: string; state: ReviewTarget; returnComment?: string } & (
  | { kind: 'page'; body: string }
  | { kind: 'link'; url: string; description: string }
  | { kind: 'quiz'; instructions: string; attemptLimit: number; timeLimitMinutes: number | null; questions: QuestionSpec[] }
  | { kind: 'assignment'; instructions: string; dueAt: string; rubric: Array<{ title: string; maxPoints: number; description?: string }> }
  | { kind: 'document'; fileName: string; build: () => Buffer }
);
export type SectionSpec = { title: string; visible: boolean; activities: ActivitySpec[] };
/** Student work driven through the API in order; each step is skipped when it is already done. */
export type StudentAction =
  | { kind: 'quiz'; student: Persona; quiz: string; answers: Record<string, string[]> }
  | { kind: 'submit'; student: Persona; assignment: string; body: string }
  | { kind: 'grade'; grader: Persona; student: Persona; assignment: string; scores: number[]; feedback: string }
  | { kind: 'release'; grader: Persona; activity: string; whenNotReleasedFor: Persona };
export type CourseSpec = {
  code: string;
  title: string;
  status: 'published' | 'draft';
  program: string;
  subject: { code: string; title: string; description: string };
  enrollments: Array<{ persona: Persona; role: CourseRole }>;
  sections: SectionSpec[];
  actions: StudentAction[];
};

// ------------------------------------------------------------------------------------------- ITIL

const ITIL_QUIZ = 'Module check: ITIL 4 foundations';
const ITIL_ESSAY = 'Mapping a service to the value chain';
const itil: CourseSpec = {
  code: 'ITIL4-F-2026-2-A',
  title: 'ITIL 4 Foundation',
  status: 'published',
  program: 'GTI',
  subject: { code: 'ITIL4-F', title: 'ITIL 4 Foundation', description: 'Service management concepts, the service value system and key practices.' },
  enrollments: [
    { persona: 'instructor', role: 'instructor' },
    { persona: 'reviewer', role: 'design_team' },
    { persona: 'ta', role: 'non_editing_instructor' },
    { persona: 'student', role: 'student' },
    { persona: 'learnerA', role: 'student' },
    { persona: 'learnerB', role: 'student' },
  ],
  sections: [
    {
      title: 'Module 1 - Service management concepts',
      visible: true,
      activities: [
        {
          kind: 'page',
          title: 'Value, outcomes, costs and risks',
          state: 'approved',
          body: [
            'Service management is a set of organizational capabilities for enabling value for customers in the form of services.',
            'Value is the perceived benefit, usefulness and importance of something. It is always co-created: the provider and the consumer both contribute, for example when a student uses a campus Wi-Fi service to submit coursework on time.',
            'An outcome is a result for a stakeholder enabled by one or more outputs. A service should help consumers achieve outcomes they care about while removing some costs and risks from them, and it may also introduce new costs and risks that must be managed.',
          ].join('\n\n'),
        },
        {
          kind: 'link',
          title: 'Reading: ITIL overview',
          state: 'approved',
          url: 'https://en.wikipedia.org/wiki/ITIL',
          description: 'Background reading on the history and structure of ITIL. Optional.',
        },
      ],
    },
    {
      title: 'Module 2 - The service value system',
      visible: true,
      activities: [
        {
          kind: 'page',
          title: 'The four dimensions of service management',
          state: 'approved',
          body: [
            'The four dimensions of service management are organizations and people, information and technology, partners and suppliers, and value streams and processes.',
            'Each dimension should be considered for every service. A new self-service portal for library loans, for instance, needs trained staff, a reliable catalogue system, an agreement with the hosting supplier and a clear workflow for reservations.',
            'Ignoring one dimension usually leads to a service that works on paper but fails in practice.',
          ].join('\n\n'),
        },
        {
          kind: 'page',
          title: 'Guiding principles in practice',
          state: 'approved',
          body: [
            'The guiding principles are recommendations that can guide an organization in all circumstances: focus on value, start where you are, progress iteratively with feedback, collaborate and promote visibility, think and work holistically, keep it simple and practical, and optimize and automate.',
            'Start where you are means assessing what already exists before building something new. Many improvement initiatives fail because they ignore useful practices and tools that the team already has.',
            'Progress iteratively with feedback means organizing work into small, manageable sections that can be completed in a timely manner, using feedback before, during and after each iteration.',
          ].join('\n\n'),
        },
        {
          kind: 'document',
          title: 'Service value chain overview',
          state: 'approved',
          fileName: 'service-value-chain-overview.pdf',
          build: () =>
            demoPdf('Service value chain overview', [
              [
                'The service value chain is an operating model that describes the key activities required to respond to demand and facilitate value realization.',
                'It has six value chain activities: plan, improve, engage, design and transition, obtain or build, and deliver and support.',
                'Plan ensures a shared understanding of the vision, current status and improvement direction for all four dimensions and all products and services.',
                'Engage provides a good understanding of stakeholder needs, transparency and continual engagement with all stakeholders.',
              ],
              [
                'Value streams combine value chain activities in a specific order to respond to a particular type of demand.',
                'A value stream for restoring a failed online enrolment service would start with engage, move through deliver and support, and use improve to prevent recurrence.',
                'Improvement should be continual: every value stream should be reviewed with the people who operate it.',
              ],
            ]),
        },
      ],
    },
    {
      title: 'Module 3 - Practices and continual improvement',
      visible: true,
      activities: [
        {
          kind: 'page',
          title: 'Incident and problem management',
          state: 'approved',
          body: [
            'An incident is an unplanned interruption to a service or a reduction in the quality of a service. Incident management aims to minimize the negative impact of incidents by restoring normal service operation as quickly as possible.',
            'A problem is a cause, or potential cause, of one or more incidents. Problem management reduces the likelihood and impact of incidents by identifying actual and potential causes and managing workarounds and known errors.',
            'Keeping the two practices separate helps teams restore service quickly while still investigating why the incident happened.',
          ].join('\n\n'),
        },
        {
          kind: 'quiz',
          title: ITIL_QUIZ,
          state: 'approved',
          instructions: 'Three questions on modules 1 to 3. The server grades each attempt; results appear after your instructor releases them.',
          attemptLimit: 2,
          timeLimitMinutes: 30,
          questions: [
            {
              type: 'single_choice',
              prompt: 'Which ITIL 4 component describes how all components and activities of an organization work together to facilitate value creation?',
              points: 1,
              options: [{ text: 'The service value system', correct: true }, { text: 'The service desk' }, { text: 'The configuration management system' }, { text: 'The service level agreement' }],
            },
            {
              type: 'multiple_choice',
              prompt: 'Which of the following are ITIL 4 guiding principles? Select all that apply.',
              points: 2,
              options: [{ text: 'Focus on value', correct: true }, { text: 'Start where you are', correct: true }, { text: 'Keep it simple and practical', correct: true }, { text: 'Automate everything first' }],
            },
            { type: 'true_false', prompt: 'An incident is the cause, or potential cause, of one or more problems.', points: 1, answer: false },
          ],
        },
        {
          kind: 'assignment',
          title: ITIL_ESSAY,
          state: 'approved',
          instructions:
            'Choose one service you use at the university (for example the virtual campus or the library loan service). In 300 to 500 words, describe how the six value chain activities contribute to it and propose one improvement.',
          dueAt: DUE,
          rubric: [
            { title: 'Analysis of the value chain', maxPoints: 6, description: 'Each activity is described accurately for the chosen service.' },
            { title: 'Use of ITIL concepts', maxPoints: 4, description: 'Correct use of value, outcomes and guiding principles.' },
          ],
        },
        {
          kind: 'page',
          title: 'Change enablement',
          state: 'submitted',
          body: [
            'Change enablement maximizes the number of successful service and product changes by ensuring that risks are properly assessed, authorizing changes to proceed and managing the change schedule.',
            'Standard changes are low-risk, pre-authorized changes that are well understood. Normal changes need assessment and authorization by a change authority, and emergency changes must be implemented as soon as possible.',
          ].join('\n\n'),
        },
      ],
    },
    {
      title: 'Instructor notes',
      visible: false,
      activities: [
        {
          kind: 'page',
          title: 'Facilitator notes for module 2',
          state: 'draft',
          body: 'Use the library loan example to discuss the four dimensions. Ask groups to map one dimension each and report back in five minutes.',
        },
      ],
    },
  ],
  actions: [
    {
      kind: 'quiz',
      student: 'learnerA',
      quiz: ITIL_QUIZ,
      answers: {
        'Which ITIL 4 component describes how all components and activities of an organization work together to facilitate value creation?': ['The service value system'],
        'Which of the following are ITIL 4 guiding principles? Select all that apply.': ['Focus on value', 'Start where you are', 'Keep it simple and practical'],
        'An incident is the cause, or potential cause, of one or more problems.': ['False'],
      },
    },
    {
      kind: 'submit',
      student: 'learnerA',
      assignment: ITIL_ESSAY,
      body: 'I chose the virtual campus. Engage covers the help channels where students report needs; plan sets the semester priorities; design and transition prepares new course spaces; obtain or build configures the platform; deliver and support keeps it running during exams; improve reviews incident trends. Improvement: publish a short status page during peak weeks.',
    },
    { kind: 'grade', grader: 'ta', student: 'learnerA', assignment: ITIL_ESSAY, scores: [5, 3], feedback: 'Clear mapping of the activities. Explain the improvement with an expected outcome.' },
    { kind: 'release', grader: 'instructor', activity: ITIL_QUIZ, whenNotReleasedFor: 'learnerA' },
    { kind: 'release', grader: 'instructor', activity: ITIL_ESSAY, whenNotReleasedFor: 'learnerA' },
    {
      kind: 'quiz',
      student: 'learnerB',
      quiz: ITIL_QUIZ,
      answers: {
        'Which ITIL 4 component describes how all components and activities of an organization work together to facilitate value creation?': ['The service value system'],
        'Which of the following are ITIL 4 guiding principles? Select all that apply.': ['Focus on value', 'Start where you are'],
        'An incident is the cause, or potential cause, of one or more problems.': ['True'],
      },
    },
    {
      kind: 'submit',
      student: 'learnerB',
      assignment: ITIL_ESSAY,
      body: 'The library loan service: engage happens at the front desk and online form, deliver and support handles loans and returns, and improve could add reminder messages before due dates.',
    },
  ],
};

// ----------------------------------------------------------------------------- Project management

const PM_QUIZ = 'Planning essentials check';
const PM_CHARTER = 'Draft a one-page project charter';
const pm: CourseSpec = {
  code: 'PMF-2026-2-A',
  title: 'Project Management Fundamentals',
  status: 'published',
  program: 'GTI',
  subject: { code: 'PMF', title: 'Project Management Fundamentals', description: 'Project lifecycle, planning, scheduling, risk and stakeholder management.' },
  enrollments: [
    { persona: 'instructor', role: 'instructor' },
    { persona: 'reviewer', role: 'design_team' },
    { persona: 'ta', role: 'non_editing_instructor' },
    { persona: 'student', role: 'student' },
    { persona: 'learnerA', role: 'student' },
  ],
  sections: [
    {
      title: 'Unit 1 - Projects and the project lifecycle',
      visible: true,
      activities: [
        {
          kind: 'page',
          title: 'What makes work a project',
          state: 'approved',
          body: [
            'A project is a temporary endeavour undertaken to create a unique product, service or result. Temporary means it has a defined beginning and end; unique means the result differs in some way from previous work.',
            'Operations, by contrast, are ongoing and repetitive. Running the weekly payroll is an operation, while replacing the payroll system is a project.',
            'Most projects move through initiating, planning, executing, monitoring and controlling, and closing. These phases overlap and are revisited as the project learns.',
          ].join('\n\n'),
        },
        {
          kind: 'link',
          title: 'Reading: Project management overview',
          state: 'approved',
          url: 'https://en.wikipedia.org/wiki/Project_management',
          description: 'Background reading on approaches and history of project management. Optional.',
        },
      ],
    },
    {
      title: 'Unit 2 - Planning: scope, schedule and cost',
      visible: true,
      activities: [
        {
          kind: 'page',
          title: 'Defining scope with a work breakdown structure',
          state: 'approved',
          body: [
            'A work breakdown structure (WBS) decomposes the total scope of the project into smaller, manageable deliverables called work packages.',
            'The WBS should describe outcomes rather than actions. "Registration form tested" is a better work package than "test the form", because it states what will exist when the work is done.',
            'The 100 percent rule says the WBS includes all of the work defined by the project scope and nothing outside it.',
          ].join('\n\n'),
        },
        {
          kind: 'page',
          title: 'Building a schedule and the critical path',
          state: 'approved',
          body: [
            'A schedule sequences the activities needed to produce the work packages and estimates how long each one takes.',
            'The critical path is the longest sequence of dependent activities through the network. Activities on the critical path have zero total float, so any delay to them delays the whole project.',
            'Managers protect the critical path by watching its activities closely and by adding buffers where estimates are uncertain.',
          ].join('\n\n'),
        },
        {
          kind: 'document',
          title: 'Project charter guide',
          state: 'approved',
          fileName: 'project-charter-guide.docx',
          build: () =>
            demoDocx('Project charter guide', [
              'A project charter formally authorizes a project and gives the project manager authority to use organizational resources.',
              '## What to include',
              'A good charter states the business need, measurable objectives, high-level scope, key stakeholders, major milestones, summary budget and known risks.',
              'Objectives should be specific and measurable, for example reducing the average enrolment processing time from five days to two days by the end of the term.',
              '## Common mistakes',
              'Charters that list tasks instead of outcomes, or that omit who approves the project, make later decisions difficult.',
            ]),
        },
        {
          kind: 'page',
          title: 'Earned value basics',
          state: 'returned',
          returnComment: 'Please add a worked example with planned value, earned value and actual cost before resubmitting.',
          body: 'Earned value management compares planned value, earned value and actual cost to measure schedule and cost performance.',
        },
      ],
    },
    {
      title: 'Unit 3 - Risk, stakeholders and closure',
      visible: true,
      activities: [
        {
          kind: 'page',
          title: 'Identifying and responding to risk',
          state: 'approved',
          body: [
            'A risk is an uncertain event or condition that, if it occurs, has a positive or negative effect on one or more project objectives.',
            'Teams record risks in a risk register with their probability, impact, owner and planned response. Responses to threats include avoiding, transferring, mitigating and accepting the risk.',
            'Risk management is continuous: the register is reviewed at every status meeting, and new risks are added as soon as they are noticed.',
          ].join('\n\n'),
        },
        {
          kind: 'quiz',
          title: PM_QUIZ,
          state: 'approved',
          instructions: 'Three questions on planning. One attempt; the server grades it.',
          attemptLimit: 1,
          timeLimitMinutes: null,
          questions: [
            {
              type: 'single_choice',
              prompt: 'What is the main purpose of a work breakdown structure?',
              points: 1,
              options: [
                { text: 'To decompose the project scope into manageable deliverables', correct: true },
                { text: 'To record the salaries of team members' },
                { text: 'To list lessons learned after closure' },
                { text: 'To store stakeholder contact details' },
              ],
            },
            {
              type: 'multiple_choice',
              prompt: 'Which items usually appear in a project charter? Select all that apply.',
              points: 2,
              options: [{ text: 'Measurable objectives', correct: true }, { text: 'High-level scope', correct: true }, { text: 'Key stakeholders', correct: true }, { text: 'Daily timesheets' }],
            },
            { type: 'true_false', prompt: 'Activities on the critical path have zero total float.', points: 1, answer: true },
          ],
        },
        {
          kind: 'assignment',
          title: PM_CHARTER,
          state: 'approved',
          instructions: 'Write a one-page charter for a small campus project of your choice (for example a peer tutoring program). Use the structure from the charter guide.',
          dueAt: DUE,
          rubric: [
            { title: 'Completeness', maxPoints: 5, description: 'All charter elements are present.' },
            { title: 'Clarity of objectives', maxPoints: 3, description: 'Objectives are specific and measurable.' },
            { title: 'Feasibility', maxPoints: 2, description: 'Scope, milestones and budget are realistic.' },
          ],
        },
      ],
    },
    {
      title: 'Instructor notes',
      visible: false,
      activities: [{ kind: 'page', title: 'Critical path classroom exercise', state: 'draft', body: 'Draw a six-activity network on the board and let groups compute early and late start times.' }],
    },
  ],
  actions: [
    {
      kind: 'quiz',
      student: 'student',
      quiz: PM_QUIZ,
      answers: {
        'What is the main purpose of a work breakdown structure?': ['To decompose the project scope into manageable deliverables'],
        'Which items usually appear in a project charter? Select all that apply.': ['Measurable objectives', 'High-level scope', 'Key stakeholders'],
        'Activities on the critical path have zero total float.': ['False'],
      },
    },
    {
      kind: 'submit',
      student: 'student',
      assignment: PM_CHARTER,
      body: 'Project: peer tutoring for first-year mathematics. Objective: 80 percent of participating students pass the midterm. Scope: weekly sessions, tutor training and a feedback survey. Stakeholders: tutors, students, the mathematics department. Milestones: training in week 2, sessions from week 3, report in week 15. Budget: snacks and printed guides.',
    },
    { kind: 'grade', grader: 'ta', student: 'student', assignment: PM_CHARTER, scores: [4, 3, 2], feedback: 'Strong objectives. Add the approval authority and two risks.' },
    { kind: 'release', grader: 'instructor', activity: PM_CHARTER, whenNotReleasedFor: 'student' },
    { kind: 'release', grader: 'instructor', activity: PM_QUIZ, whenNotReleasedFor: 'student' },
    {
      kind: 'submit',
      student: 'learnerA',
      assignment: PM_CHARTER,
      body: 'Project: a reusable cup program for the cafeteria. Objective: reduce disposable cups by 50 percent in one term. Stakeholders: cafeteria staff, student council and suppliers.',
    },
    { kind: 'grade', grader: 'ta', student: 'learnerA', assignment: PM_CHARTER, scores: [3, 2, 2], feedback: 'Add milestones and a summary budget.' },
  ],
};

// -------------------------------------------------------------------------- Artificial intelligence

const AI_QUIZ = 'Control de lectura: aprendizaje automático';
const AI_ESSAY = 'Propuesta de uso responsable de IA';
const ai: CourseSpec = {
  code: 'IAI-2026-2-A',
  title: 'Introduction to Artificial Intelligence',
  status: 'published',
  program: 'CDIA',
  subject: { code: 'IAI', title: 'Introduction to Artificial Intelligence', description: 'Conceptos de IA, aprendizaje automático, evaluación de modelos y uso responsable.' },
  enrollments: [
    { persona: 'instructor', role: 'instructor' },
    { persona: 'reviewer', role: 'design_team' },
    { persona: 'student', role: 'student' },
    { persona: 'learnerB', role: 'student' },
    // The teaching assistant of the other two courses is a student here: one person, different roles per course.
    { persona: 'ta', role: 'student' },
  ],
  sections: [
    {
      title: 'Unidad 1 - ¿Qué es la inteligencia artificial?',
      visible: true,
      activities: [
        {
          kind: 'page',
          title: 'Inteligencia artificial: definiciones y alcance',
          state: 'approved',
          body: [
            'La inteligencia artificial es el campo que estudia cómo construir sistemas capaces de realizar tareas que normalmente requieren inteligencia humana, como reconocer patrones, tomar decisiones o comprender el lenguaje.',
            'Conviene distinguir entre sistemas basados en reglas, escritas explícitamente por personas, y sistemas que aprenden patrones a partir de datos.',
            'Un sistema de IA siempre debe evaluarse en el contexto en que se usa: el mismo modelo puede ser útil para recomendar lecturas y riesgoso para decidir becas.',
          ].join('\n\n'),
        },
        {
          kind: 'link',
          title: 'Lectura: Inteligencia artificial',
          state: 'approved',
          url: 'https://es.wikipedia.org/wiki/Inteligencia_artificial',
          description: 'Lectura de contexto sobre la historia y las ramas de la IA. Opcional.',
        },
      ],
    },
    {
      title: 'Unidad 2 - Aprendizaje automático',
      visible: true,
      activities: [
        {
          kind: 'page',
          title: 'Aprendizaje supervisado y no supervisado',
          state: 'approved',
          body: [
            'En el aprendizaje supervisado el modelo aprende a partir de ejemplos etiquetados, por ejemplo correos marcados como deseados o no deseados.',
            'En el aprendizaje no supervisado no hay etiquetas: el modelo busca estructuras en los datos, como grupos de estudiantes con hábitos de estudio parecidos.',
            'Elegir el tipo de aprendizaje depende de la pregunta y de los datos disponibles, no de la técnica de moda.',
          ].join('\n\n'),
        },
        {
          kind: 'page',
          title: 'Datos de entrenamiento y evaluación de modelos',
          state: 'approved',
          body: [
            'Para evaluar un modelo de forma honesta se separan los datos en un conjunto de entrenamiento y otro de prueba que el modelo nunca vio.',
            'La exactitud global puede ocultar errores importantes. Por eso también se revisan la precisión, la exhaustividad y el desempeño por grupo de usuarios.',
            'Si un modelo funciona bien con los datos de entrenamiento pero mal con datos nuevos, probablemente está sobreajustado.',
          ].join('\n\n'),
        },
        {
          kind: 'document',
          title: 'Guía de evaluación de modelos',
          state: 'approved',
          fileName: 'guia-evaluacion-modelos.pdf',
          build: () =>
            demoPdf('Guía de evaluación de modelos', [
              [
                'Esta guía resume los pasos básicos para evaluar un modelo de clasificación antes de usarlo en un servicio universitario.',
                'Primero se define la pregunta que el modelo debe responder y el costo de cada tipo de error.',
                'Luego se separan los datos en entrenamiento, validación y prueba, y se registra de dónde proviene cada conjunto.',
              ],
              [
                'La matriz de confusión muestra cuántos casos se clasificaron correctamente y qué errores se cometieron.',
                'Además de la exactitud, se deben revisar la precisión y la exhaustividad para cada grupo relevante de usuarios.',
                'Finalmente se documentan las limitaciones conocidas y se define quién revisará el modelo de forma periódica.',
              ],
            ]),
        },
      ],
    },
    {
      title: 'Unidad 3 - IA responsable',
      visible: true,
      activities: [
        {
          kind: 'page',
          title: 'Sesgo, transparencia y uso responsable',
          state: 'approved',
          body: [
            'Un sistema de IA puede reproducir sesgos presentes en los datos con los que fue entrenado. Por eso se analiza su desempeño para distintos grupos.',
            'La transparencia implica explicar a las personas afectadas cuándo se usa un sistema automatizado y cómo pueden solicitar una revisión humana.',
            'El uso responsable también exige proteger los datos personales y limitar el uso del sistema al propósito para el que fue evaluado.',
          ].join('\n\n'),
        },
        {
          kind: 'quiz',
          title: AI_QUIZ,
          state: 'approved',
          instructions: 'Tres preguntas sobre la unidad 2. El servidor califica cada intento.',
          attemptLimit: 2,
          timeLimitMinutes: null,
          questions: [
            {
              type: 'single_choice',
              prompt: '¿Qué tipo de aprendizaje usa ejemplos etiquetados para entrenar un modelo?',
              points: 1,
              options: [{ text: 'Aprendizaje supervisado', correct: true }, { text: 'Aprendizaje no supervisado' }, { text: 'Aprendizaje por refuerzo' }, { text: 'Ninguno de los anteriores' }],
            },
            {
              type: 'multiple_choice',
              prompt: '¿Cuáles de estas prácticas ayudan a evaluar un modelo de forma honesta? Selecciona todas las que correspondan.',
              points: 2,
              options: [
                { text: 'Separar datos de entrenamiento y de prueba', correct: true },
                { text: 'Medir el desempeño con datos no vistos', correct: true },
                { text: 'Evaluar solo con los datos de entrenamiento' },
                { text: 'Revisar los errores por grupo de usuarios', correct: true },
              ],
            },
            { type: 'true_false', prompt: 'Un modelo con alta exactitud global no puede tener sesgos contra un grupo específico.', points: 1, answer: false },
          ],
        },
        {
          kind: 'assignment',
          title: AI_ESSAY,
          state: 'approved',
          instructions: 'Propón un uso de IA para un servicio de la universidad (300 a 500 palabras). Describe los datos, cómo evaluarías el modelo y qué medidas de uso responsable aplicarías.',
          dueAt: DUE,
          rubric: [
            { title: 'Análisis del caso', maxPoints: 5 },
            { title: 'Evaluación y ética', maxPoints: 3 },
            { title: 'Redacción', maxPoints: 2 },
          ],
        },
        {
          kind: 'page',
          title: 'Redes neuronales: intuición básica',
          state: 'submitted',
          body: 'Una red neuronal combina muchas unidades simples organizadas en capas. Cada conexión tiene un peso que se ajusta durante el entrenamiento para reducir el error.',
        },
      ],
    },
    {
      title: 'Notas docentes',
      visible: false,
      activities: [{ kind: 'page', title: 'Notas para la sesión de sesgo', state: 'draft', body: 'Usar el ejemplo de becas para discutir errores por grupo. Pedir a cada equipo una medida de mitigación.' }],
    },
  ],
  actions: [
    {
      kind: 'quiz',
      student: 'learnerB',
      quiz: AI_QUIZ,
      answers: {
        '¿Qué tipo de aprendizaje usa ejemplos etiquetados para entrenar un modelo?': ['Aprendizaje supervisado'],
        '¿Cuáles de estas prácticas ayudan a evaluar un modelo de forma honesta? Selecciona todas las que correspondan.': [
          'Separar datos de entrenamiento y de prueba',
          'Medir el desempeño con datos no vistos',
          'Revisar los errores por grupo de usuarios',
        ],
        'Un modelo con alta exactitud global no puede tener sesgos contra un grupo específico.': ['False'],
      },
    },
    {
      kind: 'submit',
      student: 'learnerB',
      assignment: AI_ESSAY,
      body: 'Propongo un asistente que sugiera lecturas complementarias según el curso. Los datos serían los sílabos y préstamos anónimos de la biblioteca. Evaluaría con datos de un semestre no usado en el entrenamiento y revisaría el desempeño por facultad. Mostraría siempre que es una recomendación automática.',
    },
    { kind: 'grade', grader: 'instructor', student: 'learnerB', assignment: AI_ESSAY, scores: [4, 3, 2], feedback: 'Buena propuesta. Detalla cómo protegerías los datos de préstamos.' },
    { kind: 'release', grader: 'instructor', activity: AI_ESSAY, whenNotReleasedFor: 'learnerB' },
    { kind: 'release', grader: 'instructor', activity: AI_QUIZ, whenNotReleasedFor: 'learnerB' },
    {
      kind: 'quiz',
      student: 'student',
      quiz: AI_QUIZ,
      answers: {
        '¿Qué tipo de aprendizaje usa ejemplos etiquetados para entrenar un modelo?': ['Aprendizaje supervisado'],
        '¿Cuáles de estas prácticas ayudan a evaluar un modelo de forma honesta? Selecciona todas las que correspondan.': [
          'Separar datos de entrenamiento y de prueba',
          'Medir el desempeño con datos no vistos',
        ],
        'Un modelo con alta exactitud global no puede tener sesgos contra un grupo específico.': ['False'],
      },
    },
    {
      kind: 'quiz',
      student: 'ta',
      quiz: AI_QUIZ,
      answers: {
        '¿Qué tipo de aprendizaje usa ejemplos etiquetados para entrenar un modelo?': ['Aprendizaje no supervisado'],
        '¿Cuáles de estas prácticas ayudan a evaluar un modelo de forma honesta? Selecciona todas las que correspondan.': ['Separar datos de entrenamiento y de prueba'],
        'Un modelo con alta exactitud global no puede tener sesgos contra un grupo específico.': ['False'],
      },
    },
  ],
};

// ------------------------------------------------------------------------------- Draft offering

/** A second, unpublished offering of the ITIL subject: staff see it, students never do. */
const itilDraft: CourseSpec = {
  code: 'ITIL4-F-2026-2-B',
  title: 'ITIL 4 Foundation (evening group, not yet published)',
  status: 'draft',
  program: 'GTI',
  subject: itil.subject,
  enrollments: [
    { persona: 'instructor', role: 'instructor' },
    { persona: 'reviewer', role: 'design_team' },
    { persona: 'student', role: 'student' },
  ],
  sections: [],
  actions: [],
};

export const COURSES: CourseSpec[] = [itil, pm, ai, itilDraft];

/** Files for the live "instructor uploads a document" step (written outside the repository). */
export const DEMO_UPLOAD_FILES: Array<{ name: string; build: () => Buffer }> = [
  {
    name: 'itil-continual-improvement.pdf',
    build: () =>
      demoPdf('Continual improvement model', [
        [
          'The continual improvement model gives a structured approach to improving services, practices and the service value system.',
          'It starts by asking what the vision is, where we are now and where we want to be.',
          'The team then defines how to get there, takes action, checks whether the goals were achieved and keeps the momentum going.',
        ],
        [
          'Measurement and reporting support good decisions: key performance indicators should be aligned with the objectives of the organization.',
          'A continual improvement register records improvement ideas so that they can be prioritized and tracked.',
        ],
      ]),
  },
  {
    name: 'pm-stakeholder-map.docx',
    build: () =>
      demoDocx('Stakeholder map', [
        'A stakeholder map places each stakeholder by their interest in the project and their influence over it.',
        '## How to use it',
        'Manage closely the stakeholders with high influence and high interest, keep satisfied those with high influence and low interest, and keep informed those with high interest and low influence.',
        'Review the map at every milestone because stakeholder positions change during the project.',
      ]),
  },
];
