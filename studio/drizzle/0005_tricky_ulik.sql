ALTER TYPE "public"."staff_role" ADD VALUE 'member';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'owner';--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "ai_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "content_items" ALTER COLUMN "ai_enabled" SET DEFAULT false;
