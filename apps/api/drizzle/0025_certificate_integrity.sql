-- Custom migration (AP-024): certificates are permanent records. They are never deleted, the snapshot
-- printed on a certificate never changes, and the only change allowed is one revocation (with a reason).
CREATE FUNCTION "course_certificates_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'certificates are permanent records and cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'a revoked certificate cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> 'revoked'
    OR (NEW.id, NEW.verification_token, NEW.certificate_number, NEW.course_id, NEW.user_id, NEW.enrollment_id, NEW.recipient_name,
        NEW.course_title, NEW.course_code, NEW.program_name, NEW.term_name, NEW.academic_year, NEW.issuer_name, NEW.policy_version,
        NEW.policy_snapshot, NEW.issued_at, NEW.issued_by_user_id, NEW.created_at)
      IS DISTINCT FROM
       (OLD.id, OLD.verification_token, OLD.certificate_number, OLD.course_id, OLD.user_id, OLD.enrollment_id, OLD.recipient_name,
        OLD.course_title, OLD.course_code, OLD.program_name, OLD.term_name, OLD.academic_year, OLD.issuer_name, OLD.policy_version,
        OLD.policy_snapshot, OLD.issued_at, OLD.issued_by_user_id, OLD.created_at)
  THEN
    RAISE EXCEPTION 'an issued certificate can only be revoked; its details never change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "course_certificates_immutable"
  BEFORE UPDATE OR DELETE ON "course_certificates"
  FOR EACH ROW EXECUTE FUNCTION "course_certificates_guard"();
--> statement-breakpoint
-- A certificate is only ever issued to a student enrollment of its own course.
CREATE FUNCTION "course_certificates_check_enrollment"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "enrollments" e
    WHERE e.id = NEW.enrollment_id AND e.course_id = NEW.course_id AND e.user_id = NEW.user_id AND e.role = 'student'
  ) THEN
    RAISE EXCEPTION 'certificates are issued to students of the course only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "course_certificates_student_enrollment"
  BEFORE INSERT ON "course_certificates"
  FOR EACH ROW EXECUTE FUNCTION "course_certificates_check_enrollment"();
