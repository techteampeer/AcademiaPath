-- Custom migration (AP-026): messages are a permanent record. A message is never deleted, and after it is
-- sent only its "hidden" marker may be set (once, by course moderation); its text, sender, conversation and
-- order never change. A conversation keeps its kind, course and participants.
CREATE FUNCTION "messages_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'messages are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.sender_user_id IS DISTINCT FROM OLD.sender_user_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.client_message_id IS DISTINCT FROM OLD.client_message_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.hidden_at IS NOT NULL AND (NEW.hidden_at IS DISTINCT FROM OLD.hidden_at OR NEW.hidden_by_user_id IS DISTINCT FROM OLD.hidden_by_user_id)) THEN
    RAISE EXCEPTION 'a sent message can only be hidden, once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_guard_update"
  BEFORE UPDATE ON "messages"
  FOR EACH ROW EXECUTE FUNCTION "messages_guard"();
--> statement-breakpoint
CREATE TRIGGER "messages_guard_delete"
  BEFORE DELETE ON "messages"
  FOR EACH ROW EXECUTE FUNCTION "messages_guard"();
--> statement-breakpoint
CREATE FUNCTION "conversations_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.course_id IS DISTINCT FROM OLD.course_id
     OR NEW.participant_low_id IS DISTINCT FROM OLD.participant_low_id OR NEW.participant_high_id IS DISTINCT FROM OLD.participant_high_id THEN
    RAISE EXCEPTION 'a conversation keeps its kind, course and participants' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "conversations_guard_update"
  BEFORE UPDATE ON "conversations"
  FOR EACH ROW EXECUTE FUNCTION "conversations_guard"();
