CREATE SCHEMA "sav";
--> statement-breakpoint
CREATE TYPE "sav"."action_kind" AS ENUM('create_ticket', 'link_ticket', 'draft_reply', 'send_reply', 'update_ticket_status', 'schedule_followup', 'cancel_followup', 'request_human', 'create_learning_candidate');--> statement-breakpoint
CREATE TYPE "sav"."action_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "sav"."actor_type" AS ENUM('ai', 'human', 'system');--> statement-breakpoint
CREATE TYPE "sav"."decision_kind" AS ENUM('ticket_created', 'attached_to_existing_ticket', 'no_ticket_needed', 'spam', 'internal_notification', 'automatic_reply', 'bounce', 'duplicate', 'human_review_required');--> statement-breakpoint
CREATE TYPE "sav"."learning_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "sav"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "sav"."thread_status" AS ENUM('new', 'ai_processing', 'awaiting_customer', 'followup_due', 'human_requested', 'human_processing', 'resolved', 'closed_no_action', 'error');--> statement-breakpoint
CREATE TABLE "sav"."actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"message_id" uuid,
	"decision_id" uuid,
	"kind" "sav"."action_kind" NOT NULL,
	"status" "sav"."action_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" "sav"."actor_type" DEFAULT 'system' NOT NULL,
	"actor_email" text,
	"error_code" text,
	"scheduled_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "sav"."decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"kind" "sav"."decision_kind" NOT NULL,
	"reason_code" text NOT NULL,
	"explanation" text NOT NULL,
	"confidence" integer NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text DEFAULT 'rules' NOT NULL,
	"actor_type" "sav"."actor_type" DEFAULT 'ai' NOT NULL,
	"actor_email" text,
	"supersedes_decision_id" uuid,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sav"."followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"action_id" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sav"."learning_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid,
	"hubspot_ticket_id" text NOT NULL,
	"content_item_id" uuid,
	"status" "sav"."learning_status" DEFAULT 'pending' NOT NULL,
	"proposed_patch" jsonb NOT NULL,
	"explanation" text NOT NULL,
	"evidence_ticket_ids" text[] DEFAULT '{}' NOT NULL,
	"created_by" "sav"."actor_type" DEFAULT 'system' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sav"."mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"history_id" text,
	"watch_expiration" timestamp with time zone,
	"watch_status" text DEFAULT 'disconnected' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "sav"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"gmail_message_id" text,
	"hubspot_email_id" text,
	"direction" "sav"."message_direction" NOT NULL,
	"from_email" text NOT NULL,
	"to_emails" text[] DEFAULT '{}' NOT NULL,
	"subject" text DEFAULT 'Sans objet' NOT NULL,
	"preview" text DEFAULT '' NOT NULL,
	"body_ciphertext" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sav"."resolution_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"hubspot_ticket_id" text NOT NULL,
	"weight" integer DEFAULT 500 NOT NULL,
	"outcome" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sav"."threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"hubspot_ticket_id" text,
	"subject" text DEFAULT 'Sans objet' NOT NULL,
	"customer_email" text NOT NULL,
	"status" "sav"."thread_status" DEFAULT 'new' NOT NULL,
	"ai_paused" boolean DEFAULT false NOT NULL,
	"human_requested_at" timestamp with time zone,
	"human_due_at" timestamp with time zone,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sav"."ticket_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hubspot_ticket_id" text NOT NULL,
	"pipeline_id" text,
	"stage_id" text,
	"status" text NOT NULL,
	"subject" text DEFAULT 'Sans objet' NOT NULL,
	"transcript_ciphertext" text NOT NULL,
	"content_hash" text NOT NULL,
	"human_intervened" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"hubspot_updated_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_snapshots_hubspot_ticket_id_unique" UNIQUE("hubspot_ticket_id")
);
--> statement-breakpoint
CREATE TABLE "sav"."webhook_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sav"."actions" ADD CONSTRAINT "actions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "sav"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."actions" ADD CONSTRAINT "actions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "sav"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."actions" ADD CONSTRAINT "actions_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "sav"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."decisions" ADD CONSTRAINT "decisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "sav"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."followups" ADD CONSTRAINT "followups_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "sav"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."followups" ADD CONSTRAINT "followups_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "sav"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."learning_candidates" ADD CONSTRAINT "learning_candidates_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "sav"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."learning_candidates" ADD CONSTRAINT "learning_candidates_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."messages" ADD CONSTRAINT "messages_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "sav"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "sav"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."resolution_evidence" ADD CONSTRAINT "resolution_evidence_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."resolution_evidence" ADD CONSTRAINT "resolution_evidence_version_id_content_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."content_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."threads" ADD CONSTRAINT "threads_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "sav"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sav_actions_status_scheduled_idx" ON "sav"."actions" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "sav_actions_thread_created_idx" ON "sav"."actions" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "sav_decisions_message_current_idx" ON "sav"."decisions" USING btree ("message_id","is_current");--> statement-breakpoint
CREATE INDEX "sav_decisions_kind_created_idx" ON "sav"."decisions" USING btree ("kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sav_followups_thread_sequence_idx" ON "sav"."followups" USING btree ("thread_id","sequence");--> statement-breakpoint
CREATE INDEX "sav_followups_status_due_idx" ON "sav"."followups" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "sav_learning_status_created_idx" ON "sav"."learning_candidates" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "sav_learning_ticket_idx" ON "sav"."learning_candidates" USING btree ("hubspot_ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sav_messages_mailbox_gmail_idx" ON "sav"."messages" USING btree ("mailbox_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX "sav_messages_thread_received_idx" ON "sav"."messages" USING btree ("thread_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sav_resolution_evidence_version_ticket_idx" ON "sav"."resolution_evidence" USING btree ("version_id","hubspot_ticket_id");--> statement-breakpoint
CREATE INDEX "sav_resolution_evidence_item_idx" ON "sav"."resolution_evidence" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sav_threads_mailbox_gmail_idx" ON "sav"."threads" USING btree ("mailbox_id","gmail_thread_id");--> statement-breakpoint
CREATE INDEX "sav_threads_status_message_idx" ON "sav"."threads" USING btree ("status","last_message_at");--> statement-breakpoint
CREATE INDEX "sav_threads_hubspot_idx" ON "sav"."threads" USING btree ("hubspot_ticket_id");--> statement-breakpoint
CREATE INDEX "sav_ticket_snapshots_processed_idx" ON "sav"."ticket_snapshots" USING btree ("processed_at","hubspot_updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sav_webhook_provider_external_idx" ON "sav"."webhook_receipts" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "sav_webhook_status_received_idx" ON "sav"."webhook_receipts" USING btree ("status","received_at");