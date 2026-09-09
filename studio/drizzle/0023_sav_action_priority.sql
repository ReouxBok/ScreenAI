ALTER TABLE "sav"."actions" ADD COLUMN "priority" integer DEFAULT 50 NOT NULL;
--> statement-breakpoint
CREATE INDEX "sav_actions_queue_priority_idx" ON "sav"."actions" USING btree ("status", "priority", "created_at");
