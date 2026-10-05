CREATE TABLE "knowledge_families" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_key" text NOT NULL,
	"title" text NOT NULL,
	"approved_revision_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_families_canonical_key_unique" UNIQUE("canonical_key")
);
--> statement-breakpoint
CREATE TABLE "knowledge_family_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"canonical_hash" text NOT NULL,
	"document" jsonb NOT NULL,
	"review_state" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_family_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"source_ref" text NOT NULL,
	"source_hash" text NOT NULL,
	"source_version_id" uuid,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_projection_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"target_surface" text NOT NULL,
	"target_item_id" uuid,
	"base_version_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"explanation" text NOT NULL,
	"proposed_input" jsonb NOT NULL,
	"diff" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_projections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"item_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"technical_bindings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sav"."agent_runs" ADD COLUMN "knowledge_revision" text;--> statement-breakpoint
ALTER TABLE "sav"."agent_runs" ADD COLUMN "proposal_ciphertext" text;--> statement-breakpoint
ALTER TABLE "knowledge_family_revisions" ADD CONSTRAINT "knowledge_family_revisions_family_id_knowledge_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."knowledge_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_family_sources" ADD CONSTRAINT "knowledge_family_sources_family_id_knowledge_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."knowledge_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_family_sources" ADD CONSTRAINT "knowledge_family_sources_revision_id_knowledge_family_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."knowledge_family_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_family_sources" ADD CONSTRAINT "knowledge_family_sources_source_version_id_content_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."content_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_projection_candidates" ADD CONSTRAINT "knowledge_projection_candidates_family_id_knowledge_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."knowledge_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_projection_candidates" ADD CONSTRAINT "knowledge_projection_candidates_revision_id_knowledge_family_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."knowledge_family_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_projection_candidates" ADD CONSTRAINT "knowledge_projection_candidates_source_id_knowledge_family_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_family_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_projection_candidates" ADD CONSTRAINT "knowledge_projection_candidates_target_item_id_content_items_id_fk" FOREIGN KEY ("target_item_id") REFERENCES "public"."content_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_projection_candidates" ADD CONSTRAINT "knowledge_projection_candidates_base_version_id_content_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."content_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_projections" ADD CONSTRAINT "knowledge_projections_family_id_knowledge_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."knowledge_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_projections" ADD CONSTRAINT "knowledge_projections_revision_id_knowledge_family_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."knowledge_family_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_projections" ADD CONSTRAINT "knowledge_projections_item_id_content_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."content_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_projections" ADD CONSTRAINT "knowledge_projections_version_id_content_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."content_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_family_revision_idx" ON "knowledge_family_revisions" USING btree ("family_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_family_hash_idx" ON "knowledge_family_revisions" USING btree ("family_id","canonical_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_source_identity_idx" ON "knowledge_family_sources" USING btree ("family_id","source_ref","source_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_candidate_revision_target_idx" ON "knowledge_projection_candidates" USING btree ("revision_id","target_surface");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_projection_version_idx" ON "knowledge_projections" USING btree ("item_id","version_id","surface");--> statement-breakpoint
CREATE INDEX "knowledge_projection_family_idx" ON "knowledge_projections" USING btree ("family_id");