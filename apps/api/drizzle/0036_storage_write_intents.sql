CREATE TABLE "document_storage_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" uuid NOT NULL,
	"operation" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	CONSTRAINT "document_storage_intents_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "document_storage_intents_operation_check" CHECK ("document_storage_intents"."operation" IN ('archive_import')),
	CONSTRAINT "document_storage_intents_attempts_check" CHECK ("document_storage_intents"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "document_storage_intents" ADD CONSTRAINT "document_storage_intents_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_storage_intents_lease_idx" ON "document_storage_intents" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "document_storage_intents_operation_idx" ON "document_storage_intents" USING btree ("operation_id");