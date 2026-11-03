import type { Course, CourseRole } from '@/lib/api/types';
import type { CourseSummary } from '@/types/course';

export const COURSE_ROLE_LABELS: Record<CourseRole, string> = {
  design_team: 'Design team',
  instructor: 'Instructor',
  non_editing_instructor: 'Non-editing instructor',
  student: 'Student',
};

/**
 * Maps an API course to the card model. The API does not provide instructor names or progress,
 * so those are left out rather than invented.
 */
export function toCourseSummary(course: Course): CourseSummary {
  return {
    id: course.id,
    title: course.title,
    status: course.status,
    description: course.description,
    subtitle: [course.code, course.viewerRole ? `Your role: ${COURSE_ROLE_LABELS[course.viewerRole]}` : null]
      .filter(Boolean)
      .join(' · '),
  };
}
