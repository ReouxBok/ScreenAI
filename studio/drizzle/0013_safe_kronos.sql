CREATE TYPE "sav"."pilot_batch_status" AS ENUM('processing', 'reviewing', 'completed');--> statement-breakpoint
CREATE TYPE "sav"."pilot_item_status" AS ENUM('pending', 'processing', 'ready', 'reviewed', 'error');--> statement-breakpoint
CREATE TYPE "sav"."pilot_verdict" AS ENUM('correct', 'partial', 'incorrect', 'critical');--> statement-breakpoint
ALTER TYPE "sav"."action_kind" ADD VALUE 'create_note' BEFORE 'draft_reply';--> statement-breakpoint
CREATE TABLE "sav"."pilot_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_size" integer DEFAULT 10 NOT NULL,
	"status" "sav"."pilot_batch_status" DEFAULT 'processing' NOT NULL,
	"created_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sav"."pilot_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"decision_id" uuid,
	"status" "sav"."pilot_item_status" DEFAULT 'pending' NOT NULL,
	"verdict" "sav"."pilot_verdict",
	"feedback_codes" text[] DEFAULT '{}' NOT NULL,
	"reviewer_comment" text DEFAULT '' NOT NULL,
	"corrected_draft_ciphertext" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sav"."actions" ADD COLUMN "pilot_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "sav"."pilot_items" ADD CONSTRAINT "pilot_items_batch_id_pilot_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "sav"."pilot_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."pilot_items" ADD CONSTRAINT "pilot_items_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "sav"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."pilot_items" ADD CONSTRAINT "pilot_items_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "sav"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sav_pilot_batches_status_created_idx" ON "sav"."pilot_batches" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sav_pilot_items_message_idx" ON "sav"."pilot_items" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "sav_pilot_items_batch_status_idx" ON "sav"."pilot_items" USING btree ("batch_id","status");--> statement-breakpoint
ALTER TABLE "sav"."actions" ADD CONSTRAINT "actions_pilot_batch_id_pilot_batches_id_fk" FOREIGN KEY ("pilot_batch_id") REFERENCES "sav"."pilot_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sav_actions_pilot_batch_idx" ON "sav"."actions" USING btree ("pilot_batch_id","status");