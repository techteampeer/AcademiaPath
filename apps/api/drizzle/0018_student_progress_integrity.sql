-- Custom migration: integrity rules for learning progress (AP-020). Existing data is not changed.

-- A completion mark is only valid for a reading activity (lesson, link or document) of the row's own
-- course, recorded against the student's own active enrollment. Quiz and assignment completion is
-- never stored: it is derived from submitted attempts and submissions, so it cannot be forged here.
CREATE FUNCTION "activity_completions_check_target"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  activity_type text;
  activity_course uuid;
  enrollment_role text;
  enrollment_status text;
BEGIN
  SELECT a.type::text, s.course_id INTO activity_type, activity_course
  FROM "activities" a JOIN "sections" s ON s.id = a.section_id
  WHERE a.id = NEW.activity_id;
  IF activity_type IS NULL OR activity_course <> NEW.course_id THEN
    RAISE EXCEPTION 'the activity does not belong to the completion''s course' USING ERRCODE = 'check_violation';
  END IF;
  IF activity_type NOT IN ('page', 'link', 'file') THEN
    RAISE EXCEPTION 'only reading activities can be marked complete' USING ERRCODE = 'check_violation';
  END IF;
  SELECT e.role::text, e.status::text INTO enrollment_role, enrollment_status
  FROM "enrollments" e
  WHERE e.id = NEW.enrollment_id AND e.course_id = NEW.course_id AND e.user_id = NEW.user_id;
  IF enrollment_role IS DISTINCT FROM 'student' OR enrollment_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'completions belong to an active student enrollment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "activity_completions_target"
  BEFORE INSERT ON "activity_completions"
  FOR EACH ROW EXECUTE FUNCTION "activity_completions_check_target"();
--> statement-breakpoint
-- Marks are added or removed, never rewritten (no moving a mark to another activity or student).
CREATE FUNCTION "progress_reject_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be updated; delete and insert instead', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "activity_completions_no_update"
  BEFORE UPDATE ON "activity_completions"
  FOR EACH ROW EXECUTE FUNCTION "progress_reject_update"();
--> statement-breakpoint
CREATE TRIGGER "section_prerequisites_no_update"
  BEFORE UPDATE ON "section_prerequisites"
  FOR EACH ROW EXECUTE FUNCTION "progress_reject_update"();
--> statement-breakpoint
-- Backstop for the API's cycle check (which runs under the course row lock): a new requirement must
-- not make the section reachable from the section it requires.
CREATE FUNCTION "section_prerequisites_reject_cycle"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE reach(section_id) AS (
      SELECT sp.required_section_id FROM "section_prerequisites" sp WHERE sp.section_id = NEW.required_section_id
      UNION
      SELECT sp.required_section_id FROM "section_prerequisites" sp JOIN reach r ON sp.section_id = r.section_id
    )
    SELECT 1 FROM reach WHERE reach.section_id = NEW.section_id
  ) THEN
    RAISE EXCEPTION 'section prerequisites cannot form a cycle' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "section_prerequisites_acyclic"
  BEFORE INSERT ON "section_prerequisites"
  FOR EACH ROW EXECUTE FUNCTION "section_prerequisites_reject_cycle"();
