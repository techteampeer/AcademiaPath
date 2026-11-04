-- Additive: store the academic year on each term. Existing terms are backfilled from a Peru-style
-- code prefix (for example 2026-2 → 2026), otherwise from the start date, before NOT NULL is set.
ALTER TABLE "terms" ADD COLUMN "academic_year" integer;--> statement-breakpoint
UPDATE "terms" SET "academic_year" = CASE
  WHEN "code" ~ '^[0-9]{4}-' AND substr("code", 1, 4)::integer BETWEEN 2000 AND 2100 THEN substr("code", 1, 4)::integer
  ELSE LEAST(GREATEST(EXTRACT(YEAR FROM "starts_on")::integer, 2000), 2100)
END;--> statement-breakpoint
ALTER TABLE "terms" ALTER COLUMN "academic_year" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "terms_academic_year_idx" ON "terms" USING btree ("academic_year");--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_academic_year_check" CHECK ("terms"."academic_year" BETWEEN 2000 AND 2100);
