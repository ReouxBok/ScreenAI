CREATE TABLE "sav"."sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
