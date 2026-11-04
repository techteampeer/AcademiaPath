import { Badge, type BadgeTone } from '@/components/ui/Badge';
import type { Activity, CourseRole, CurrentUser, ReviewStatus } from '@/lib/api/types';

const STAFF_ROLES: CourseRole[] = ['design_team', 'instructor', 'non_editing_instructor'];
const EDITOR_ROLES: CourseRole[] = ['design_team', 'instructor'];

/**
 * What the UI offers to this user in this course. Mirrors the API's permission matrix for
 * convenience only; the API enforces every rule.
 */
export function contentAbilities(user: CurrentUser, viewerRole: CourseRole | null) {
  const admin = user.systemRole === 'administrator';
  const role = viewerRole ?? undefined;
  return {
    viewUnapproved: admin || (role !== undefined && STAFF_ROLES.includes(role)),
    edit: admin || (role !== undefined && EDITOR_ROLES.includes(role)),
    review: admin || role === 'design_team',
    /** Instructors (editing or not) and administrators see quiz attempts and server-calculated scores. */
    viewResults: admin || role === 'instructor' || role === 'non_editing_instructor',
    /** Only enrolled students take quizzes and submit assignments (never via the administrator role). */
    attempt: role === 'student',
    /** Gradebook and submissions (administrators read only). */
    viewGrades: admin || role === 'instructor' || role === 'non_editing_instructor',
    /** Grading and releasing grades need the course role itself; the administrator role never grants them. */
    grade: role === 'instructor' || role === 'non_editing_instructor',
  };
}

export type ContentAbilities = ReturnType<typeof contentAbilities>;

const STATUS_DISPLAY: Record<ReviewStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  submitted: { label: 'In review', tone: 'brand' },
  approved: { label: 'Approved', tone: 'success' },
  returned: { label: 'Returned', tone: 'warning' },
};

export function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  const display = STATUS_DISPLAY[status];
  return (
    <Badge tone={display.tone}>
      <span className="sr-only">Review status: </span>
      {display.label}
    </Badge>
  );
}

export const ACTIVITY_TYPE_LABELS: Record<Activity['type'], string> = {
  page: 'Lesson',
  link: 'External resource',
  quiz: 'Quiz',
  assignment: 'Assignment',
};

/** Only absolute http(s) URLs are ever rendered as links (the API enforces this too). */
export function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
