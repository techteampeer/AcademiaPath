CREATE TABLE "resource_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_folders_id_section_id_unique" UNIQUE("id","section_id"),
	CONSTRAINT "resource_folders_position_check" CHECK ("resource_folders"."position" >= 0),
	CONSTRAINT "resource_folders_title_check" CHECK (char_length("resource_folders"."title") BETWEEN 1 AND 120)
);
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "resource_folders" ADD CONSTRAINT "resource_folders_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_folders" ADD CONSTRAINT "resource_folders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_folders" ADD CONSTRAINT "resource_folders_section_fk" FOREIGN KEY ("section_id","course_id") REFERENCES "public"."sections"("id","course_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_folders_section_id_position_idx" ON "resource_folders" USING btree ("section_id","position");--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_folder_fk" FOREIGN KEY ("folder_id","section_id") REFERENCES "public"."resource_folders"("id","section_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_folder_id_idx" ON "activities" USING btree ("folder_id");--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_folder_type_check" CHECK ("activities"."folder_id" IS NULL OR "activities"."type" IN ('page', 'link', 'file'));