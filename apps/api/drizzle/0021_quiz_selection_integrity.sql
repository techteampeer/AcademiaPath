-- Custom migration (AP-022): an attempt's question selection is fixed when the attempt is created.
-- While the attempt is in progress only the student's response (and grading on submission) may change;
-- the selected question, its position, prompt, options and their order, answer key and points never do.
-- Submitted attempts and their answers stay fully immutable (migration 0007).
CREATE FUNCTION "quiz_attempt_answers_reject_selection_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.question_id IS DISTINCT FROM OLD.question_id
    OR NEW.position IS DISTINCT FROM OLD.position
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.prompt IS DISTINCT FROM OLD.prompt
    OR NEW.options IS DISTINCT FROM OLD.options
    OR NEW.correct_answer IS DISTINCT FROM OLD.correct_answer
    OR NEW.points IS DISTINCT FROM OLD.points THEN
    RAISE EXCEPTION 'the question selection of a quiz attempt is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "quiz_attempt_answers_selection_immutable"
  BEFORE UPDATE ON "quiz_attempt_answers"
  FOR EACH ROW EXECUTE FUNCTION "quiz_attempt_answers_reject_selection_change"();
--> statement-breakpoint
-- An attempt's policy snapshot (attempt limit, version, max score, passing threshold, feedback setting)
-- is fixed at creation as well, even before submission.
CREATE FUNCTION "quiz_attempts_reject_policy_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.activity_id IS DISTINCT FROM OLD.activity_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
    OR NEW.attempt_limit IS DISTINCT FROM OLD.attempt_limit
    OR NEW.quiz_version_approved_at IS DISTINCT FROM OLD.quiz_version_approved_at
    OR NEW.max_score IS DISTINCT FROM OLD.max_score
    OR NEW.passing_score_percent IS DISTINCT FROM OLD.passing_score_percent
    OR NEW.feedback_enabled IS DISTINCT FROM OLD.feedback_enabled THEN
    RAISE EXCEPTION 'the policy snapshot of a quiz attempt is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "quiz_attempts_policy_immutable"
  BEFORE UPDATE ON "quiz_attempts"
  FOR EACH ROW EXECUTE FUNCTION "quiz_attempts_reject_policy_change"();
