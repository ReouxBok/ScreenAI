CREATE TABLE "sav"."analysis_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"payload_ciphertext" text NOT NULL,
	"code_revision" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_snapshots_agent_run_id_unique" UNIQUE("agent_run_id")
);
--> statement-breakpoint
CREATE TABLE "sav"."message_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"source_hash" text NOT NULL,
	"translator_revision" text NOT NULL,
	"language" text DEFAULT 'unknown' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload_ciphertext" text,
	"error_code" text,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sav"."resolution_observations" ALTER COLUMN "verdict_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sav"."resolution_observations" ADD COLUMN "snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "sav"."resolution_observations" ADD COLUMN "tracking_origin" text DEFAULT 'draft_feedback' NOT NULL;--> statement-breakpoint
ALTER TABLE "sav"."analysis_snapshots" ADD CONSTRAINT "analysis_snapshots_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "sav"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."analysis_snapshots" ADD CONSTRAINT "analysis_snapshots_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "sav"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."message_translations" ADD CONSTRAINT "message_translations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "sav"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sav_translation_content_idx" ON "sav"."message_translations" USING btree ("message_id","source_hash","translator_revision");--> statement-breakpoint
CREATE INDEX "sav_translation_due_idx" ON "sav"."message_translations" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "sav"."resolution_observations" ADD CONSTRAINT "resolution_observations_snapshot_id_analysis_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "sav"."analysis_snapshots"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION sav.protect_analysis_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SAV_ANALYSIS_SNAPSHOT_IMMUTABLE'; END $$;
--> statement-breakpoint
CREATE TRIGGER sav_analysis_snapshot_immutable BEFORE UPDATE ON sav.analysis_snapshots FOR EACH ROW EXECUTE FUNCTION sav.protect_analysis_snapshot();
