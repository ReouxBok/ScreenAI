-- Additive SAV list read model. Maintenance table, not a business source; declared in schema.ts.
-- No email text, summary, CRM content or permissions are stored in this table.
CREATE TABLE sav.dashboard_projection (
  thread_id uuid PRIMARY KEY,
  version bigint NOT NULL DEFAULT 1,
  indexed_version bigint NOT NULL DEFAULT 0,
  generation text,
  message_id uuid,
  received_at timestamptz,
  state text CONSTRAINT sav_dashboard_state_check CHECK (state IN ('to_process', 'to_validate', 'learning', 'completed')),
  technical boolean NOT NULL DEFAULT false,
  incident boolean NOT NULL DEFAULT false,
  is_other boolean NOT NULL DEFAULT false,
  search_grams text[] NOT NULL DEFAULT '{}',
  search_stream text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dashboard_projection_thread_id_threads_id_fk FOREIGN KEY (thread_id) REFERENCES sav.threads(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX sav_dashboard_state_page ON sav.dashboard_projection(state, received_at DESC, message_id DESC) WHERE NOT technical AND message_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX sav_dashboard_technical_page ON sav.dashboard_projection(received_at DESC, message_id DESC) WHERE technical AND message_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX sav_dashboard_incident_page ON sav.dashboard_projection(received_at DESC, message_id DESC) WHERE NOT technical AND incident AND message_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX sav_dashboard_other_page ON sav.dashboard_projection(received_at DESC, message_id DESC) WHERE is_other AND message_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX sav_dashboard_search ON sav.dashboard_projection USING gin(search_grams);
--> statement-breakpoint
CREATE INDEX sav_messages_latest_inbound ON sav.messages(thread_id, received_at DESC, created_at DESC, id DESC) WHERE direction = 'inbound';
--> statement-breakpoint
-- Prevent a concurrent thread insert between bootstrap and trigger installation.
LOCK TABLE sav.threads IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO sav.dashboard_projection(thread_id) SELECT id FROM sav.threads;
--> statement-breakpoint

CREATE FUNCTION sav.invalidate_dashboard_thread(target uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sav.dashboard_projection(thread_id)
    SELECT id FROM sav.threads WHERE id = target
    ON CONFLICT(thread_id) DO UPDATE SET version = sav.dashboard_projection.version + 1;
END;
$$;
--> statement-breakpoint

-- Invalidation belongs to the source transaction, including old writers during
-- a rolling deployment. A cache builder never acquires source-row locks.
CREATE FUNCTION sav.invalidate_dashboard_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  before_row jsonb := '{}'; after_row jsonb := '{}'; targets uuid[] := '{}'; target uuid;
  message_ids uuid[]; observation_ids uuid[]; candidate_ids uuid[];
BEGIN
  IF TG_OP <> 'INSERT' THEN before_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN after_row := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'mailboxes' THEN
    SELECT array_agg(id) INTO targets FROM sav.threads WHERE mailbox_id = ANY(ARRAY[(before_row->>'id')::uuid, (after_row->>'id')::uuid]);
  ELSIF TG_TABLE_NAME = 'threads' THEN
    targets := ARRAY[(before_row->>'id')::uuid, (after_row->>'id')::uuid];
  ELSIF TG_TABLE_NAME IN ('messages', 'actions', 'resolution_observations', 'reply_drafts', 'draft_verdicts') THEN
    targets := ARRAY[(before_row->>'thread_id')::uuid, (after_row->>'thread_id')::uuid];
  ELSIF TG_TABLE_NAME IN ('agent_runs', 'decisions', 'proposal_reviews', 'pilot_items') THEN
    message_ids := ARRAY[(before_row->>'message_id')::uuid, (after_row->>'message_id')::uuid];
    SELECT array_agg(DISTINCT thread_id) INTO targets FROM sav.messages WHERE id = ANY(message_ids);
  ELSIF TG_TABLE_NAME = 'observation_cycles' THEN
    observation_ids := ARRAY[(before_row->>'observation_id')::uuid, (after_row->>'observation_id')::uuid];
    SELECT array_agg(DISTINCT thread_id) INTO targets FROM sav.resolution_observations WHERE id = ANY(observation_ids);
  ELSIF TG_TABLE_NAME = 'learning_candidates' THEN
    candidate_ids := ARRAY[(before_row->>'id')::uuid, (after_row->>'id')::uuid];
    SELECT array_agg(DISTINCT id) INTO targets FROM (
      SELECT (before_row->>'thread_id')::uuid AS id UNION SELECT (after_row->>'thread_id')::uuid
      UNION SELECT id FROM sav.threads WHERE hubspot_ticket_id IN (before_row->>'hubspot_ticket_id', after_row->>'hubspot_ticket_id')
      UNION SELECT o.thread_id FROM sav.observation_cycles c JOIN sav.resolution_observations o ON o.id = c.observation_id WHERE c.candidate_id = ANY(candidate_ids)
    ) affected;
  ELSIF TG_TABLE_NAME = 'audit_logs' THEN
    IF before_row->>'entity_type' = 'sav_message' AND before_row->>'action' IN ('sav_email_opened', 'sav_dossier_opened', 'sav_dossier_completed_externally', 'sav_dossier_external_completion_reverted') AND before_row->>'entity_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      message_ids := array_append(message_ids, (before_row->>'entity_id')::uuid);
    END IF;
    IF after_row->>'entity_type' = 'sav_message' AND after_row->>'action' IN ('sav_email_opened', 'sav_dossier_opened', 'sav_dossier_completed_externally', 'sav_dossier_external_completion_reverted') AND after_row->>'entity_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      message_ids := array_append(message_ids, (after_row->>'entity_id')::uuid);
    END IF;
    SELECT array_agg(DISTINCT thread_id) INTO targets FROM sav.messages WHERE id = ANY(message_ids);
  END IF;
  -- Ordered locking also covers a candidate shared by several dossiers.
  FOR target IN SELECT DISTINCT value FROM unnest(targets) value WHERE value IS NOT NULL ORDER BY value LOOP
    PERFORM sav.invalidate_dashboard_thread(target);
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION sav.invalidate_dashboard_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE sav.dashboard_projection SET version = version + 1;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE source_table text;
BEGIN
  FOREACH source_table IN ARRAY ARRAY['mailboxes', 'threads', 'messages', 'actions', 'agent_runs', 'decisions', 'proposal_reviews', 'reply_drafts', 'draft_verdicts', 'resolution_observations', 'observation_cycles', 'learning_candidates', 'pilot_items'] LOOP
    EXECUTE format('CREATE TRIGGER sav_dashboard_invalidate AFTER INSERT OR UPDATE OR DELETE ON sav.%I FOR EACH ROW EXECUTE FUNCTION sav.invalidate_dashboard_source()', source_table);
    EXECUTE format('CREATE TRIGGER sav_dashboard_truncate AFTER TRUNCATE ON sav.%I FOR EACH STATEMENT EXECUTE FUNCTION sav.invalidate_dashboard_truncate()', source_table);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sav_dashboard_invalidate AFTER INSERT OR UPDATE OR DELETE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION sav.invalidate_dashboard_source();
--> statement-breakpoint
CREATE TRIGGER sav_dashboard_truncate AFTER TRUNCATE ON public.audit_logs FOR EACH STATEMENT EXECUTE FUNCTION sav.invalidate_dashboard_truncate();
--> statement-breakpoint
