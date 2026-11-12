'use client';

import type { ReactNode } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
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
  emptyTitle,
  emptyDescription,
  emptyAction,
  getCourseHref,
}: CourseGridProps) {
  const { t } = useLocale();
  if (courses.length === 0) {
    return (
      <EmptyState
        title={emptyTitle ?? t.preview.noCourses}
        description={emptyDescription ?? t.preview.noCoursesDescription}
        action={emptyAction}
      />
    );
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
