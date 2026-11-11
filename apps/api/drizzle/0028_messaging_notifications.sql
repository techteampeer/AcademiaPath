CREATE TYPE "public"."conversation_kind" AS ENUM('direct', 'course');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('direct_message', 'course_message', 'announcement', 'grade_released', 'certificate_issued');--> statement-breakpoint
CREATE TABLE "conversation_reads" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_reads_pkey" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "conversation_kind" NOT NULL,
	"course_id" uuid NOT NULL,
	"participant_low_id" uuid,
	"participant_high_id" uuid,
	"locked_at" timestamp with time zone,
	"locked_by_user_id" uuid,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_kind_check" CHECK (("conversations"."kind" = 'direct') = ("conversations"."participant_low_id" IS NOT NULL AND "conversations"."participant_high_id" IS NOT NULL)),
	CONSTRAINT "conversations_pair_order_check" CHECK ("conversations"."participant_low_id" IS NULL OR "conversations"."participant_low_id" < "conversations"."participant_high_id"),
	CONSTRAINT "conversations_lock_check" CHECK (("conversations"."kind" = 'course' OR "conversations"."locked_at" IS NULL) AND ("conversations"."locked_at" IS NULL) = ("conversations"."locked_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"conversation_id" uuid NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"client_message_id" uuid,
	"hidden_at" timestamp with time zone,
	"hidden_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_body_check" CHECK (char_length("messages"."body") BETWEEN 1 AND 4000 AND "messages"."body" ~ '\S'),
	CONSTRAINT "messages_hidden_check" CHECK (("messages"."hidden_at" IS NULL) = ("messages"."hidden_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"course_id" uuid,
	"entity_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_check" CHECK (char_length("notifications"."dedupe_key") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_participant_low_id_users_id_fk" FOREIGN KEY ("participant_low_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_participant_high_id_users_id_fk" FOREIGN KEY ("participant_high_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_locked_by_user_id_users_id_fk" FOREIGN KEY ("locked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_hidden_by_user_id_users_id_fk" FOREIGN KEY ("hidden_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_reads_user_idx" ON "conversation_reads" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_course_unique" ON "conversations" USING btree ("course_id") WHERE "conversations"."kind" = 'course';--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_direct_pair_unique" ON "conversations" USING btree ("course_id","participant_low_id","participant_high_id") WHERE "conversations"."kind" = 'direct';--> statement-breakpoint
CREATE INDEX "conversations_participant_low_idx" ON "conversations" USING btree ("participant_low_id");--> statement-breakpoint
CREATE INDEX "conversations_participant_high_idx" ON "conversations" USING btree ("participant_high_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_seq_unique" ON "messages" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "messages_conversation_seq_idx" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "messages_sender_created_idx" ON "messages" USING btree ("sender_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_message_unique" ON "messages" USING btree ("conversation_id","sender_user_id","client_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_dedupe_unique" ON "notifications" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_user_event_idx" ON "notifications" USING btree ("user_id","event_at");--> statement-breakpoint
CREATE INDEX "notifications_dedupe_idx" ON "notifications" USING btree ("dedupe_key");