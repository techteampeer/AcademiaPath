CREATE TABLE "storage_recovery_plan_entries" (
	"plan_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"key_ref" text NOT NULL,
	"action" text NOT NULL,
	"generation" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"outcome" text,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "storage_recovery_plan_entries_plan_id_intent_id_pk" PRIMARY KEY("plan_id","intent_id"),
	CONSTRAINT "storage_recovery_plan_entries_operation_check" CHECK ("storage_recovery_plan_entries"."operation" IN ('archive_import', 'document_upload')),
	CONSTRAINT "storage_recovery_plan_entries_key_ref_check" CHECK ("storage_recovery_plan_entries"."key_ref" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "storage_recovery_plan_entries_action_check" CHECK ("storage_recovery_plan_entries"."action" IN ('delete', 'forget_missing', 'forget_referenced')),
	CONSTRAINT "storage_recovery_plan_entries_generation_check" CHECK (("storage_recovery_plan_entries"."action" = 'delete') = ("storage_recovery_plan_entries"."generation" IS NOT NULL) AND ("storage_recovery_plan_entries"."generation" IS NULL OR "storage_recovery_plan_entries"."generation" ~ '^[1-9][0-9]{0,19}$')),
	CONSTRAINT "storage_recovery_plan_entries_state_check" CHECK ("storage_recovery_plan_entries"."state" IN ('pending', 'done', 'skipped', 'failed', 'failed_final')),
	CONSTRAINT "storage_recovery_plan_entries_attempts_check" CHECK ("storage_recovery_plan_entries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "storage_recovery_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"format" text NOT NULL,
	"environment" text NOT NULL,
	"database_identity" text NOT NULL,
	"storage_endpoint" text NOT NULL,
	"bucket" text NOT NULL,
	"object_prefix" text NOT NULL,
	"digest" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"summary" jsonb NOT NULL,
	"created_by_issuer" text NOT NULL,
	"created_by_subject" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_by_issuer" text,
	"approved_by_subject" text,
	"approved_at" timestamp with time zone,
	"revoked_by_issuer" text,
	"revoked_by_subject" text,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"claim_token" uuid,
	"claimed_by_issuer" text,
	"claimed_by_subject" text,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "storage_recovery_plans_status_check" CHECK ("storage_recovery_plans"."status" IN ('draft', 'awaiting_approval', 'approved', 'applying', 'partially_completed', 'completed', 'expired', 'revoked')),
	CONSTRAINT "storage_recovery_plans_digest_check" CHECK ("storage_recovery_plans"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "storage_recovery_plans_expiry_check" CHECK ("storage_recovery_plans"."expires_at" > "storage_recovery_plans"."created_at"),
	CONSTRAINT "storage_recovery_plans_approval_check" CHECK (("storage_recovery_plans"."approved_at" IS NULL) = ("storage_recovery_plans"."approved_by_subject" IS NULL) AND ("storage_recovery_plans"."approved_at" IS NULL) = ("storage_recovery_plans"."approved_by_issuer" IS NULL) AND ("storage_recovery_plans"."status" NOT IN ('approved', 'applying', 'partially_completed', 'completed') OR "storage_recovery_plans"."approved_at" IS NOT NULL)),
	CONSTRAINT "storage_recovery_plans_separation_check" CHECK ("storage_recovery_plans"."approved_by_subject" IS NULL OR NOT ("storage_recovery_plans"."approved_by_issuer" = "storage_recovery_plans"."created_by_issuer" AND "storage_recovery_plans"."approved_by_subject" = "storage_recovery_plans"."created_by_subject")),
	CONSTRAINT "storage_recovery_plans_revocation_check" CHECK (("storage_recovery_plans"."status" = 'revoked') = ("storage_recovery_plans"."revoked_at" IS NOT NULL) AND ("storage_recovery_plans"."revoked_at" IS NULL) = ("storage_recovery_plans"."revoked_by_subject" IS NULL) AND ("storage_recovery_plans"."revoked_at" IS NULL) = ("storage_recovery_plans"."revocation_reason" IS NULL)),
	CONSTRAINT "storage_recovery_plans_claim_check" CHECK ("storage_recovery_plans"."status" <> 'applying' OR ("storage_recovery_plans"."claim_token" IS NOT NULL AND "storage_recovery_plans"."claim_expires_at" IS NOT NULL AND "storage_recovery_plans"."claimed_by_subject" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "storage_recovery_plan_entries" ADD CONSTRAINT "storage_recovery_plan_entries_plan_id_storage_recovery_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."storage_recovery_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_recovery_plan_entries_intent_idx" ON "storage_recovery_plan_entries" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "storage_recovery_plans_status_idx" ON "storage_recovery_plans" USING btree ("status");--> statement-breakpoint
-- AP-OPS-03 (custom): storage recovery plans and their entries are permanent records. A plan is inserted as a draft,
-- given its entries and digest, and leaves `draft` in the same transaction; from then on its contents and digest never
-- change and its status moves only along the lifecycle below. An approval, once given, never changes; approval and
-- execution are impossible after the plan's expiry. Entries can be added only while the plan is a draft, their reviewed
-- contents never change, and outcomes are recorded only while the plan is being applied. Nothing can be deleted or
-- truncated, whatever the connecting role.
CREATE FUNCTION "storage_recovery_plans_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'storage recovery plans are permanent records' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.format IS DISTINCT FROM OLD.format OR NEW.environment IS DISTINCT FROM OLD.environment
    OR NEW.database_identity IS DISTINCT FROM OLD.database_identity OR NEW.storage_endpoint IS DISTINCT FROM OLD.storage_endpoint
    OR NEW.bucket IS DISTINCT FROM OLD.bucket OR NEW.object_prefix IS DISTINCT FROM OLD.object_prefix
    OR NEW.summary IS DISTINCT FROM OLD.summary OR NEW.created_by_issuer IS DISTINCT FROM OLD.created_by_issuer
    OR NEW.created_by_subject IS DISTINCT FROM OLD.created_by_subject OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR (OLD.status <> 'draft' AND NEW.digest IS DISTINCT FROM OLD.digest) THEN
    RAISE EXCEPTION 'storage recovery plan contents are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('completed', 'expired', 'revoked') THEN
    RAISE EXCEPTION 'storage recovery plan is closed (%)', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (
    (OLD.status = 'draft' AND NEW.status = 'awaiting_approval')
    OR (OLD.status = 'awaiting_approval' AND NEW.status IN ('approved', 'revoked', 'expired'))
    OR (OLD.status = 'approved' AND NEW.status IN ('applying', 'revoked', 'expired'))
    OR (OLD.status = 'applying' AND NEW.status IN ('applying', 'partially_completed', 'completed', 'revoked', 'expired'))
    OR (OLD.status = 'partially_completed' AND NEW.status IN ('applying', 'revoked', 'expired'))
  ) THEN
    RAISE EXCEPTION 'invalid storage recovery plan transition from % to %', OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.approved_at IS NOT NULL AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.approved_by_issuer IS DISTINCT FROM OLD.approved_by_issuer OR NEW.approved_by_subject IS DISTINCT FROM OLD.approved_by_subject) THEN
    RAISE EXCEPTION 'a storage recovery approval cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IN ('approved', 'applying') AND now() > NEW.expires_at THEN
    RAISE EXCEPTION 'storage recovery plan has expired' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'expired' AND now() <= NEW.expires_at THEN
    RAISE EXCEPTION 'storage recovery plan has not expired yet' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "storage_recovery_plan_entries_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  plan_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'storage recovery plan entries are permanent records' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT status INTO plan_status FROM storage_recovery_plans WHERE id = NEW.plan_id;
  IF TG_OP = 'INSERT' THEN
    IF plan_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'entries can only be added to a storage recovery plan while it is being created' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.state <> 'pending' OR NEW.outcome IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.attempts <> 0
      OR NEW.last_attempt_at IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new storage recovery plan entry must be pending' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.intent_id IS DISTINCT FROM OLD.intent_id OR NEW.operation IS DISTINCT FROM OLD.operation
    OR NEW.key_ref IS DISTINCT FROM OLD.key_ref OR NEW.action IS DISTINCT FROM OLD.action OR NEW.generation IS DISTINCT FROM OLD.generation THEN
    RAISE EXCEPTION 'storage recovery plan entries are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF plan_status IS DISTINCT FROM 'applying' THEN
    RAISE EXCEPTION 'outcomes are recorded only while a storage recovery plan is being applied' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state IN ('done', 'skipped', 'failed_final') THEN
    RAISE EXCEPTION 'a finished storage recovery plan entry cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "storage_recovery_reject_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% records are permanent: TRUNCATE is not allowed', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "storage_recovery_plans_guard"
  BEFORE UPDATE OR DELETE ON "storage_recovery_plans"
  FOR EACH ROW EXECUTE FUNCTION "storage_recovery_plans_guard"();
--> statement-breakpoint
CREATE TRIGGER "storage_recovery_plan_entries_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "storage_recovery_plan_entries"
  FOR EACH ROW EXECUTE FUNCTION "storage_recovery_plan_entries_guard"();
--> statement-breakpoint
CREATE TRIGGER "storage_recovery_plans_no_truncate"
  BEFORE TRUNCATE ON "storage_recovery_plans"
  FOR EACH STATEMENT EXECUTE FUNCTION "storage_recovery_reject_truncate"();
--> statement-breakpoint
CREATE TRIGGER "storage_recovery_plan_entries_no_truncate"
  BEFORE TRUNCATE ON "storage_recovery_plan_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "storage_recovery_reject_truncate"();
