-- Custom migration (AP-027): forum topics and replies are a permanent record. Nothing is deleted (moderators
-- hide and restore instead). A post keeps its course, topic, parent, number, author and creation time; its
-- text changes only through an edit, which always sets a new edited_at. Replies are numbered 1, 2, 3… within
-- their topic by first advancing the topic's counter (under its row lock), and a reply to a reply must answer
-- a reply to the topic (one level of nesting).
CREATE FUNCTION "forum_topics_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'forum topics are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.course_id IS DISTINCT FROM OLD.course_id OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
     OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.last_post_number < OLD.last_post_number THEN
    RAISE EXCEPTION 'a forum topic keeps its course, author, creation time and reply numbering' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body)
     AND (NEW.edited_at IS NULL OR NEW.edited_at IS NOT DISTINCT FROM OLD.edited_at) THEN
    RAISE EXCEPTION 'an edited forum topic records when it was edited' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "forum_topics_guard_update"
  BEFORE UPDATE ON "forum_topics"
  FOR EACH ROW EXECUTE FUNCTION "forum_topics_guard"();
--> statement-breakpoint
CREATE TRIGGER "forum_topics_guard_delete"
  BEFORE DELETE ON "forum_topics"
  FOR EACH ROW EXECUTE FUNCTION "forum_topics_guard"();
--> statement-breakpoint
CREATE FUNCTION "forum_posts_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'forum posts are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.post_number IS DISTINCT FROM (SELECT t.last_post_number FROM forum_topics t WHERE t.id = NEW.topic_id) THEN
      RAISE EXCEPTION 'a reply takes the number its topic just assigned' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.parent_post_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM forum_posts p WHERE p.id = NEW.parent_post_id AND p.parent_post_id IS NOT NULL) THEN
      RAISE EXCEPTION 'replies to replies are one level deep' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.course_id IS DISTINCT FROM OLD.course_id OR NEW.topic_id IS DISTINCT FROM OLD.topic_id
     OR NEW.parent_post_id IS DISTINCT FROM OLD.parent_post_id OR NEW.post_number IS DISTINCT FROM OLD.post_number
     OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a forum post keeps its course, topic, parent, number, author and creation time' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body AND (NEW.edited_at IS NULL OR NEW.edited_at IS NOT DISTINCT FROM OLD.edited_at) THEN
    RAISE EXCEPTION 'an edited forum post records when it was edited' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "forum_posts_guard_insert"
  BEFORE INSERT ON "forum_posts"
  FOR EACH ROW EXECUTE FUNCTION "forum_posts_guard"();
--> statement-breakpoint
CREATE TRIGGER "forum_posts_guard_update"
  BEFORE UPDATE ON "forum_posts"
  FOR EACH ROW EXECUTE FUNCTION "forum_posts_guard"();
--> statement-breakpoint
CREATE TRIGGER "forum_posts_guard_delete"
  BEFORE DELETE ON "forum_posts"
  FOR EACH ROW EXECUTE FUNCTION "forum_posts_guard"();
