import { asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { courseGradingPolicies, gradeCategories, gradeCategoryActivities } from '../db/schema/index.js';
import { toScale20 } from './scale.js';

/**
 * Course grade calculation policy (AP-023). Everything runs on the server with exact integer arithmetic;
 * every displayed value is rounded once, half up, to one decimal place.
 *
 * Which activities count: the course's approved quizzes and assignments (the gradebook columns). With a
 * published weighting policy only activities placed in a category count; the others are listed as
 * "not counted". A draft policy, or no policy, means the original unweighted calculation ("points").
 *
 * What a student's activity contributes:
 * - a grade (an earned score, including an earned 0) counts with its points and maximum;
 * - work not submitted, awaiting grading, or (for students) not yet released is never treated as zero:
 *   it is left out of the calculation and reported as pending.
 *
 * Points method (unchanged from AP-009): sum the points of graded items, sum their maxima, convert once.
 * Weighted method: each category's percentage = its graded points / its graded maxima; the course
 * percentage = Σ(weight × category percentage) / Σ(weights of categories that have graded work). A
 * category without graded work is left out and the remaining weights are scaled up to 100 % (no division
 * by zero, no misleading 0 %); when no category has graded work there is no course grade (null).
 *
 * Final versus provisional: an activity is required when it is visible to students or already has a grade.
 * The course grade is "final" only when it has graded work and every required counted activity has a
 * grade that is released and unchanged since its release; otherwise it is "provisional". Staff see the
 * calculation on current grades; students see the same calculation on released grades only.
 */

export type PolicyStatus = 'none' | 'draft' | 'published';
export type PolicyCategory = { id: string; name: string; weightPercent: number; position: number; activityIds: string[] };
export type GradingPolicy = {
  status: PolicyStatus;
  version: number;
  publishedAt: Date | null;
  updatedAt: Date | null;
  categories: PolicyCategory[];
};

export const GRADING_LIMITS = { categories: 20, categoryName: 80, activitiesPerCategory: 200 } as const;

/** The course's saved policy (draft or published), or the default when none exists. */
export async function loadGradingPolicy(executor: Pick<Database, 'select'>, courseId: string, options: { lock?: boolean } = {}): Promise<GradingPolicy> {
  const query = executor.select().from(courseGradingPolicies).where(eq(courseGradingPolicies.courseId, courseId));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) return { status: 'none', version: 0, publishedAt: null, updatedAt: null, categories: [] };
  const categories = await executor.select().from(gradeCategories).where(eq(gradeCategories.courseId, courseId)).orderBy(asc(gradeCategories.position));
  const members = categories.length
    ? await executor
        .select({ activityId: gradeCategoryActivities.activityId, categoryId: gradeCategoryActivities.categoryId })
        .from(gradeCategoryActivities)
        .where(inArray(gradeCategoryActivities.categoryId, categories.map((category) => category.id)))
        .orderBy(asc(gradeCategoryActivities.activityId))
    : [];
  return {
    status: row.status,
    version: row.version,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      weightPercent: category.weightPercent,
      position: category.position,
      activityIds: members.filter((member) => member.categoryId === category.id).map((member) => member.activityId),
    })),
  };
}

/** The categories that weight grades: only a published policy's (a draft never affects grades). */
export function weightingCategories(policy: GradingPolicy): PolicyCategory[] | null {
  return policy.status === 'published' && policy.categories.length ? policy.categories : null;
}

/** One gradebook column as seen by the calculation. */
export type CountedColumn = { activityId: string; visible: boolean };
/** A student's grade for one activity, as used by the calculation (current for staff, released for students). */
export type CountedGrade = { points: number; maxPoints: number; final: boolean };

export type CategorySummary = {
  categoryId: string;
  name: string;
  weightPercent: number;
  points: number;
  maxPoints: number;
  gradedItems: number;
  countedItems: number;
  /** Category percentage (0–100, one decimal), or null while the category has no graded work. */
  percent: number | null;
  grade20: number | null;
};

export type CourseGrade = {
  method: 'points' | 'weighted';
  status: 'final' | 'provisional';
  /** 0–20 (one decimal), or null when nothing counted has been graded. */
  grade20: number | null;
  percent: number | null;
  countedItems: number;
  gradedItems: number;
  /** Required counted activities without a final (graded, released and current) grade. */
  pendingItems: number;
  categories: CategorySummary[];
};

/** round_half_up(scale × numerator / denominator) to one decimal place, exactly (BigInt). */
function roundedTenths(numerator: bigint, denominator: bigint, scale: number): number {
  const tenths = (2n * 10n * BigInt(scale) * numerator + denominator) / (2n * denominator);
  return Number(tenths) / 10;
}

export function percentOf(points: number, maxPoints: number): number {
  return roundedTenths(BigInt(points), BigInt(maxPoints), 100);
}

/**
 * The course grade for one student. `columns` are the course's gradebook columns in order; `gradeFor`
 * returns the counted grade of an activity (or null when there is none to count) and whether a grade of
 * any kind exists (so required work is known even when the counted value is hidden).
 */
export function computeCourseGrade(
  columns: CountedColumn[],
  categories: PolicyCategory[] | null,
  gradeFor: (activityId: string) => { counted: CountedGrade | null; exists: boolean },
): CourseGrade {
  return computeCourseGradeExact(columns, categories, gradeFor).grade;
}

/** The course percentage as an exact fraction (0–1) before any rounding, or null without graded work. */
export type ExactFraction = { numerator: bigint; denominator: bigint };

/** Whether an exact course fraction reaches a whole-number percentage (no rounding: 59.96 % does not reach 60 %). */
export function meetsPercent(fraction: ExactFraction, percent: number): boolean {
  return fraction.numerator * 100n >= BigInt(percent) * fraction.denominator;
}

/** The same calculation as `computeCourseGrade`, also returning the exact fraction it rounds. */
export function computeCourseGradeExact(
  columns: CountedColumn[],
  categories: PolicyCategory[] | null,
  gradeFor: (activityId: string) => { counted: CountedGrade | null; exists: boolean },
): { grade: CourseGrade; exact: ExactFraction | null } {
  const inCategory = new Map<string, string>();
  for (const category of categories ?? []) for (const activityId of category.activityIds) inCategory.set(activityId, category.id);
  const counted = categories ? columns.filter((column) => inCategory.has(column.activityId)) : columns;

  let gradedItems = 0;
  let pendingItems = 0;
  const graded = new Map<string, CountedGrade>();
  for (const column of counted) {
    const { counted: grade, exists } = gradeFor(column.activityId);
    if (grade) {
      graded.set(column.activityId, grade);
      gradedItems += 1;
    }
    const required = column.visible || exists;
    if (required && !grade?.final) pendingItems += 1;
  }

  const summaries: CategorySummary[] = (categories ?? []).map((category) => {
    const members = counted.filter((column) => inCategory.get(column.activityId) === category.id);
    const items = members.flatMap((column) => {
      const grade = graded.get(column.activityId);
      return grade ? [grade] : [];
    });
    const points = items.reduce((total, item) => total + item.points, 0);
    const maxPoints = items.reduce((total, item) => total + item.maxPoints, 0);
    return {
      categoryId: category.id,
      name: category.name,
      weightPercent: category.weightPercent,
      points,
      maxPoints,
      gradedItems: items.length,
      countedItems: members.length,
      percent: maxPoints > 0 ? percentOf(points, maxPoints) : null,
      grade20: maxPoints > 0 ? toScale20(points, maxPoints) : null,
    };
  });

  let grade20: number | null = null;
  let percent: number | null = null;
  let exact: ExactFraction | null = null;
  if (!categories) {
    const points = [...graded.values()].reduce((total, item) => total + item.points, 0);
    const maxPoints = [...graded.values()].reduce((total, item) => total + item.maxPoints, 0);
    if (maxPoints > 0) {
      grade20 = toScale20(points, maxPoints);
      percent = percentOf(points, maxPoints);
      exact = { numerator: BigInt(points), denominator: BigInt(maxPoints) };
    }
  } else {
    // F = Σ w·P/M / Σ w over categories with graded work, as one exact fraction N / (W·D).
    const included = summaries.filter((summary) => summary.maxPoints > 0);
    if (included.length) {
      const denominator = included.reduce((product, summary) => product * BigInt(summary.maxPoints), 1n);
      const numerator = included.reduce(
        (total, summary) => total + BigInt(summary.weightPercent) * BigInt(summary.points) * (denominator / BigInt(summary.maxPoints)),
        0n,
      );
      const weights = BigInt(included.reduce((total, summary) => total + summary.weightPercent, 0));
      grade20 = roundedTenths(numerator, weights * denominator, 20);
      percent = roundedTenths(numerator, weights * denominator, 100);
      exact = { numerator, denominator: weights * denominator };
    }
  }

  const grade: CourseGrade = {
    method: categories ? 'weighted' : 'points',
    status: grade20 !== null && pendingItems === 0 ? 'final' : 'provisional',
    grade20,
    percent,
    countedItems: counted.length,
    gradedItems,
    pendingItems,
    categories: summaries,
  };
  return { grade, exact };
}
