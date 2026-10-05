CREATE TABLE "sav"."proposal_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"verdict" "sav"."pilot_verdict" NOT NULL,
	"dimensions" jsonb NOT NULL,
	"before_ciphertext" text NOT NULL,
	"after_ciphertext" text NOT NULL,
	"comment_ciphertext" text NOT NULL,
	"reusability" text DEFAULT 'none' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"reviewed_by" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_projection_candidates" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "knowledge_projection_candidates" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_projection_candidates" ADD COLUMN "materialized_version_id" uuid;--> statement-breakpoint
ALTER TABLE "sav"."decisions" ADD COLUMN "agent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "sav"."proposal_reviews" ADD CONSTRAINT "proposal_reviews_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "sav"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."proposal_reviews" ADD CONSTRAINT "proposal_reviews_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "sav"."decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."proposal_reviews" ADD CONSTRAINT "proposal_reviews_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "sav"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sav_review_message_revision_idx" ON "sav"."proposal_reviews" USING btree ("message_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "sav_review_message_current_idx" ON "sav"."proposal_reviews" USING btree ("message_id") WHERE "sav"."proposal_reviews"."is_current" = true;--> statement-breakpoint
ALTER TABLE "knowledge_projection_candidates" ADD CONSTRAINT "knowledge_projection_candidates_materialized_version_id_content_versions_id_fk" FOREIGN KEY ("materialized_version_id") REFERENCES "public"."content_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."decisions" ADD CONSTRAINT "decisions_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "sav"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;
