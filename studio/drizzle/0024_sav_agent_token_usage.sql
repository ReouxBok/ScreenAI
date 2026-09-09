ALTER TABLE "sav"."agent_runs" ADD COLUMN "input_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sav"."agent_runs" ADD COLUMN "output_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sav"."agent_runs" ADD COLUMN "total_tokens" integer DEFAULT 0 NOT NULL;
