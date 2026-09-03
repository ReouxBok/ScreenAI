CREATE TABLE "active_onboarding_template" (
	"singleton" boolean DEFAULT true NOT NULL,
	"draft_version_id" uuid,
	"published_version_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "active_onboarding_template_singleton_pk" PRIMARY KEY("singleton")
);
--> statement-breakpoint
CREATE TABLE "onboarding_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"change_note" text NOT NULL,
	"author_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_template_versions_version_unique" UNIQUE("version")
);
--> statement-breakpoint
ALTER TABLE "active_onboarding_template" ADD CONSTRAINT "active_onboarding_template_draft_version_id_onboarding_template_versions_id_fk" FOREIGN KEY ("draft_version_id") REFERENCES "public"."onboarding_template_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_onboarding_template" ADD CONSTRAINT "active_onboarding_template_published_version_id_onboarding_template_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."onboarding_template_versions"("id") ON DELETE set null ON UPDATE no action;