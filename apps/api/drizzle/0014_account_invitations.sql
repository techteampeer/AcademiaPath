CREATE TABLE "account_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "account_invitations_token_hash_format_check" CHECK ("account_invitations"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "account_invitations_expiry_check" CHECK ("account_invitations"."expires_at" > "account_invitations"."created_at"),
	CONSTRAINT "account_invitations_used_or_revoked_check" CHECK ("account_invitations"."used_at" IS NULL OR "account_invitations"."revoked_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_invitations_user_id_idx" ON "account_invitations" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_invitations_one_open_per_user" ON "account_invitations" USING btree ("user_id") WHERE "account_invitations"."used_at" IS NULL AND "account_invitations"."revoked_at" IS NULL;--> statement-breakpoint
-- Custom: activation links are single-use. Once used or revoked a link can never be reopened, its
-- token, owner and expiry never change, and an expired link can never be marked as used (defense in
-- depth behind the API's atomic claim).
CREATE FUNCTION "account_invitations_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."token_hash" <> OLD."token_hash"
    OR NEW."user_id" <> OLD."user_id"
    OR NEW."expires_at" <> OLD."expires_at"
    OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
    OR NEW."created_at" <> OLD."created_at"
    OR (OLD."used_at" IS NOT NULL AND NEW."used_at" IS DISTINCT FROM OLD."used_at")
    OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at") THEN
    RAISE EXCEPTION 'account invitations cannot be altered or reopened' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."used_at" IS NULL AND NEW."used_at" IS NOT NULL AND OLD."expires_at" <= now() THEN
    RAISE EXCEPTION 'an expired account invitation cannot be used' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "account_invitations_single_use"
  BEFORE UPDATE ON "account_invitations"
  FOR EACH ROW EXECUTE FUNCTION "account_invitations_guard"();
