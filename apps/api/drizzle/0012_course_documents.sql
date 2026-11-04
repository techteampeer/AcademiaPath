CREATE TYPE "public"."document_extraction_status" AS ENUM('extracted', 'no_text');--> statement-breakpoint
CREATE TYPE "public"."document_format" AS ENUM('pdf', 'docx', 'pptx');--> statement-breakpoint
CREATE TYPE "public"."document_summary_status" AS ENUM('ready', 'insufficient_text');--> statement-breakpoint
CREATE TYPE "public"."malware_scan_status" AS ENUM('not_scanned', 'clean');--> statement-breakpoint
CREATE TABLE "course_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"storage_key" uuid NOT NULL,
	"file_name" text NOT NULL,
	"format" "document_format" NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"extraction_status" "document_extraction_status" NOT NULL,
	"extraction_detail" text,
	"segments" jsonb NOT NULL,
	"character_count" integer NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"malware_scan_status" "malware_scan_status" NOT NULL,
	"malware_scanner" text NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_documents_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "course_documents_byte_size_check" CHECK ("course_documents"."byte_size" > 0),
	CONSTRAINT "course_documents_sha256_check" CHECK ("course_documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "course_documents_character_count_check" CHECK ("course_documents"."character_count" >= 0),
	CONSTRAINT "course_documents_segments_check" CHECK (jsonb_typeof("course_documents"."segments") = 'array')
);
--> statement-breakpoint
CREATE TABLE "document_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"strategy" text NOT NULL,
	"status" "document_summary_status" NOT NULL,
	"points" jsonb NOT NULL,
	"source_character_count" integer NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_summaries_document_revision_unique" UNIQUE("document_id","revision"),
	CONSTRAINT "document_summaries_revision_check" CHECK ("document_summaries"."revision" >= 1),
	CONSTRAINT "document_summaries_points_check" CHECK (jsonb_typeof("document_summaries"."points") = 'array'),
	CONSTRAINT "document_summaries_status_points_check" CHECK ("document_summaries"."status" = 'ready' OR jsonb_array_length("document_summaries"."points") = 0)
);
--> statement-breakpoint
ALTER TABLE "course_documents" ADD CONSTRAINT "course_documents_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_documents" ADD CONSTRAINT "course_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_summaries" ADD CONSTRAINT "document_summaries_document_id_course_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."course_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_summaries" ADD CONSTRAINT "document_summaries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_documents_activity_id_idx" ON "course_documents" USING btree ("activity_id");