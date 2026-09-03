CREATE TABLE "sav"."agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"pilot_batch_id" uuid,
	"scope" text DEFAULT 'sav_ticket_analysis' NOT NULL,
	"runtime" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"prompt_revision" text NOT NULL,
	"input_hash" text NOT NULL,
	"output_hash" text,
	"decision_kind" text,
	"confidence" integer,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_trace" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fallback_runtime" text,
	"error_code" text,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sav"."agent_runs" ADD CONSTRAINT "agent_runs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "sav"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."agent_runs" ADD CONSTRAINT "agent_runs_pilot_batch_id_pilot_batches_id_fk" FOREIGN KEY ("pilot_batch_id") REFERENCES "sav"."pilot_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sav_agent_runs_message_created_idx" ON "sav"."agent_runs" USING btree ("message_id","created_at");--> statement-breakpoint
CREATE INDEX "sav_agent_runs_batch_created_idx" ON "sav"."agent_runs" USING btree ("pilot_batch_id","created_at");--> statement-breakpoint
CREATE INDEX "sav_agent_runs_status_created_idx" ON "sav"."agent_runs" USING btree ("status","created_at");--> statement-breakpoint
UPDATE "content_items"
SET "agent_key" = 'sav', "updated_at" = now()
WHERE "id" IN (SELECT "item_id" FROM "sav"."resolution_evidence");
