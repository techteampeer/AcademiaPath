-- Custom migration (AP-028): groups and memberships are a permanent record. Nothing is deleted: a group is
-- archived and a membership is closed. A group keeps its course and creator; a membership keeps its group,
-- course, student and opening, and once closed it stays closed (adding the student again opens a new one).
-- A membership is opened only for an active student enrollment of the group's course, in an active group.
-- A forum topic keeps its group (course-wide topics stay course-wide).
CREATE FUNCTION "student_groups_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'student groups are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.course_id IS DISTINCT FROM OLD.course_id OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a student group keeps its course, creator and creation time' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "student_groups_guard_update"
  BEFORE UPDATE ON "student_groups"
  FOR EACH ROW EXECUTE FUNCTION "student_groups_guard"();
--> statement-breakpoint
CREATE TRIGGER "student_groups_guard_delete"
  BEFORE DELETE ON "student_groups"
  FOR EACH ROW EXECUTE FUNCTION "student_groups_guard"();
--> statement-breakpoint
CREATE FUNCTION "student_group_members_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'group memberships are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a membership is opened before it is closed' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.course_id = NEW.course_id AND e.user_id = NEW.user_id
                   AND e.role = 'student' AND e.status = 'active') THEN
      RAISE EXCEPTION 'only active students of the course can join its groups' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM student_groups g WHERE g.id = NEW.group_id AND g.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'an archived group takes no new members' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.group_id IS DISTINCT FROM OLD.group_id OR NEW.course_id IS DISTINCT FROM OLD.course_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.added_by_user_id IS DISTINCT FROM OLD.added_by_user_id
     OR NEW.added_at IS DISTINCT FROM OLD.added_at
     OR (OLD.removed_at IS NOT NULL AND (NEW.removed_at IS DISTINCT FROM OLD.removed_at OR NEW.removed_by_user_id IS DISTINCT FROM OLD.removed_by_user_id)) THEN
    RAISE EXCEPTION 'a membership can only be closed, once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "student_group_members_guard_insert"
  BEFORE INSERT ON "student_group_members"
  FOR EACH ROW EXECUTE FUNCTION "student_group_members_guard"();
--> statement-breakpoint
CREATE TRIGGER "student_group_members_guard_update"
  BEFORE UPDATE ON "student_group_members"
  FOR EACH ROW EXECUTE FUNCTION "student_group_members_guard"();
--> statement-breakpoint
CREATE TRIGGER "student_group_members_guard_delete"
  BEFORE DELETE ON "student_group_members"
  FOR EACH ROW EXECUTE FUNCTION "student_group_members_guard"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "forum_topics_guard"() RETURNS trigger
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
  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    RAISE EXCEPTION 'a forum topic keeps its group' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body)
     AND (NEW.edited_at IS NULL OR NEW.edited_at IS NOT DISTINCT FROM OLD.edited_at) THEN
    RAISE EXCEPTION 'an edited forum topic records when it was edited' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
