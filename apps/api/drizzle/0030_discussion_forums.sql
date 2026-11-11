ALTER TYPE "public"."notification_type" ADD VALUE 'forum_reply';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'forum_topic';--> statement-breakpoint
CREATE TABLE "forum_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"parent_post_id" uuid,
	"post_number" integer NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"client_request_id" uuid NOT NULL,
	"hidden_at" timestamp with time zone,
	"hidden_by_user_id" uuid,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forum_posts_id_topic_unique" UNIQUE("id","topic_id"),
	CONSTRAINT "forum_posts_body_check" CHECK (char_length("forum_posts"."body") BETWEEN 1 AND 10000 AND "forum_posts"."body" ~ '\S'),
	CONSTRAINT "forum_posts_number_check" CHECK ("forum_posts"."post_number" >= 1),
	CONSTRAINT "forum_posts_parent_check" CHECK ("forum_posts"."parent_post_id" IS NULL OR "forum_posts"."parent_post_id" <> "forum_posts"."id"),
	CONSTRAINT "forum_posts_hidden_check" CHECK (("forum_posts"."hidden_at" IS NULL) = ("forum_posts"."hidden_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "forum_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"client_request_id" uuid NOT NULL,
	"last_post_number" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pinned_at" timestamp with time zone,
	"pinned_by_user_id" uuid,
	"locked_at" timestamp with time zone,
	"locked_by_user_id" uuid,
	"hidden_at" timestamp with time zone,
	"hidden_by_user_id" uuid,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forum_topics_id_course_unique" UNIQUE("id","course_id"),
	CONSTRAINT "forum_topics_title_check" CHECK (char_length("forum_topics"."title") BETWEEN 1 AND 200 AND "forum_topics"."title" ~ '\S'),
	CONSTRAINT "forum_topics_body_check" CHECK (char_length("forum_topics"."body") BETWEEN 1 AND 10000 AND "forum_topics"."body" ~ '\S'),
	CONSTRAINT "forum_topics_post_number_check" CHECK ("forum_topics"."last_post_number" >= 0),
	CONSTRAINT "forum_topics_pinned_check" CHECK (("forum_topics"."pinned_at" IS NULL) = ("forum_topics"."pinned_by_user_id" IS NULL)),
	CONSTRAINT "forum_topics_locked_check" CHECK (("forum_topics"."locked_at" IS NULL) = ("forum_topics"."locked_by_user_id" IS NULL)),
	CONSTRAINT "forum_topics_hidden_check" CHECK (("forum_topics"."hidden_at" IS NULL) = ("forum_topics"."hidden_by_user_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "forum_posts" ADD CONSTRAINT "forum_posts_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_posts" ADD CONSTRAINT "forum_posts_hidden_by_user_id_users_id_fk" FOREIGN KEY ("hidden_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_posts" ADD CONSTRAINT "forum_posts_topic_fk" FOREIGN KEY ("topic_id","course_id") REFERENCES "public"."forum_topics"("id","course_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_posts" ADD CONSTRAINT "forum_posts_parent_fk" FOREIGN KEY ("parent_post_id","topic_id") REFERENCES "public"."forum_posts"("id","topic_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD CONSTRAINT "forum_topics_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD CONSTRAINT "forum_topics_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD CONSTRAINT "forum_topics_pinned_by_user_id_users_id_fk" FOREIGN KEY ("pinned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD CONSTRAINT "forum_topics_locked_by_user_id_users_id_fk" FOREIGN KEY ("locked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD CONSTRAINT "forum_topics_hidden_by_user_id_users_id_fk" FOREIGN KEY ("hidden_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "forum_posts_topic_number_unique" ON "forum_posts" USING btree ("topic_id","post_number");--> statement-breakpoint
CREATE UNIQUE INDEX "forum_posts_client_request_unique" ON "forum_posts" USING btree ("topic_id","author_user_id","client_request_id");--> statement-breakpoint
CREATE INDEX "forum_posts_parent_idx" ON "forum_posts" USING btree ("parent_post_id");--> statement-breakpoint
CREATE INDEX "forum_posts_author_created_idx" ON "forum_posts" USING btree ("author_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "forum_topics_client_request_unique" ON "forum_topics" USING btree ("course_id","author_user_id","client_request_id");--> statement-breakpoint
CREATE INDEX "forum_topics_course_activity_idx" ON "forum_topics" USING btree ("course_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "forum_topics_author_created_idx" ON "forum_topics" USING btree ("author_user_id","created_at");