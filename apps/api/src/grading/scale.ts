/**
 * The 0–20 grade scale. Every value is calculated on the server with integer arithmetic:
 * grade20 = points × 20 / maxPoints, rounded half up to one decimal place (15.55 → 15.6, 0.25 → 0.3).
 */
export const GRADE_SCALE_MAX = 20;

export function toScale20(points: number, maxPoints: number): number {
  if (!Number.isInteger(points) || !Number.isInteger(maxPoints) || maxPoints < 1 || points < 0 || points > maxPoints) {
    throw new RangeError(`Invalid grade ${points}/${maxPoints}`);
  }
  // Tenths of a point on the 0–20 scale: round_half_up(points × 200 / maxPoints).
  const tenths = Math.floor((points * 400 + maxPoints) / (2 * maxPoints));
  return tenths / 10;
}

export type CourseTotal = { points: number; maxPoints: number; grade20: number | null; gradedItems: number };

/** Unweighted course total: sum the points of the counted items, then convert once (no compounded rounding). */
export function courseTotal(items: Array<{ points: number; maxPoints: number }>): CourseTotal {
  const points = items.reduce((total, item) => total + item.points, 0);
  const maxPoints = items.reduce((total, item) => total + item.maxPoints, 0);
  return { points, maxPoints, grade20: maxPoints > 0 ? toScale20(points, maxPoints) : null, gradedItems: items.length };
}
