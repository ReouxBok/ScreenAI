CREATE TYPE "public"."training_event_kind" AS ENUM('navigation', 'click', 'input', 'voice_note', 'page_context', 'network');--> statement-breakpoint
CREATE TYPE "public"."training_status" AS ENUM('draft', 'recording', 'ready', 'converted', 'archived');--> statement-breakpoint
CREATE TABLE "training_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" "training_event_kind" NOT NULL,
	"path" text DEFAULT '/' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"agent_key" text DEFAULT 'charly' NOT NULL,
	"start_path" text DEFAULT '/' NOT NULL,
	"token_hash" text NOT NULL,
	"status" "training_status" DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"content_item_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "agent_key" text DEFAULT 'common' NOT NULL;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "last_status" text DEFAULT 'not_run' NOT NULL;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "last_result" jsonb;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_events" ADD CONSTRAINT "training_events_session_id_training_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."training_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "training_events_session_ordinal_idx" ON "training_events" USING btree ("session_id","ordinal");--> statement-breakpoint
CREATE INDEX "training_events_session_idx" ON "training_events" USING btree ("session_id");