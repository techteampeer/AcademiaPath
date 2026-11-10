'use client';

import { useLocale } from '@/components/i18n/LocaleProvider';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import type { CourseRole, CurrentUser, ReviewStatus } from '@/lib/api/types';

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
    /** Grading needs the course role itself; the administrator role never grants it. */
    grade: role === 'instructor' || role === 'non_editing_instructor',
    /** Releasing grades: instructors only (AP-023; non-editing instructors have read-only gradebook access). */
    release: role === 'instructor',
    /** Grade categories and weights: instructors and administrators. */
    configureGrading: admin || role === 'instructor',
    /** Course tutor: students, instructors and non-editing instructors (never via the administrator role). */
    tutor: role === 'student' || role === 'instructor' || role === 'non_editing_instructor',
    /** Own learning progress and completion marks: enrolled students only. */
    trackProgress: role === 'student',
    /** Students' progress overview (read-only): instructors, non-editing instructors and administrators. */
    viewProgress: admin || role === 'instructor' || role === 'non_editing_instructor',
  };
}

export type ContentAbilities = ReturnType<typeof contentAbilities>;

const STATUS_TONES: Record<ReviewStatus, BadgeTone> = { draft: 'neutral', submitted: 'brand', approved: 'success', returned: 'warning' };

export function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  const { t } = useLocale();
  return (
    <Badge tone={STATUS_TONES[status]}>
      <span className="sr-only">{t.content.reviewStatusLabel}: </span>
      {t.content.reviewStatus[status]}
    </Badge>
  );
}

/** Only absolute http(s) URLs are ever rendered as links (the API enforces this too). */
export function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
