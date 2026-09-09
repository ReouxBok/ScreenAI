ALTER TABLE "sav"."learning_candidates" ADD COLUMN "source_ref" text;--> statement-breakpoint
UPDATE "sav"."learning_candidates" SET "source_ref" = 'hubspot:' || "hubspot_ticket_id" WHERE "source_ref" IS NULL;--> statement-breakpoint
ALTER TABLE "sav"."learning_candidates" ALTER COLUMN "source_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sav"."learning_candidates" ALTER COLUMN "hubspot_ticket_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "sav"."sav_learning_ticket_content_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "sav_learning_source_content_idx" ON "sav"."learning_candidates" USING btree ("source_ref","source_content_hash");
--> statement-breakpoint
ALTER TABLE "sav"."resolution_evidence" ADD COLUMN "source_ref" text;--> statement-breakpoint
UPDATE "sav"."resolution_evidence" SET "source_ref" = 'hubspot:' || "hubspot_ticket_id" WHERE "source_ref" IS NULL;--> statement-breakpoint
ALTER TABLE "sav"."resolution_evidence" ALTER COLUMN "source_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sav"."resolution_evidence" ALTER COLUMN "hubspot_ticket_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "sav"."sav_resolution_evidence_version_ticket_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "sav_resolution_evidence_version_source_idx" ON "sav"."resolution_evidence" USING btree ("version_id","source_ref");
