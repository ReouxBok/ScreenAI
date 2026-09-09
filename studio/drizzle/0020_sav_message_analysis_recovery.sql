ALTER TABLE "sav"."messages" ADD COLUMN "analysis_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "sav"."messages" ADD COLUMN "analysis_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sav"."messages" ADD COLUMN "analysis_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sav"."messages" ADD COLUMN "analysis_error_code" text;--> statement-breakpoint
UPDATE "sav"."messages" SET "analysis_status" = 'done' WHERE "processed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sav_messages_analysis_recovery_idx" ON "sav"."messages" USING btree ("analysis_status","analysis_started_at","analysis_attempts");
