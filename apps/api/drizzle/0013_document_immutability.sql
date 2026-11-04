-- Custom migration: uploaded documents and summary revisions are immutable once stored. Refreshing a
-- summary inserts a new revision, so approved material can never be rewritten in place. Deletes are
-- still allowed so removing a course or activity cascades.
CREATE FUNCTION "document_records_reject_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "course_documents_immutable"
  BEFORE UPDATE ON "course_documents"
  FOR EACH ROW EXECUTE FUNCTION "document_records_reject_update"();
--> statement-breakpoint
CREATE TRIGGER "document_summaries_immutable"
  BEFORE UPDATE ON "document_summaries"
  FOR EACH ROW EXECUTE FUNCTION "document_records_reject_update"();
