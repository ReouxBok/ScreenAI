CREATE TABLE "sav"."reply_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"review_id" uuid,
	"knowledge_revision" text,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"body_ciphertext" text NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sav"."agent_runs" ADD COLUMN "code_revision" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "sav"."agent_runs" ADD COLUMN "data_origin" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "sav"."reply_drafts" ADD CONSTRAINT "reply_drafts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "sav"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."reply_drafts" ADD CONSTRAINT "reply_drafts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "sav"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."reply_drafts" ADD CONSTRAINT "reply_drafts_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "sav"."decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."reply_drafts" ADD CONSTRAINT "reply_drafts_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "sav"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."reply_drafts" ADD CONSTRAINT "reply_drafts_review_id_proposal_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "sav"."proposal_reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sav_reply_draft_revision_idx" ON "sav"."reply_drafts" USING btree ("thread_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "sav_reply_draft_current_idx" ON "sav"."reply_drafts" USING btree ("thread_id") WHERE "sav"."reply_drafts"."is_current" = true;