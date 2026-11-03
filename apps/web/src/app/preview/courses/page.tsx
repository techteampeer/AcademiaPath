import type { Metadata } from 'next';
import { CourseGrid } from '@/components/courses/CourseGrid';
import { Badge } from '@/components/ui/Badge';
import { demoCourses } from '@/mocks/courses';

export const metadata: Metadata = {
  title: 'Course components preview',
};

export default function CourseComponentsPreviewPage() {
  return (
    <div className="space-y-10">
      <div>
        <Badge tone="warning">Demonstration data</Badge>
        <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          Course components preview
        </h1>
        <p className="mt-2 max-w-2xl text-slate-600">
          Reusable course and student progress components, shown with synthetic sample data.
        </p>
      </div>

      <div role="note" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">These courses are synthetic demonstration data.</p>
        <p className="mt-1">
          They are defined in the frontend for preview purposes only and are not loaded from the AcademiaPath API or
          database. Instructor names and progress values are fictional.
        </p>
      </div>

      <section aria-labelledby="course-grid-heading">
        <h2 id="course-grid-heading" className="text-xl font-semibold tracking-tight text-slate-900">
          Course grid
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Sample courses covering each course status and progress at 0%, partial and 100%.
        </p>
        <div className="mt-6">
          <CourseGrid courses={demoCourses} />
        </div>
      </section>

      <section aria-labelledby="empty-state-heading">
        <h2 id="empty-state-heading" className="text-xl font-semibold tracking-tight text-slate-900">
          Empty state
        </h2>
        <p className="mt-1 text-sm text-slate-600">How the course grid appears when there are no courses to display.</p>
        <div className="mt-6">
          <CourseGrid courses={[]} />
        </div>
      </section>
    </div>
  );
}
