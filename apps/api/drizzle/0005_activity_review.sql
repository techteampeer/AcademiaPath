CREATE TYPE "public"."activity_review_status" AS ENUM('draft', 'submitted', 'approved', 'returned');--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "review_status" "activity_review_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "review_comment" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "submitted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "reviewed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "approved_title" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "approved_config" jsonb;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_approved_version_check" CHECK (("activities"."approved_title" IS NULL AND "activities"."approved_config" IS NULL AND "activities"."approved_at" IS NULL) OR ("activities"."approved_title" IS NOT NULL AND jsonb_typeof("activities"."approved_config") = 'object' AND "activities"."approved_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_approved_status_check" CHECK ("activities"."review_status" <> 'approved' OR "activities"."approved_config" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_returned_comment_check" CHECK ("activities"."review_status" <> 'returned' OR "activities"."review_comment" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_submitted_check" CHECK ("activities"."review_status" <> 'submitted' OR "activities"."submitted_at" IS NOT NULL);