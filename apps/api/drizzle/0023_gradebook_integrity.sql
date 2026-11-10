-- Custom migration (AP-023): integrity rules for grade categories, and a backfill that links released quiz
-- grades to the attempt that was released, so its saved passing threshold decides the released pass/fail.

-- A category membership must name a quiz or assignment of the category's own course.
CREATE FUNCTION "grade_category_activities_check_activity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "activities" a
    JOIN "sections" s ON s.id = a.section_id
    WHERE a.id = NEW.activity_id
      AND s.course_id = NEW.course_id
      AND a.type IN ('quiz', 'assignment')
  ) THEN
    RAISE EXCEPTION 'activity % is not a quiz or assignment of course %', NEW.activity_id, NEW.course_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "grade_category_activities_activity"
  BEFORE INSERT OR UPDATE ON "grade_category_activities"
  FOR EACH ROW EXECUTE FUNCTION "grade_category_activities_check_activity"();
--> statement-breakpoint
-- Backfill 1: a quiz grade released and unchanged since then was released from its counted attempt.
UPDATE "grades"
SET "released_quiz_attempt_id" = "quiz_attempt_id"
WHERE "source" = 'quiz' AND "released_revision" IS NOT NULL AND "released_revision" = "revision";
--> statement-breakpoint
-- Backfill 2: a quiz grade that changed after its release was released from the earliest attempt, submitted
-- before the release, with exactly the released score (the gradebook's tie-break: earliest submission first).
UPDATE "grades" g
SET "released_quiz_attempt_id" = (
  SELECT a."id"
  FROM "quiz_attempts" a
  WHERE a."activity_id" = g."activity_id"
    AND a."user_id" = g."user_id"
    AND a."status" = 'submitted'
    AND a."submitted_at" <= g."released_at"
    AND a."score" = g."released_points"
    AND a."max_score" = g."released_max_points"
  ORDER BY a."submitted_at" ASC, a."id" ASC
  LIMIT 1
)
WHERE g."source" = 'quiz' AND g."released_revision" IS NOT NULL AND g."released_revision" <> g."revision" AND g."released_quiz_attempt_id" IS NULL;
