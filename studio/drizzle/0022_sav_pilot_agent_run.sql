ALTER TABLE "sav"."pilot_items" ADD COLUMN "agent_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "sav"."pilot_items" ADD CONSTRAINT "pilot_items_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "sav"."agent_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "sav_pilot_items_agent_run_idx" ON "sav"."pilot_items" USING btree ("agent_run_id");
