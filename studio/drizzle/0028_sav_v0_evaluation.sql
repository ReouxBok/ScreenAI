CREATE TABLE "sav"."deployment_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_hash" text NOT NULL,
	"decision" text NOT NULL,
	"reason_ciphertext" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"reviewed_by" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sav"."reviewed_replay_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"case_ciphertext" text NOT NULL,
	"content_hash" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviewed_replay_cases_review_id_unique" UNIQUE("review_id")
);
--> statement-breakpoint
CREATE TABLE "sav"."reviewed_replay_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_hash" text NOT NULL,
	"runner_revision" text NOT NULL,
	"code_revision" text NOT NULL,
	"total" integer NOT NULL,
	"failed" integer NOT NULL,
	"result" jsonb NOT NULL,
	"executed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sav"."reviewed_replay_cases" ADD CONSTRAINT "reviewed_replay_cases_review_id_proposal_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "sav"."proposal_reviews"("id") ON DELETE cascade ON UPDATE no action;