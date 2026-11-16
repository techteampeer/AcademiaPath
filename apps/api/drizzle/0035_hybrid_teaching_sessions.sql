CREATE TYPE "public"."teaching_session_mode" AS ENUM('live_online', 'asynchronous', 'presentation');--> statement-breakpoint
CREATE TABLE "calendar_event_units" (
	"event_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	CONSTRAINT "calendar_event_units_event_id_section_id_pk" PRIMARY KEY("event_id","section_id")
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "session_number" integer;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "session_mode" "teaching_session_mode";--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "join_url" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "session_activity_id" uuid;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_id_course_id_unique" UNIQUE("id","course_id");--> statement-breakpoint
ALTER TABLE "calendar_event_units" ADD CONSTRAINT "calendar_event_units_event_fk" FOREIGN KEY ("event_id","course_id") REFERENCES "public"."calendar_events"("id","course_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_units" ADD CONSTRAINT "calendar_event_units_section_fk" FOREIGN KEY ("section_id","course_id") REFERENCES "public"."sections"("id","course_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_event_units_section_idx" ON "calendar_event_units" USING btree ("section_id");--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_session_activity_id_activities_id_fk" FOREIGN KEY ("session_activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_session_number_unique" ON "calendar_events" USING btree ("course_id","session_number") WHERE "calendar_events"."session_number" IS NOT NULL AND "calendar_events"."status" <> 'cancelled';--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_session_check" CHECK (("calendar_events"."session_number" IS NULL) = ("calendar_events"."session_mode" IS NULL));--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_session_scope_check" CHECK ("calendar_events"."session_mode" IS NULL OR "calendar_events"."scope" = 'course');--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_session_number_check" CHECK ("calendar_events"."session_number" IS NULL OR "calendar_events"."session_number" BETWEEN 1 AND 999);--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_join_url_check" CHECK ("calendar_events"."join_url" IS NULL OR ("calendar_events"."session_mode" IN ('live_online', 'presentation') AND "calendar_events"."join_url" LIKE 'https://%' AND char_length("calendar_events"."join_url") <= 2000));--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_session_activity_check" CHECK ("calendar_events"."session_activity_id" IS NULL OR "calendar_events"."session_mode" IS NOT NULL);