CREATE TABLE "activity_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_completions_activity_user_unique" UNIQUE("activity_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "section_prerequisites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"required_section_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "section_prerequisites_section_required_unique" UNIQUE("section_id","required_section_id"),
	CONSTRAINT "section_prerequisites_not_self_check" CHECK ("section_prerequisites"."section_id" <> "section_prerequisites"."required_section_id")
);
--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_id_course_id_unique" UNIQUE("id","course_id");--> statement-breakpoint
ALTER TABLE "activity_completions" ADD CONSTRAINT "activity_completions_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_completions" ADD CONSTRAINT "activity_completions_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_completions" ADD CONSTRAINT "activity_completions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_completions" ADD CONSTRAINT "activity_completions_enrollment_fk" FOREIGN KEY ("enrollment_id","course_id","user_id") REFERENCES "public"."enrollments"("id","course_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_prerequisites" ADD CONSTRAINT "section_prerequisites_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_prerequisites" ADD CONSTRAINT "section_prerequisites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_prerequisites" ADD CONSTRAINT "section_prerequisites_section_fk" FOREIGN KEY ("section_id","course_id") REFERENCES "public"."sections"("id","course_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_prerequisites" ADD CONSTRAINT "section_prerequisites_required_section_fk" FOREIGN KEY ("required_section_id","course_id") REFERENCES "public"."sections"("id","course_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_completions_course_user_idx" ON "activity_completions" USING btree ("course_id","user_id");--> statement-breakpoint
CREATE INDEX "section_prerequisites_course_id_idx" ON "section_prerequisites" USING btree ("course_id");