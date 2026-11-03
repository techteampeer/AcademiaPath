-- Custom migration: a course's program must match its template's program.
-- Templates without a program (shared, e.g. general education) can be used by any program.
CREATE FUNCTION "courses_check_template_program"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  template_program uuid;
BEGIN
  IF NEW.template_id IS NOT NULL AND NEW.program_id IS NOT NULL THEN
    SELECT program_id INTO template_program FROM "course_templates" WHERE id = NEW.template_id;
    IF template_program IS NOT NULL AND template_program <> NEW.program_id THEN
      RAISE EXCEPTION 'course program does not match the course template program'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'courses_template_program_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "courses_template_program_check"
  BEFORE INSERT OR UPDATE OF "program_id", "template_id" ON "courses"
  FOR EACH ROW EXECUTE FUNCTION "courses_check_template_program"();
