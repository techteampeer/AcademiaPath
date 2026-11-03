const features = [
  {
    es: 'Cursos',
    en: 'Courses',
    description: 'Contenidos, módulos y materiales organizados por curso.',
    descriptionEn: 'Content, modules and materials organized by course.',
  },
  {
    es: 'Evaluaciones',
    en: 'Quizzes & assignments',
    description: 'Cuestionarios y tareas con entregas en línea.',
    descriptionEn: 'Quizzes and assignments with online submission.',
  },
  {
    es: 'Calificaciones',
    en: 'Grading',
    description: 'Seguimiento del progreso académico de cada estudiante.',
    descriptionEn: "Track each student's academic progress.",
  },
  {
    es: 'Tutor con IA',
    en: 'AI tutoring',
    description: 'Apoyo personalizado para el aprendizaje.',
    descriptionEn: 'Personalized learning support.',
  },
];

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <span className="text-lg font-semibold tracking-tight text-brand-900">
            Academia<span className="text-brand-600">Path</span>
          </span>
          <span className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600">
            ES · EN
          </span>
        </div>
      </header>

      <main className="flex-1">
        <section className="bg-brand-50">
          <div className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
            <p className="text-sm font-semibold uppercase tracking-wider text-brand-600">
              Plataforma institucional de aprendizaje
            </p>
            <h1 className="mt-3 max-w-3xl text-4xl font-bold tracking-tight text-brand-900 sm:text-5xl">
              Aprender, enseñar y evaluar en un solo lugar.
            </h1>
            <p className="mt-4 max-w-2xl text-lg text-slate-600">
              Learn, teach and assess in one place — an institutional learning
              platform for universities.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-6 py-16">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
            Funcionalidades <span className="text-slate-400">· Features</span>
          </h2>
          <ul className="mt-8 grid gap-6 sm:grid-cols-2">
            {features.map((feature) => (
              <li
                key={feature.en}
                className="rounded-xl border border-slate-200 p-6 shadow-sm"
              >
                <h3 className="font-semibold text-brand-700">
                  {feature.es}{' '}
                  <span className="font-normal text-slate-400">
                    · {feature.en}
                  </span>
                </h3>
                <p className="mt-2 text-slate-700">{feature.description}</p>
                <p className="mt-1 text-sm text-slate-500">
                  {feature.descriptionEn}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-slate-200">
        <div className="mx-auto max-w-5xl px-6 py-6 text-sm text-slate-500">
          © {new Date().getFullYear()} AcademiaPath
        </div>
      </footer>
    </div>
  );
}
