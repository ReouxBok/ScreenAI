CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('draft', 'in_review', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('article', 'onboarding');--> statement-breakpoint
CREATE TYPE "public"."review_action" AS ENUM('submitted', 'approved', 'rejected', 'emergency_published', 'rolled_back', 'archived');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('contributor', 'reviewer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."content_visibility" AS ENUM('charly_only', 'charly_and_help');--> statement-breakpoint
CREATE TABLE "active_knowledge" (
	"singleton" boolean DEFAULT true NOT NULL,
	"revision_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "active_knowledge_singleton_pk" PRIMARY KEY("singleton")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_email" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"technical_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "content_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"heading" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"intents" text[] DEFAULT '{}' NOT NULL,
	"limova_paths" text[] DEFAULT '{}' NOT NULL,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"type" "content_type" NOT NULL,
	"locale" text DEFAULT 'fr-FR' NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"category_id" uuid,
	"visibility" "content_visibility" DEFAULT 'charly_only' NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"owner_email" text NOT NULL,
	"source_path" text,
	"current_draft_version_id" uuid,
	"published_version_id" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body_markdown" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"change_note" text NOT NULL,
	"author_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_email" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"version_id" uuid,
	"action" "review_action" NOT NULL,
	"actor_email" text NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT 'Membre Limova' NOT NULL,
	"role" "staff_role" DEFAULT 'contributor' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_users_clerk_id_unique" UNIQUE("clerk_id"),
	CONSTRAINT "staff_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "test_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query" text NOT NULL,
	"path" text,
	"locale" text DEFAULT 'fr-FR' NOT NULL,
	"expected_item_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "active_knowledge" ADD CONSTRAINT "active_knowledge_revision_id_knowledge_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."knowledge_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD CONSTRAINT "content_chunks_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD CONSTRAINT "content_chunks_version_id_content_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."content_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_version_id_content_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."content_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_expected_item_id_content_items_id_fk" FOREIGN KEY ("expected_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_chunks_item_idx" ON "content_chunks" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "content_chunks_embedding_idx" ON "content_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "content_items_slug_locale_idx" ON "content_items" USING btree ("slug","locale");--> statement-breakpoint
CREATE INDEX "content_items_status_idx" ON "content_items" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "content_versions_item_version_idx" ON "content_versions" USING btree ("item_id","version");
