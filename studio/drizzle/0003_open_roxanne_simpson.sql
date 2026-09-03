ALTER TABLE "training_sessions" ADD COLUMN "recording_status" text DEFAULT 'missing' NOT NULL;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "recording_pathname" text;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "recording_content_type" text;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "recording_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "recording_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "recording_uploaded_at" timestamp with time zone;