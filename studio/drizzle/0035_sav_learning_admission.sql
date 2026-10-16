CREATE TABLE "sav"."learning_admission_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"source_ref" text NOT NULL,
	"source_hash" text NOT NULL,
	"origin" text NOT NULL,
	"reason_code" text NOT NULL,
	"state" text NOT NULL,
	"candidate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"comparison_lease_token" uuid,
	"comparison_lease_until" timestamp with time zone,
	CONSTRAINT "learning_admission_attempts_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "sav"."learning_admission_cases" (
	"group_key" text NOT NULL,
	"case_hash" text NOT NULL,
	"candidate_id" uuid NOT NULL,
	"source_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_admission_cases_candidate_id_case_hash_pk" PRIMARY KEY("candidate_id","case_hash")
);
--> statement-breakpoint
CREATE TABLE "sav"."learning_admission_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_key" text NOT NULL,
	"candidate_id" uuid,
	"proposal_kind" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "learning_admission_reservations_reservation_key_unique" UNIQUE("reservation_key")
);
--> statement-breakpoint
CREATE TABLE "sav"."learning_admission_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"source_ref" text NOT NULL,
	"source_hash" text NOT NULL,
	"origin" text NOT NULL,
	"reason_code" text NOT NULL,
	"group_key" text,
	"candidate_id" uuid,
	"state" text DEFAULT 'signal' NOT NULL,
	"comparator_revision" text,
	"prompt_revision" text,
	"model_name" text,
	"input_hash" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"error_code" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_admission_signals_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "sav"."learning_admission_stats" (
	"day" date NOT NULL,
	"origin" text NOT NULL,
	"reason_code" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "learning_admission_stats_day_origin_reason_code_pk" PRIMARY KEY("day","origin","reason_code")
);
--> statement-breakpoint
CREATE TABLE "sav"."learning_model_usage" (
	"day" date PRIMARY KEY NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sav"."learning_candidates" ADD COLUMN "evidence_case_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sav"."learning_candidates" ADD COLUMN "admission_group_key" text;--> statement-breakpoint
ALTER TABLE "sav"."learning_candidates" ADD COLUMN "rejection_kind" text;--> statement-breakpoint
ALTER TABLE "sav"."observation_cycles" ADD COLUMN "learning_disposition" text;--> statement-breakpoint
ALTER TABLE "sav"."ticket_snapshots" ADD COLUMN "learning_cycle_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sav"."learning_admission_attempts" ADD CONSTRAINT "learning_admission_attempts_candidate_id_learning_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "sav"."learning_candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."learning_admission_cases" ADD CONSTRAINT "learning_admission_cases_candidate_id_learning_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "sav"."learning_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."learning_admission_reservations" ADD CONSTRAINT "learning_admission_reservations_candidate_id_learning_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "sav"."learning_candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."learning_admission_signals" ADD CONSTRAINT "learning_admission_signals_candidate_id_learning_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "sav"."learning_candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sav_learning_attempt_candidate_idx" ON "sav"."learning_admission_attempts" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "sav_learning_case_candidate_idx" ON "sav"."learning_admission_cases" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "sav_learning_reservation_window_idx" ON "sav"."learning_admission_reservations" USING btree ("created_at","proposal_kind");--> statement-breakpoint
CREATE INDEX "sav_learning_reservation_open_idx" ON "sav"."learning_admission_reservations" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "sav_learning_signal_created_idx" ON "sav"."learning_admission_signals" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sav_learning_signal_group_idx" ON "sav"."learning_admission_signals" USING btree ("group_key","state");--> statement-breakpoint
CREATE UNIQUE INDEX "sav_learning_open_group_idx" ON "sav"."learning_candidates" USING btree ("admission_group_key") WHERE "sav"."learning_candidates"."admission_group_key" is not null and "sav"."learning_candidates"."status" <> 'rejected';