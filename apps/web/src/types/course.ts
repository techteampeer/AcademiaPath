/** Mirrors the API/database `course_status` enum. */
export type CourseStatus = 'draft' | 'published' | 'archived';

/**
 * Presentation model for course cards. Kept independent of any data source so
 * real API responses can be mapped onto it later.
 */
export type CourseSummary = {
  id: string;
  title: string;
  description: string;
  instructorName: string;
  /** Student progress from 0 to 100. Out-of-range values are clamped when displayed. */
  progressPercent: number;
  status: CourseStatus;
};
