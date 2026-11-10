CREATE TYPE "public"."grading_policy_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TABLE "course_grading_policies" (
	"course_id" uuid PRIMARY KEY NOT NULL,
	"status" "grading_policy_status" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_grading_policies_version_check" CHECK ("course_grading_policies"."version" >= 1),
	CONSTRAINT "course_grading_policies_published_check" CHECK (("course_grading_policies"."status" = 'published') = ("course_grading_policies"."published_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "grade_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"name" text NOT NULL,
	"weight_percent" integer NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grade_categories_id_course_unique" UNIQUE("id","course_id"),
	CONSTRAINT "grade_categories_course_position_unique" UNIQUE("course_id","position"),
	CONSTRAINT "grade_categories_name_check" CHECK (char_length("grade_categories"."name") BETWEEN 1 AND 80),
	CONSTRAINT "grade_categories_weight_check" CHECK ("grade_categories"."weight_percent" BETWEEN 1 AND 100),
	CONSTRAINT "grade_categories_position_check" CHECK ("grade_categories"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "grade_category_activities" (
	"activity_id" uuid PRIMARY KEY NOT NULL,
	"category_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "grades" ADD COLUMN "released_quiz_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "course_grading_policies" ADD CONSTRAINT "course_grading_policies_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_grading_policies" ADD CONSTRAINT "course_grading_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_categories" ADD CONSTRAINT "grade_categories_course_id_course_grading_policies_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course_grading_policies"("course_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_category_activities" ADD CONSTRAINT "grade_category_activities_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_category_activities" ADD CONSTRAINT "grade_category_activities_category_fk" FOREIGN KEY ("category_id","course_id") REFERENCES "public"."grade_categories"("id","course_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grade_categories_course_name_unique" ON "grade_categories" USING btree ("course_id",lower("name"));--> statement-breakpoint
CREATE INDEX "grade_category_activities_category_idx" ON "grade_category_activities" USING btree ("category_id");--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_released_quiz_attempt_fk" FOREIGN KEY ("released_quiz_attempt_id","activity_id","user_id") REFERENCES "public"."quiz_attempts"("id","activity_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_released_quiz_attempt_check" CHECK ("grades"."released_quiz_attempt_id" IS NULL OR ("grades"."source" = 'quiz' AND "grades"."released_revision" IS NOT NULL));