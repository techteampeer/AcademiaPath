CREATE TYPE "public"."grade_source" AS ENUM('quiz', 'assignment');--> statement-breakpoint
CREATE TABLE "assignment_criterion_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"points" integer NOT NULL,
	"max_points" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_criterion_scores_submission_criterion_unique" UNIQUE("submission_id","criterion_id"),
	CONSTRAINT "assignment_criterion_scores_points_check" CHECK ("assignment_criterion_scores"."points" >= 0 AND "assignment_criterion_scores"."points" <= "assignment_criterion_scores"."max_points"),
	CONSTRAINT "assignment_criterion_scores_max_points_check" CHECK ("assignment_criterion_scores"."max_points" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "assignment_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"rubric" jsonb NOT NULL,
	"max_points" integer NOT NULL,
	"assignment_version_approved_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"late_until" timestamp with time zone,
	"is_late" boolean NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_submissions_activity_user_unique" UNIQUE("activity_id","user_id"),
	CONSTRAINT "assignment_submissions_id_activity_user_unique" UNIQUE("id","activity_id","user_id"),
	CONSTRAINT "assignment_submissions_body_check" CHECK (char_length("assignment_submissions"."body") BETWEEN 1 AND 50000),
	CONSTRAINT "assignment_submissions_rubric_check" CHECK (jsonb_typeof("assignment_submissions"."rubric") = 'array' AND jsonb_array_length("assignment_submissions"."rubric") BETWEEN 1 AND 20),
	CONSTRAINT "assignment_submissions_max_points_check" CHECK ("assignment_submissions"."max_points" BETWEEN 1 AND 2000),
	CONSTRAINT "assignment_submissions_late_until_check" CHECK ("assignment_submissions"."late_until" IS NULL OR "assignment_submissions"."late_until" > "assignment_submissions"."due_at"),
	CONSTRAINT "assignment_submissions_window_check" CHECK ("assignment_submissions"."submitted_at" <= COALESCE("assignment_submissions"."late_until", "assignment_submissions"."due_at")),
	CONSTRAINT "assignment_submissions_is_late_check" CHECK ("assignment_submissions"."is_late" = ("assignment_submissions"."submitted_at" > "assignment_submissions"."due_at"))
);
--> statement-breakpoint
CREATE TABLE "grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"source" "grade_source" NOT NULL,
	"quiz_attempt_id" uuid,
	"submission_id" uuid,
	"points" integer NOT NULL,
	"max_points" integer NOT NULL,
	"feedback" text,
	"graded_by_user_id" uuid,
	"graded_at" timestamp with time zone NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"released_revision" integer,
	"released_points" integer,
	"released_max_points" integer,
	"released_detail" jsonb,
	"released_at" timestamp with time zone,
	"released_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grades_activity_user_unique" UNIQUE("activity_id","user_id"),
	CONSTRAINT "grades_source_check" CHECK (("grades"."source" = 'quiz' AND "grades"."quiz_attempt_id" IS NOT NULL AND "grades"."submission_id" IS NULL AND "grades"."graded_by_user_id" IS NULL)
        OR ("grades"."source" = 'assignment' AND "grades"."submission_id" IS NOT NULL AND "grades"."quiz_attempt_id" IS NULL AND "grades"."graded_by_user_id" IS NOT NULL)),
	CONSTRAINT "grades_points_check" CHECK ("grades"."max_points" >= 1 AND "grades"."points" >= 0 AND "grades"."points" <= "grades"."max_points"),
	CONSTRAINT "grades_revision_check" CHECK ("grades"."revision" >= 1),
	CONSTRAINT "grades_release_check" CHECK (("grades"."released_revision" IS NULL AND "grades"."released_points" IS NULL AND "grades"."released_max_points" IS NULL AND "grades"."released_detail" IS NULL AND "grades"."released_at" IS NULL AND "grades"."released_by_user_id" IS NULL)
        OR ("grades"."released_revision" BETWEEN 1 AND "grades"."revision" AND "grades"."released_max_points" >= 1 AND "grades"."released_points" BETWEEN 0 AND "grades"."released_max_points"
          AND "grades"."released_detail" IS NOT NULL AND "grades"."released_at" IS NOT NULL AND "grades"."released_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
-- grades_quiz_attempt_fk below references this constraint, so it must exist first.
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_id_activity_user_unique" UNIQUE("id","activity_id","user_id");--> statement-breakpoint
ALTER TABLE "assignment_criterion_scores" ADD CONSTRAINT "assignment_criterion_scores_submission_id_assignment_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."assignment_submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_enrollment_fk" FOREIGN KEY ("enrollment_id","course_id","user_id") REFERENCES "public"."enrollments"("id","course_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_graded_by_user_id_users_id_fk" FOREIGN KEY ("graded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_enrollment_fk" FOREIGN KEY ("enrollment_id","course_id","user_id") REFERENCES "public"."enrollments"("id","course_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_quiz_attempt_fk" FOREIGN KEY ("quiz_attempt_id","activity_id","user_id") REFERENCES "public"."quiz_attempts"("id","activity_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_submission_fk" FOREIGN KEY ("submission_id","activity_id","user_id") REFERENCES "public"."assignment_submissions"("id","activity_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_submissions_course_id_idx" ON "assignment_submissions" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "assignment_submissions_user_id_idx" ON "assignment_submissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "grades_course_id_user_id_idx" ON "grades" USING btree ("course_id","user_id");
