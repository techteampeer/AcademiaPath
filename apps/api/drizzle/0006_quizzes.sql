CREATE TYPE "public"."quiz_attempt_status" AS ENUM('in_progress', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."quiz_question_type" AS ENUM('single_choice', 'multiple_choice', 'true_false');--> statement-breakpoint
CREATE TABLE "quiz_attempt_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" "quiz_question_type" NOT NULL,
	"prompt" text NOT NULL,
	"options" jsonb NOT NULL,
	"correct_answer" jsonb NOT NULL,
	"points" integer NOT NULL,
	"response" jsonb,
	"answered_at" timestamp with time zone,
	"awarded_points" integer,
	"is_correct" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_attempt_answers_attempt_question_unique" UNIQUE("attempt_id","question_id"),
	CONSTRAINT "quiz_attempt_answers_attempt_position_unique" UNIQUE("attempt_id","position"),
	CONSTRAINT "quiz_attempt_answers_points_check" CHECK ("quiz_attempt_answers"."points" BETWEEN 1 AND 100 AND ("quiz_attempt_answers"."awarded_points" IS NULL OR "quiz_attempt_answers"."awarded_points" BETWEEN 0 AND "quiz_attempt_answers"."points"))
);
--> statement-breakpoint
CREATE TABLE "quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"attempt_limit" integer NOT NULL,
	"quiz_version_approved_at" timestamp with time zone NOT NULL,
	"status" "quiz_attempt_status" DEFAULT 'in_progress' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"closed_by_time_limit" boolean DEFAULT false NOT NULL,
	"score" integer,
	"max_score" integer NOT NULL,
	"graded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_attempts_activity_user_number_unique" UNIQUE("activity_id","user_id","attempt_number"),
	CONSTRAINT "quiz_attempts_attempt_number_check" CHECK ("quiz_attempts"."attempt_number" >= 1 AND "quiz_attempts"."attempt_number" <= "quiz_attempts"."attempt_limit"),
	CONSTRAINT "quiz_attempts_status_check" CHECK (("quiz_attempts"."status" = 'in_progress' AND "quiz_attempts"."submitted_at" IS NULL AND "quiz_attempts"."score" IS NULL AND "quiz_attempts"."graded_at" IS NULL) OR ("quiz_attempts"."status" = 'submitted' AND "quiz_attempts"."submitted_at" IS NOT NULL AND "quiz_attempts"."score" IS NOT NULL AND "quiz_attempts"."graded_at" IS NOT NULL)),
	CONSTRAINT "quiz_attempts_score_check" CHECK ("quiz_attempts"."max_score" >= 0 AND ("quiz_attempts"."score" IS NULL OR "quiz_attempts"."score" BETWEEN 0 AND "quiz_attempts"."max_score")),
	CONSTRAINT "quiz_attempts_deadline_check" CHECK ("quiz_attempts"."deadline_at" IS NULL OR "quiz_attempts"."deadline_at" > "quiz_attempts"."started_at")
);
--> statement-breakpoint
CREATE TABLE "quiz_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" "quiz_question_type" NOT NULL,
	"prompt" text NOT NULL,
	"options" jsonb NOT NULL,
	"correct_answer" jsonb NOT NULL,
	"points" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_questions_position_check" CHECK ("quiz_questions"."position" >= 0),
	CONSTRAINT "quiz_questions_points_check" CHECK ("quiz_questions"."points" BETWEEN 1 AND 100),
	CONSTRAINT "quiz_questions_options_check" CHECK (jsonb_typeof("quiz_questions"."options") = 'array'),
	CONSTRAINT "quiz_questions_correct_answer_check" CHECK (jsonb_typeof("quiz_questions"."correct_answer") = 'object')
);
--> statement-breakpoint
-- The composite foreign key below references this constraint, so it must exist first.
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_id_course_id_user_id_unique" UNIQUE("id","course_id","user_id");--> statement-breakpoint
ALTER TABLE "quiz_attempt_answers" ADD CONSTRAINT "quiz_attempt_answers_attempt_id_quiz_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."quiz_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_enrollment_fk" FOREIGN KEY ("enrollment_id","course_id","user_id") REFERENCES "public"."enrollments"("id","course_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_attempts_one_in_progress_idx" ON "quiz_attempts" USING btree ("activity_id","user_id") WHERE "quiz_attempts"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "quiz_attempts_user_id_idx" ON "quiz_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "quiz_attempts_course_id_idx" ON "quiz_attempts" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "quiz_questions_activity_id_position_idx" ON "quiz_questions" USING btree ("activity_id","position");
