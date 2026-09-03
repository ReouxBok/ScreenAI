ALTER TABLE "charly_memory"."conversation_sessions" ADD COLUMN IF NOT EXISTS "adk_state_ciphertext" text;
--> statement-breakpoint
ALTER TABLE "charly_memory"."conversation_sessions" ADD COLUMN IF NOT EXISTS "prompt_revision" text;
--> statement-breakpoint
ALTER TABLE "charly_memory"."conversation_sessions" ADD COLUMN IF NOT EXISTS "session_revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "charly_memory"."conversation_sessions" ADD COLUMN IF NOT EXISTS "closed_reason" text;
--> statement-breakpoint
ALTER TABLE "charly_memory"."conversation_messages" ADD COLUMN IF NOT EXISTS "adk_event_id" text;
--> statement-breakpoint
ALTER TABLE "charly_memory"."conversation_messages" ADD COLUMN IF NOT EXISTS "invocation_id" text;
--> statement-breakpoint
ALTER TABLE "charly_memory"."conversation_messages" ADD COLUMN IF NOT EXISTS "final_status" text DEFAULT 'completed' NOT NULL;
--> statement-breakpoint
ALTER TABLE "charly_memory"."copilot_runs" ADD COLUMN IF NOT EXISTS "session_id" uuid;
--> statement-breakpoint
ALTER TABLE "charly_memory"."copilot_runs" ADD COLUMN IF NOT EXISTS "call_id" text;
--> statement-breakpoint
ALTER TABLE "charly_memory"."copilot_runs" ADD COLUMN IF NOT EXISTS "tool_name" text;
--> statement-breakpoint
ALTER TABLE "charly_memory"."copilot_runs" ADD COLUMN IF NOT EXISTS "context_version" integer;
--> statement-breakpoint
ALTER TABLE "charly_memory"."copilot_runs" ADD COLUMN IF NOT EXISTS "recovery_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "charly_memory"."copilot_runs" ADD COLUMN IF NOT EXISTS "prompt_revision" text;
--> statement-breakpoint
ALTER TABLE "charly_memory"."copilot_runs" ADD COLUMN IF NOT EXISTS "error_code" text;
--> statement-breakpoint
UPDATE "charly_memory"."copilot_runs"
SET "call_id" = COALESCE("call_id", id::text),
    "tool_name" = COALESCE("tool_name", 'legacy'),
    "context_version" = COALESCE("context_version", 0);
--> statement-breakpoint
ALTER TABLE "charly_memory"."copilot_runs" ALTER COLUMN "call_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "charly_memory"."copilot_runs" ALTER COLUMN "tool_name" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "charly_memory"."copilot_runs" ALTER COLUMN "context_version" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "charly_memory"."copilot_runs" ADD CONSTRAINT "copilot_runs_session_id_conversation_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "charly_memory"."conversation_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "copilot_runs_call_id_idx" ON "charly_memory"."copilot_runs" USING btree ("call_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copilot_runs_user_session_idx" ON "charly_memory"."copilot_runs" USING btree ("user_key", "session_id");
