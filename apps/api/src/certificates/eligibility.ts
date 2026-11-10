import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { courseCertificatePolicies, enrollments, grades, type CertificatePolicySnapshot } from '../db/schema/index.js';
import { loadGradebookColumns, releasedCourseGradeExact, type GradebookColumn } from '../grading/gradebook.js';
import { meetsPercent, loadGradingPolicy, weightingCategories, type PolicyCategory } from '../grading/policy.js';
import { learnerProgress } from '../progress/model.js';
import type { CourseRecord } from '../auth/authorization.js';

type Reader = Pick<Database, 'select'>;
export type CertificatePolicyRecord = typeof courseCertificatePolicies.$inferSelect;

/**
 * Certificate eligibility (AP-024), always decided on the server from stored records:
 * - the course has a certificate policy and it is enabled (no policy: no certificate, ever);
 * - the course is published, and the student's enrollment in it is active;
 * - when required, every learning activity is completed (AP-020 progress, 100 %; a course without
 *   countable activities can never meet this, so completion is never assumed);
 * - when required, the course grade is final (AP-023: every counted activity graded and released, none
 *   changed since release), computed from released grades only;
 * - when a minimum is set, that final grade reaches it, compared exactly before rounding. A provisional,
 *   missing or unreleased result is never compared, so it can never pass.
 * Policies always require completion, a final grade, or both (database check).
 */
export type RequirementKey = 'policy_enabled' | 'course_published' | 'active_enrollment' | 'activities_completed' | 'final_grade_released' | 'minimum_grade';
export type RequirementReason =
  | 'not_configured'
  | 'disabled'
  | 'not_published'
  | 'not_enrolled'
  | 'inactive'
  | 'no_activities'
  | 'incomplete'
  | 'no_graded_work'
  | 'grades_pending'
  | 'awaiting_final_grade'
  | 'below_minimum';
export type Requirement = { key: RequirementKey; met: boolean; reason: RequirementReason | null };
export type Eligibility = {
  eligible: boolean;
  requirements: Requirement[];
  progress: { completedCount: number; totalCount: number; percent: number | null };
  /** From released grades only (never unreleased points). */
  releasedGrade: { status: 'final' | 'provisional'; percent: number | null; grade20: number | null; pendingItems: number };
};

export async function loadCertificatePolicy(executor: Reader, courseId: string, lock?: 'update' | 'share'): Promise<CertificatePolicyRecord | null> {
  const query = executor.select().from(courseCertificatePolicies).where(eq(courseCertificatePolicies.courseId, courseId));
  const [row] = lock ? await query.for(lock) : await query;
  return row ?? null;
}

export function policySnapshot(policy: CertificatePolicyRecord): CertificatePolicySnapshot {
  return {
    version: policy.version,
    requireCompletion: policy.requireCompletion,
    requireFinalGrade: policy.requireFinalGrade,
    minimumGradePercent: policy.minimumGradePercent,
    issuerName: policy.issuerName,
  };
}

/** Course-level inputs shared by every student's evaluation (loaded once per request). */
export type EligibilityContext = { course: CourseRecord; policy: CertificatePolicyRecord | null; columns: GradebookColumn[]; categories: PolicyCategory[] | null };

export async function eligibilityContext(executor: Reader, course: CourseRecord, policy?: CertificatePolicyRecord | null): Promise<EligibilityContext> {
  const grading = await loadGradingPolicy(executor, course.id);
  const categories = weightingCategories(grading);
  return {
    course,
    policy: policy === undefined ? await loadCertificatePolicy(executor, course.id) : policy,
    columns: await loadGradebookColumns(executor, course.id, categories),
    categories,
  };
}

export async function evaluateEligibility(executor: Reader, context: EligibilityContext, userId: string): Promise<Eligibility> {
  const { course, policy } = context;
  const [enrollment] = await executor
    .select({ status: enrollments.status })
    .from(enrollments)
    .where(and(eq(enrollments.courseId, course.id), eq(enrollments.userId, userId), eq(enrollments.role, 'student')));
  // AP-020: the same progress figures students see.
  const { summary } = await learnerProgress(executor, course.id, userId);
  // AP-023: the course grade calculated from released grades only (the release state, never current points).
  const states = await executor
    .select({ activityId: grades.activityId, revision: grades.revision, releasedRevision: grades.releasedRevision, releasedPoints: grades.releasedPoints, releasedMaxPoints: grades.releasedMaxPoints })
    .from(grades)
    .where(and(eq(grades.courseId, course.id), eq(grades.userId, userId)));
  const byActivity = new Map(states.map((row) => [row.activityId, row]));
  const { grade, exact } = releasedCourseGradeExact(context.columns, context.categories, (activityId) => byActivity.get(activityId));
  const isFinal = grade.status === 'final' && grade.grade20 !== null;

  const requirements: Requirement[] = [
    { key: 'policy_enabled', met: policy?.enabled === true, reason: !policy ? 'not_configured' : policy.enabled ? null : 'disabled' },
    { key: 'course_published', met: course.status === 'published', reason: course.status === 'published' ? null : 'not_published' },
    { key: 'active_enrollment', met: enrollment?.status === 'active', reason: !enrollment ? 'not_enrolled' : enrollment.status === 'active' ? null : 'inactive' },
  ];
  if (policy?.requireCompletion) {
    const met = summary.totalCount > 0 && summary.completedCount === summary.totalCount;
    requirements.push({ key: 'activities_completed', met, reason: met ? null : summary.totalCount === 0 ? 'no_activities' : 'incomplete' });
  }
  if (policy?.requireFinalGrade) {
    requirements.push({
      key: 'final_grade_released',
      met: isFinal,
      reason: isFinal ? null : grade.countedItems === 0 || (grade.grade20 === null && grade.pendingItems === 0) ? 'no_graded_work' : 'grades_pending',
    });
  }
  if (policy?.minimumGradePercent != null) {
    const met = isFinal && exact !== null && meetsPercent(exact, policy.minimumGradePercent);
    requirements.push({ key: 'minimum_grade', met, reason: met ? null : isFinal ? 'below_minimum' : 'awaiting_final_grade' });
  }
  return {
    eligible: policy !== null && requirements.every((requirement) => requirement.met),
    requirements,
    progress: { completedCount: summary.completedCount, totalCount: summary.totalCount, percent: summary.percent },
    releasedGrade: { status: grade.status, percent: grade.percent, grade20: grade.grade20, pendingItems: grade.pendingItems },
  };
}
