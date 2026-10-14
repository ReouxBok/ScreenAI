CREATE TABLE "sav_knowledge_activations" (
  "item_id" uuid PRIMARY KEY REFERENCES "content_items"("id") ON DELETE CASCADE,
  "version_id" uuid NOT NULL REFERENCES "content_versions"("id") ON DELETE RESTRICT,
  "title" text NOT NULL,
  "activated_by" text NOT NULL,
  "activated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Preserve the exact published version already consumed by SAV. No activation of disabled content.
INSERT INTO "sav_knowledge_activations" ("item_id", "version_id", "title", "activated_by", "activated_at")
SELECT item.id, version.id, item.title, 'migration:existing-sav-activation', item.updated_at
FROM content_items item JOIN content_versions version ON version.id = item.published_version_id AND version.item_id = item.id
WHERE item.agent_key = 'sav' AND item.ai_enabled = true AND item.status <> 'archived';
--> statement-breakpoint
CREATE TABLE "sav_knowledge_publication_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id" uuid NOT NULL REFERENCES "content_items"("id") ON DELETE CASCADE,
  "version_id" uuid NOT NULL REFERENCES "content_versions"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "error_code" text,
  "actor_email" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "sav_knowledge_publication_item_idx" ON "sav_knowledge_publication_attempts" ("item_id", "created_at");
--> statement-breakpoint
CREATE TABLE "sav_knowledge_proposal_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "revision" integer NOT NULL DEFAULT 1,
  "family_id" uuid REFERENCES knowledge_families(id) ON DELETE RESTRICT,
  "source_candidate_id" uuid REFERENCES knowledge_projection_candidates(id) ON DELETE RESTRICT,
  "mode" text NOT NULL, "target_item_id" uuid REFERENCES content_items(id) ON DELETE RESTRICT,
  "base_version_id" uuid REFERENCES content_versions(id) ON DELETE RESTRICT,
  "active_version_id" uuid REFERENCES content_versions(id) ON DELETE RESTRICT,
  "title" text NOT NULL, "document" jsonb NOT NULL, "sources" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "reason" text NOT NULL, "origin" text NOT NULL DEFAULT 'human',
  "learning_candidate_id" uuid REFERENCES sav.learning_candidates(id) ON DELETE SET NULL,
  "learning_source_hash" text,
  "candidate_id" uuid REFERENCES knowledge_projection_candidates(id) ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'draft', "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "sav_knowledge_proposal_updated_idx" ON "sav_knowledge_proposal_drafts" ("updated_at");
--> statement-breakpoint
ALTER TABLE sav.messages ADD COLUMN studio_opened_at timestamptz;
--> statement-breakpoint
ALTER TABLE sav.messages ADD COLUMN studio_opening_tracked boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE sav.messages m SET studio_opened_at = proof.opened_at FROM (
 SELECT entity_id, min(created_at) AS opened_at FROM audit_logs
 WHERE entity_type = 'sav_message' AND action = 'sav_email_opened' GROUP BY entity_id
) proof WHERE proof.entity_id = m.id::text AND m.direction = 'inbound';
--> statement-breakpoint
ALTER TABLE sav.messages ALTER COLUMN studio_opening_tracked SET DEFAULT true;
