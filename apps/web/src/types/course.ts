/** Mirrors the API/database `course_status` enum. */
export type CourseStatus = 'draft' | 'published' | 'archived';

/**
 * Presentation model for course cards, independent of the data source. Optional fields are
 * omitted when the source does not provide them; they are never invented.
 */
export type CourseSummary = {
  id: string;
  title: string;
  status: CourseStatus;
  description?: string | null;
  /** Short line under the title, e.g. the course code and the viewer's role. */
  subtitle?: string;
  instructorName?: string | null;
  /** Student progress from 0 to 100. Out-of-range values are clamped when displayed. */
  progressPercent?: number | null;
};
