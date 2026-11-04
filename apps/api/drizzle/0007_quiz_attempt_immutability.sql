-- Custom migration: submitted quiz attempts (and their answers and grades) can never change.
CREATE FUNCTION "quiz_attempts_reject_submitted_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'submitted' THEN
    RAISE EXCEPTION 'submitted quiz attempts are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "quiz_attempts_immutable_after_submit"
  BEFORE UPDATE OR DELETE ON "quiz_attempts"
  FOR EACH ROW EXECUTE FUNCTION "quiz_attempts_reject_submitted_change"();
--> statement-breakpoint
CREATE FUNCTION "quiz_attempt_answers_reject_submitted_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "quiz_attempts" WHERE id = OLD.attempt_id AND status = 'submitted') THEN
    RAISE EXCEPTION 'answers of submitted quiz attempts are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "quiz_attempt_answers_immutable_after_submit"
  BEFORE UPDATE OR DELETE ON "quiz_attempt_answers"
  FOR EACH ROW EXECUTE FUNCTION "quiz_attempt_answers_reject_submitted_change"();
