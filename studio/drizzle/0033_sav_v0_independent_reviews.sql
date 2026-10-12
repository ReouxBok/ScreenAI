ALTER TABLE sav.proposal_reviews ADD COLUMN review_scope text NOT NULL DEFAULT 'legacy_global' CHECK (review_scope IN ('legacy_global','dossier'));
--> statement-breakpoint
ALTER TABLE sav.proposal_reviews ADD COLUMN dossier_source_hash text;
--> statement-breakpoint
ALTER TABLE sav.reply_drafts ADD COLUMN source_hash text;
--> statement-breakpoint
CREATE TABLE sav.draft_verdicts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), thread_id uuid NOT NULL REFERENCES sav.threads(id) ON DELETE CASCADE,
 message_id uuid NOT NULL REFERENCES sav.messages(id) ON DELETE CASCADE, decision_id uuid NOT NULL REFERENCES sav.decisions(id), agent_run_id uuid NOT NULL REFERENCES sav.agent_runs(id),
 draft_id uuid REFERENCES sav.reply_drafts(id) ON DELETE SET NULL, source_hash text NOT NULL, status text NOT NULL CHECK(status IN ('accepted','rejected')),
 snapshot_ciphertext text NOT NULL, reason_ciphertext text NOT NULL, is_current boolean NOT NULL DEFAULT true,
 reviewed_by text NOT NULL, reviewed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX sav_draft_verdict_current_idx ON sav.draft_verdicts(message_id) WHERE is_current=true;
--> statement-breakpoint
CREATE TABLE sav.resolution_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), thread_id uuid NOT NULL REFERENCES sav.threads(id) ON DELETE CASCADE,
 message_id uuid NOT NULL REFERENCES sav.messages(id) ON DELETE CASCADE, verdict_id uuid NOT NULL UNIQUE REFERENCES sav.draft_verdicts(id) ON DELETE CASCADE,
 hubspot_ticket_id text, state text NOT NULL DEFAULT 'waiting_ticket', cycle integer NOT NULL DEFAULT 1,
 closed_catchup_until timestamptz,remote_updated_at timestamptz,closed boolean NOT NULL DEFAULT false,
 last_sync_at timestamptz,next_sync_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,lease_token uuid,
 source_errors jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX sav_observation_due_idx ON sav.resolution_observations(next_sync_at);
--> statement-breakpoint
CREATE TABLE sav.observation_cycles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),observation_id uuid NOT NULL REFERENCES sav.resolution_observations(id) ON DELETE CASCADE,
 cycle integer NOT NULL,status text NOT NULL,summary_ciphertext text NOT NULL,source_hash text NOT NULL,candidate_id uuid,
 qualification text,qualified_by text,qualified_at timestamptz,closed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX sav_observation_cycle_idx ON sav.observation_cycles(observation_id,cycle);
--> statement-breakpoint
CREATE TABLE sav.observation_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),observation_id uuid NOT NULL REFERENCES sav.resolution_observations(id) ON DELETE CASCADE,
 source_ref text NOT NULL,content_hash text NOT NULL,kind text NOT NULL,occurred_at timestamptz NOT NULL,payload_ciphertext text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX sav_observation_event_content_idx ON sav.observation_events(observation_id,source_ref,content_hash);
