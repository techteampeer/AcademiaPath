-- Custom migration: integrity rules for assignment submissions and the gradebook, plus a backfill
-- of quiz grades from attempts submitted before this migration (existing data is preserved).

-- Submissions are final: they can never be changed or deleted.
CREATE FUNCTION "assignment_submissions_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'assignment submissions are final and cannot change' USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assignment_submissions_immutable"
  BEFORE UPDATE OR DELETE ON "assignment_submissions"
  FOR EACH ROW EXECUTE FUNCTION "assignment_submissions_reject_change"();
--> statement-breakpoint
-- A criterion score must name a criterion of the submission's rubric snapshot and copy its maximum
-- (the points <= max_points check then enforces the criterion maximum).
CREATE FUNCTION "assignment_criterion_scores_check_rubric"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  criterion_max integer;
BEGIN
  SELECT (criterion ->> 'maxPoints')::integer INTO criterion_max
  FROM "assignment_submissions" s, jsonb_array_elements(s.rubric) AS criterion
  WHERE s.id = NEW.submission_id AND criterion ->> 'id' = NEW.criterion_id::text;
  IF criterion_max IS NULL THEN
    RAISE EXCEPTION 'criterion % is not part of the submission rubric', NEW.criterion_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.max_points <> criterion_max THEN
    RAISE EXCEPTION 'criterion maximum does not match the submission rubric' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assignment_criterion_scores_rubric"
  BEFORE INSERT OR UPDATE ON "assignment_criterion_scores"
  FOR EACH ROW EXECUTE FUNCTION "assignment_criterion_scores_check_rubric"();
--> statement-breakpoint
-- Grades and submissions must reference an activity of their own course (submissions: an assignment).
CREATE FUNCTION "grading_check_activity_course"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "activities" a
    JOIN "sections" s ON s.id = a.section_id
    WHERE a.id = NEW.activity_id
      AND s.course_id = NEW.course_id
      AND (TG_TABLE_NAME <> 'assignment_submissions' OR a.type = 'assignment')
  ) THEN
    RAISE EXCEPTION 'activity % does not belong to course %', NEW.activity_id, NEW.course_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assignment_submissions_activity_course"
  BEFORE INSERT ON "assignment_submissions"
  FOR EACH ROW EXECUTE FUNCTION "grading_check_activity_course"();
--> statement-breakpoint
CREATE TRIGGER "grades_activity_course"
  BEFORE INSERT OR UPDATE OF "activity_id", "course_id" ON "grades"
  FOR EACH ROW EXECUTE FUNCTION "grading_check_activity_course"();
--> statement-breakpoint
-- Backfill: one quiz grade per student and quiz from the best submitted attempt
-- (highest score / max_score, then highest score, then earliest submission).
INSERT INTO "grades" ("course_id", "activity_id", "user_id", "enrollment_id", "source", "quiz_attempt_id", "points", "max_points", "graded_at")
SELECT DISTINCT ON (a.activity_id, a.user_id)
  a.course_id, a.activity_id, a.user_id, a.enrollment_id, 'quiz', a.id, a.score, a.max_score, a.graded_at
FROM "quiz_attempts" a
WHERE a.status = 'submitted'
ORDER BY a.activity_id, a.user_id, (a.score::numeric / a.max_score) DESC, a.score DESC, a.submitted_at ASC, a.id ASC;
