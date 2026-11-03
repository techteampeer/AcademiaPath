import type { ReactNode } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import type { CourseSummary } from '@/types/course';
import { CourseCard } from './CourseCard';

export type CourseGridProps = {
  courses: CourseSummary[];
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  /** When set, each card title links to the returned URL. */
  getCourseHref?: (course: CourseSummary) => string;
};

/** Responsive grid of course cards: one column on mobile, two on tablet, three on wide screens. */
export function CourseGrid({
  courses,
  emptyTitle = 'No courses to show',
  emptyDescription = 'Courses will appear here once they are available.',
  emptyAction,
  getCourseHref,
}: CourseGridProps) {
  if (courses.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />;
  }

  return (
    <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
      {courses.map((course) => (
        <li key={course.id}>
          <CourseCard course={course} href={getCourseHref?.(course)} />
        </li>
      ))}
    </ul>
  );
}
