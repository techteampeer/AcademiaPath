CREATE TABLE "course_template_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_version_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"position" integer NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_template_sections_version_position_unique" UNIQUE("template_version_id","position"),
	CONSTRAINT "course_template_sections_position_check" CHECK ("course_template_sections"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "course_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_template_versions_template_id_version_unique" UNIQUE("template_id","version"),
	CONSTRAINT "course_template_versions_id_template_id_unique" UNIQUE("id","template_id"),
	CONSTRAINT "course_template_versions_version_check" CHECK ("course_template_versions"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "program_id" uuid;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "template_version_id" uuid;--> statement-breakpoint
ALTER TABLE "course_template_sections" ADD CONSTRAINT "course_template_sections_template_version_id_course_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."course_template_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_template_versions" ADD CONSTRAINT "course_template_versions_template_id_course_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."course_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_template_version_fk" FOREIGN KEY ("template_version_id","template_id") REFERENCES "public"."course_template_versions"("id","template_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "courses_program_id_idx" ON "courses" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "courses_template_version_id_idx" ON "courses" USING btree ("template_version_id");