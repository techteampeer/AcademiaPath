CREATE TABLE "student_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" uuid,
	CONSTRAINT "student_group_members_removed_check" CHECK (("student_group_members"."removed_at" IS NULL) = ("student_group_members"."removed_by_user_id" IS NULL) AND ("student_group_members"."removed_at" IS NULL OR "student_group_members"."removed_at" >= "student_group_members"."added_at"))
);
--> statement-breakpoint
CREATE TABLE "student_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by_user_id" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_groups_id_course_unique" UNIQUE("id","course_id"),
	CONSTRAINT "student_groups_name_check" CHECK (char_length("student_groups"."name") BETWEEN 1 AND 100 AND "student_groups"."name" ~ '\S'),
	CONSTRAINT "student_groups_description_check" CHECK ("student_groups"."description" IS NULL OR char_length("student_groups"."description") <= 1000),
	CONSTRAINT "student_groups_archived_check" CHECK (("student_groups"."archived_at" IS NULL) = ("student_groups"."archived_by_user_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "forum_topics" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "student_group_members" ADD CONSTRAINT "student_group_members_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_group_members" ADD CONSTRAINT "student_group_members_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_group_members" ADD CONSTRAINT "student_group_members_group_fk" FOREIGN KEY ("group_id","course_id") REFERENCES "public"."student_groups"("id","course_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_group_members" ADD CONSTRAINT "student_group_members_enrollment_fk" FOREIGN KEY ("course_id","user_id") REFERENCES "public"."enrollments"("course_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_groups" ADD CONSTRAINT "student_groups_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_groups" ADD CONSTRAINT "student_groups_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_groups" ADD CONSTRAINT "student_groups_archived_by_user_id_users_id_fk" FOREIGN KEY ("archived_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "student_group_members_open_unique" ON "student_group_members" USING btree ("group_id","user_id") WHERE "student_group_members"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "student_group_members_user_idx" ON "student_group_members" USING btree ("user_id","course_id");--> statement-breakpoint
CREATE INDEX "student_group_members_group_idx" ON "student_group_members" USING btree ("group_id","added_at");--> statement-breakpoint
CREATE UNIQUE INDEX "student_groups_course_name_unique" ON "student_groups" USING btree ("course_id",lower("name")) WHERE "student_groups"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "student_groups_course_idx" ON "student_groups" USING btree ("course_id");--> statement-breakpoint
ALTER TABLE "forum_topics" ADD CONSTRAINT "forum_topics_group_fk" FOREIGN KEY ("group_id","course_id") REFERENCES "public"."student_groups"("id","course_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forum_topics_group_activity_idx" ON "forum_topics" USING btree ("group_id","last_activity_at");