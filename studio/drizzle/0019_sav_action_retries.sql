ALTER TABLE "sav"."actions" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "sav_actions_retry_schedule_idx" ON "sav"."actions" USING btree ("status","scheduled_at","attempt_count");
--> statement-breakpoint
ALTER TABLE "sav"."pilot_items" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "sav_pilot_items_recovery_idx" ON "sav"."pilot_items" USING btree ("status","updated_at","attempt_count");
