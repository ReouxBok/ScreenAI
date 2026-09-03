ALTER TABLE "sav"."learning_candidates" ADD COLUMN "source_content_hash" text;--> statement-breakpoint
UPDATE "sav"."learning_candidates" SET "source_content_hash" = 'legacy:' || "id"::text WHERE "source_content_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "sav"."learning_candidates" ALTER COLUMN "source_content_hash" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sav_learning_ticket_content_idx" ON "sav"."learning_candidates" USING btree ("hubspot_ticket_id","source_content_hash");
