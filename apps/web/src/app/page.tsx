import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

const capabilities = [
  {
    title: 'Courses',
    description: 'Course content, sections and learning activities organized by academic term.',
  },
  {
    title: 'Assessments',
    description: 'Quizzes and assignments with online submission.',
  },
  {
    title: 'Grading',
    description: 'Grading and academic progress tracking for every student.',
  },
  {
    title: 'AI tutoring',
    description: 'Personalized learning support for students.',
  },
];

export default function HomePage() {
  return (
    <div className="space-y-10">
      <section aria-labelledby="intro-heading">
        <Card padding="lg" className="bg-linear-to-br from-brand-50 to-white">
          <p className="text-sm font-semibold tracking-wider text-brand-600 uppercase">
            Institutional learning platform
          </p>
          <h1 id="intro-heading" className="mt-3 max-w-3xl text-3xl font-bold tracking-tight text-brand-900 sm:text-4xl">
            Welcome to AcademiaPath
          </h1>
          <p className="mt-4 max-w-2xl text-base text-slate-600 sm:text-lg">
            One place for universities to deliver courses, assess learning and support every student.
            This is an early development preview of the platform.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/login" className={buttonClasses()}>
              Sign in
            </Link>
            <Link href="/preview/courses" className={buttonClasses({ variant: 'secondary' })}>
              Preview course components
            </Link>
          </div>
        </Card>
      </section>

      <section aria-labelledby="capabilities-heading">
        <h2 id="capabilities-heading" className="text-xl font-semibold tracking-tight text-slate-900">
          Platform capabilities
        </h2>
        <p className="mt-1 text-sm text-slate-600">Planned capabilities, currently in development.</p>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {capabilities.map((capability) => (
            <Card as="li" key={capability.title}>
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-semibold text-slate-900">{capability.title}</h3>
                <Badge>In development</Badge>
              </div>
              <p className="mt-2 text-sm text-slate-600">{capability.description}</p>
            </Card>
          ))}
        </ul>
      </section>
    </div>
  );
}
