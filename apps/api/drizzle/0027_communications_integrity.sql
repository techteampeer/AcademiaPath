-- Custom migration (AP-025): announcements are archived, never deleted, and a calendar event that students
-- could ever see is cancelled, never deleted, so the history stays complete. Reads cascade only when an
-- announcement or user row is removed, which these rules and the existing user rules never allow.
CREATE FUNCTION "announcements_reject_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'announcements are archived, never deleted' USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "announcements_no_delete"
  BEFORE DELETE ON "announcements"
  FOR EACH ROW EXECUTE FUNCTION "announcements_reject_delete"();
--> statement-breakpoint
CREATE FUNCTION "calendar_events_guard_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'a calendar event that was published can only be cancelled' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "calendar_events_no_delete_after_publish"
  BEFORE DELETE ON "calendar_events"
  FOR EACH ROW EXECUTE FUNCTION "calendar_events_guard_delete"();
