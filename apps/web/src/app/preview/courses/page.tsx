import type { Metadata } from 'next';
import { localizedTitle, serverLocale } from '@/lib/i18n/server';
import { MESSAGES } from '@/lib/i18n/messages';
import { CourseGrid } from '@/components/courses/CourseGrid';
import { Badge } from '@/components/ui/Badge';
import { demoCourses } from '@/mocks/courses';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('preview');
}

/** Component preview with frontend sample data. The sample course texts are content and stay as written. */
export default async function CourseComponentsPreviewPage() {
  const p = MESSAGES[await serverLocale()].preview;
  return (
    <div className="space-y-10">
      <div>
        <Badge tone="warning">{p.badge}</Badge>
        <h1 className="mt-3 text-[1.75rem] leading-tight font-semibold text-brand-600 sm:text-[2.1rem]">{p.title}</h1>
        <p className="mt-2 max-w-2xl text-slate-600">{p.intro}</p>
      </div>

      <div role="note" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">{p.noteTitle}</p>
        <p className="mt-1">{p.noteBody}</p>
      </div>

      <section aria-labelledby="course-grid-heading">
        <h2 id="course-grid-heading" className="text-xl font-semibold tracking-tight text-brand-600">
          {p.gridTitle}
        </h2>
        <p className="mt-1 text-sm text-slate-600">{p.gridIntro}</p>
        <div className="mt-6">
          <CourseGrid courses={demoCourses} />
        </div>
      </section>

      <section aria-labelledby="empty-state-heading">
        <h2 id="empty-state-heading" className="text-xl font-semibold tracking-tight text-brand-600">
          {p.emptyTitle}
        </h2>
        <p className="mt-1 text-sm text-slate-600">{p.emptyIntro}</p>
        <div className="mt-6">
          <CourseGrid courses={[]} />
        </div>
      </section>
    </div>
  );
}
