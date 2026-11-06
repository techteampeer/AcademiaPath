ALTER TABLE "courses" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_version_check" CHECK ("courses"."version" >= 1);