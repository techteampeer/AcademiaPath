CREATE TYPE "public"."tutor_outcome" AS ENUM('grounded', 'insufficient_material');--> statement-breakpoint
CREATE TYPE "public"."tutor_request_kind" AS ENUM('message', 'practice');--> statement-breakpoint
CREATE TABLE "tutor_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"kind" "tutor_request_kind" NOT NULL,
	"language" "locale" NOT NULL,
	"provider_mode" text NOT NULL,
	"outcome" "tutor_outcome" NOT NULL,
	"source_activity_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tutor_usage_provider_mode_check" CHECK ("tutor_usage"."provider_mode" IN ('mock')),
	CONSTRAINT "tutor_usage_sources_check" CHECK (cardinality("tutor_usage"."source_activity_ids") <= 3)
);
--> statement-breakpoint
ALTER TABLE "tutor_usage" ADD CONSTRAINT "tutor_usage_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_usage" ADD CONSTRAINT "tutor_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_usage" ADD CONSTRAINT "tutor_usage_enrollment_fk" FOREIGN KEY ("enrollment_id","course_id","user_id") REFERENCES "public"."enrollments"("id","course_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tutor_usage_course_user_created_idx" ON "tutor_usage" USING btree ("course_id","user_id","created_at");