CREATE TYPE "public"."announcement_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."calendar_event_status" AS ENUM('hidden', 'published', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."communication_scope" AS ENUM('course', 'institution');--> statement-breakpoint
CREATE TABLE "announcement_reads" (
	"announcement_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_reads_pkey" PRIMARY KEY("announcement_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "communication_scope" NOT NULL,
	"course_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" "announcement_status" DEFAULT 'draft' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"publish_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcements_scope_check" CHECK (("announcements"."scope" = 'course') = ("announcements"."course_id" IS NOT NULL)),
	CONSTRAINT "announcements_title_check" CHECK (char_length("announcements"."title") BETWEEN 1 AND 200),
	CONSTRAINT "announcements_body_check" CHECK (char_length("announcements"."body") BETWEEN 1 AND 10000),
	CONSTRAINT "announcements_publish_check" CHECK ("announcements"."status" = 'draft' OR "announcements"."publish_at" IS NOT NULL OR "announcements"."status" = 'archived'),
	CONSTRAINT "announcements_archived_check" CHECK (("announcements"."status" = 'archived') = ("announcements"."archived_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "communication_scope" NOT NULL,
	"course_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"all_day" boolean NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"start_date" date,
	"end_date" date,
	"time_zone" text NOT NULL,
	"status" "calendar_event_status" DEFAULT 'hidden' NOT NULL,
	"published_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_scope_check" CHECK (("calendar_events"."scope" = 'course') = ("calendar_events"."course_id" IS NOT NULL)),
	CONSTRAINT "calendar_events_title_check" CHECK (char_length("calendar_events"."title") BETWEEN 1 AND 200),
	CONSTRAINT "calendar_events_description_check" CHECK ("calendar_events"."description" IS NULL OR char_length("calendar_events"."description") BETWEEN 1 AND 5000),
	CONSTRAINT "calendar_events_range_check" CHECK ("calendar_events"."ends_at" > "calendar_events"."starts_at"),
	CONSTRAINT "calendar_events_all_day_check" CHECK (("calendar_events"."all_day" AND "calendar_events"."start_date" IS NOT NULL AND "calendar_events"."end_date" IS NOT NULL AND "calendar_events"."end_date" >= "calendar_events"."start_date")
        OR (NOT "calendar_events"."all_day" AND "calendar_events"."start_date" IS NULL AND "calendar_events"."end_date" IS NULL)),
	CONSTRAINT "calendar_events_time_zone_check" CHECK (char_length("calendar_events"."time_zone") BETWEEN 1 AND 64),
	CONSTRAINT "calendar_events_cancelled_check" CHECK (("calendar_events"."status" = 'cancelled') = ("calendar_events"."cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcement_reads_user_idx" ON "announcement_reads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "announcements_course_visible_idx" ON "announcements" USING btree ("course_id","status","publish_at");--> statement-breakpoint
CREATE INDEX "announcements_scope_status_idx" ON "announcements" USING btree ("scope","status","publish_at");--> statement-breakpoint
CREATE INDEX "calendar_events_course_range_idx" ON "calendar_events" USING btree ("course_id","starts_at");--> statement-breakpoint
CREATE INDEX "calendar_events_scope_range_idx" ON "calendar_events" USING btree ("scope","starts_at");