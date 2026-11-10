CREATE TYPE "public"."certificate_status" AS ENUM('issued', 'revoked');--> statement-breakpoint
CREATE TABLE "course_certificate_policies" (
	"course_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"require_completion" boolean NOT NULL,
	"require_final_grade" boolean NOT NULL,
	"minimum_grade_percent" integer,
	"issuer_name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_certificate_policies_requirement_check" CHECK ("course_certificate_policies"."require_completion" OR "course_certificate_policies"."require_final_grade"),
	CONSTRAINT "course_certificate_policies_minimum_check" CHECK ("course_certificate_policies"."minimum_grade_percent" IS NULL OR ("course_certificate_policies"."minimum_grade_percent" BETWEEN 1 AND 100 AND "course_certificate_policies"."require_final_grade")),
	CONSTRAINT "course_certificate_policies_issuer_check" CHECK (char_length("course_certificate_policies"."issuer_name") BETWEEN 1 AND 120),
	CONSTRAINT "course_certificate_policies_version_check" CHECK ("course_certificate_policies"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "course_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verification_token" text NOT NULL,
	"certificate_number" text NOT NULL,
	"course_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"recipient_name" text NOT NULL,
	"course_title" text NOT NULL,
	"course_code" text NOT NULL,
	"program_name" text,
	"term_name" text NOT NULL,
	"academic_year" integer NOT NULL,
	"issuer_name" text NOT NULL,
	"policy_version" integer NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"status" "certificate_status" DEFAULT 'issued' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_certificates_verification_token_unique" UNIQUE("verification_token"),
	CONSTRAINT "course_certificates_number_unique" UNIQUE("certificate_number"),
	CONSTRAINT "course_certificates_token_check" CHECK ("course_certificates"."verification_token" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "course_certificates_number_check" CHECK ("course_certificates"."certificate_number" ~ '^AP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
	CONSTRAINT "course_certificates_revocation_check" CHECK (("course_certificates"."status" = 'issued' AND "course_certificates"."revoked_at" IS NULL AND "course_certificates"."revoked_by_user_id" IS NULL AND "course_certificates"."revocation_reason" IS NULL)
        OR ("course_certificates"."status" = 'revoked' AND "course_certificates"."revoked_at" IS NOT NULL AND "course_certificates"."revoked_by_user_id" IS NOT NULL AND char_length("course_certificates"."revocation_reason") BETWEEN 1 AND 500))
);
--> statement-breakpoint
ALTER TABLE "course_certificate_policies" ADD CONSTRAINT "course_certificate_policies_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_certificate_policies" ADD CONSTRAINT "course_certificate_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_certificates" ADD CONSTRAINT "course_certificates_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_certificates" ADD CONSTRAINT "course_certificates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_certificates" ADD CONSTRAINT "course_certificates_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_certificates" ADD CONSTRAINT "course_certificates_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_certificates" ADD CONSTRAINT "course_certificates_enrollment_fk" FOREIGN KEY ("enrollment_id","course_id","user_id") REFERENCES "public"."enrollments"("id","course_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_certificates_one_issued_unique" ON "course_certificates" USING btree ("course_id","user_id") WHERE "course_certificates"."status" = 'issued';--> statement-breakpoint
CREATE INDEX "course_certificates_user_idx" ON "course_certificates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "course_certificates_course_idx" ON "course_certificates" USING btree ("course_id");