CREATE TABLE "evaluation_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suite_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text DEFAULT 'live_action' NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"critical" boolean DEFAULT true NOT NULL,
	"expectation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"tool_name" text,
	"status" text,
	"path" text,
	"target_label" text,
	"technical_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suite_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"score" integer,
	"extension_version" text,
	"prompt_revision" text,
	"knowledge_revision" text,
	"contributor_verdict" text,
	"failure_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_runs_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "evaluation_suites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"threshold" integer DEFAULT 80 NOT NULL,
	"score" integer,
	"created_by" text NOT NULL,
	"passed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evaluation_cases" ADD CONSTRAINT "evaluation_cases_suite_id_evaluation_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."evaluation_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_events" ADD CONSTRAINT "evaluation_events_run_id_evaluation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_suite_id_evaluation_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."evaluation_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_case_id_evaluation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."evaluation_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_suites" ADD CONSTRAINT "evaluation_suites_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_suites" ADD CONSTRAINT "evaluation_suites_version_id_content_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."content_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_cases_suite_ordinal_idx" ON "evaluation_cases" USING btree ("suite_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_events_run_ordinal_idx" ON "evaluation_events" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE INDEX "evaluation_events_run_idx" ON "evaluation_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "evaluation_runs_suite_idx" ON "evaluation_runs" USING btree ("suite_id");--> statement-breakpoint
CREATE INDEX "evaluation_runs_case_idx" ON "evaluation_runs" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_suites_version_idx" ON "evaluation_suites" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "evaluation_suites_item_idx" ON "evaluation_suites" USING btree ("item_id");