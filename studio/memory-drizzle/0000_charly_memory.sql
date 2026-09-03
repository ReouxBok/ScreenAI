CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS "charly_memory";

CREATE TABLE IF NOT EXISTS "charly_memory"."copilot_users" (
  "identity_key" text PRIMARY KEY NOT NULL,
  "profile_ciphertext" text,
  "locale" text DEFAULT 'fr-FR' NOT NULL,
  "timezone" text,
  "memory_enabled" boolean DEFAULT true NOT NULL,
  "profile_prompted_at" timestamptz,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "charly_memory"."conversation_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_key" text NOT NULL REFERENCES "charly_memory"."copilot_users"("identity_key") ON DELETE cascade,
  "status" text DEFAULT 'active' NOT NULL,
  "message_count" integer DEFAULT 0 NOT NULL,
  "characters_since_summary" integer DEFAULT 0 NOT NULL,
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "last_message_at" timestamptz DEFAULT now() NOT NULL,
  "closed_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "conversation_sessions_user_last_idx" ON "charly_memory"."conversation_sessions" ("user_key", "last_message_at");
CREATE TABLE IF NOT EXISTS "charly_memory"."conversation_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_key" text NOT NULL REFERENCES "charly_memory"."copilot_users"("identity_key") ON DELETE cascade,
  "session_id" uuid NOT NULL REFERENCES "charly_memory"."conversation_sessions"("id") ON DELETE cascade,
  "role" text NOT NULL,
  "source" text NOT NULL,
  "ciphertext" text NOT NULL,
  "character_count" integer NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_messages_user_idempotency_idx" ON "charly_memory"."conversation_messages" ("user_key", "idempotency_key");
CREATE INDEX IF NOT EXISTS "conversation_messages_session_created_idx" ON "charly_memory"."conversation_messages" ("session_id", "created_at");
CREATE TABLE IF NOT EXISTS "charly_memory"."conversation_summaries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_key" text NOT NULL REFERENCES "charly_memory"."copilot_users"("identity_key") ON DELETE cascade,
  "session_id" uuid NOT NULL REFERENCES "charly_memory"."conversation_sessions"("id") ON DELETE cascade,
  "version" integer NOT NULL,
  "ciphertext" text NOT NULL,
  "through_message_id" uuid REFERENCES "charly_memory"."conversation_messages"("id") ON DELETE set null,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_summaries_session_version_idx" ON "charly_memory"."conversation_summaries" ("session_id", "version");
CREATE TABLE IF NOT EXISTS "charly_memory"."copilot_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_key" text NOT NULL REFERENCES "charly_memory"."copilot_users"("identity_key") ON DELETE cascade,
  "type" text NOT NULL,
  "ciphertext" text NOT NULL,
  "fingerprint" text NOT NULL,
  "confidence" integer NOT NULL,
  "importance" integer NOT NULL,
  "embedding" vector(768) NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "source_message_id" uuid REFERENCES "charly_memory"."conversation_messages"("id") ON DELETE set null,
  "last_used_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "copilot_memories_user_fingerprint_idx" ON "charly_memory"."copilot_memories" ("user_key", "fingerprint");
CREATE INDEX IF NOT EXISTS "copilot_memories_user_status_idx" ON "charly_memory"."copilot_memories" ("user_key", "status");
CREATE INDEX IF NOT EXISTS "copilot_memories_embedding_idx" ON "charly_memory"."copilot_memories" USING hnsw ("embedding" vector_cosine_ops);
CREATE TABLE IF NOT EXISTS "charly_memory"."copilot_goals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_key" text NOT NULL REFERENCES "charly_memory"."copilot_users"("identity_key") ON DELETE cascade,
  "title_ciphertext" text NOT NULL,
  "next_step_ciphertext" text,
  "blocker_ciphertext" text,
  "fingerprint" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "confidence" integer DEFAULT 850 NOT NULL,
  "last_progress_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "copilot_goals_user_fingerprint_idx" ON "charly_memory"."copilot_goals" ("user_key", "fingerprint");
CREATE INDEX IF NOT EXISTS "copilot_goals_user_status_idx" ON "charly_memory"."copilot_goals" ("user_key", "status");
CREATE TABLE IF NOT EXISTS "charly_memory"."memory_tombstones" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_key" text NOT NULL REFERENCES "charly_memory"."copilot_users"("identity_key") ON DELETE cascade,
  "fingerprint" text NOT NULL,
  "reason" text DEFAULT 'user_request' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "memory_tombstones_user_fingerprint_idx" ON "charly_memory"."memory_tombstones" ("user_key", "fingerprint");
CREATE TABLE IF NOT EXISTS "charly_memory"."copilot_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_key" text NOT NULL REFERENCES "charly_memory"."copilot_users"("identity_key") ON DELETE cascade,
  "status" text DEFAULT 'active' NOT NULL,
  "state_ciphertext" text NOT NULL,
  "action_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS "charly_memory"."memory_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_key" text NOT NULL,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text,
  "request_id" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "memory_audit_user_created_idx" ON "charly_memory"."memory_audit_events" ("user_key", "created_at");
