-- SAV-5 (V2-1): durable case record, one per HubSpot ticket, plus its append-only
-- event journal. Additive only; nothing writes here while SAV_CASE_RECORDING is off.
CREATE TABLE sav.cases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ticket_id text NOT NULL CONSTRAINT cases_ticket_id_unique UNIQUE CHECK (ticket_id ~ '^[0-9]{1,30}$'),
 thread_ids uuid[] NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
 owner text NOT NULL CHECK (owner IN ('agent','human','system_hold')),
 phase text NOT NULL CHECK (phase IN ('queued','acting','awaiting_customer','closed_no_reply','resolved','handoff_pending','human_owned','deferred_budget','technical_wait','reconciling','needs_review','blocked_technical','blocked_reconcile')),
 sensitivity text NOT NULL DEFAULT 'none' CHECK (sensitivity IN ('none','finance','cancellation')),
 contract_revision text NOT NULL,
 payload_ciphertext text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT sav_cases_sensitive_not_agent CHECK (sensitivity = 'none' OR owner <> 'agent'),
 CONSTRAINT sav_cases_owner_phase CHECK (owner = 'system_hold' OR ((owner = 'human') = (phase IN ('handoff_pending','human_owned'))))
);
--> statement-breakpoint
CREATE TABLE sav.case_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 case_id uuid NOT NULL CONSTRAINT case_events_case_id_cases_id_fk REFERENCES sav.cases(id),
 kind text NOT NULL CHECK (kind IN ('inbound_confirmed','outbound_observed','timer_fired','human_command','crm_observed','owner_changed')),
 dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 3 AND 420),
 case_version integer NOT NULL CHECK (case_version >= 1),
 direction text NOT NULL CHECK (direction IN ('customer_inbound','agent_outbound','human_outbound','internal')),
 occurred_at timestamptz NOT NULL,
 payload_ciphertext text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT sav_case_events_kind_direction CHECK ((kind = 'inbound_confirmed') = (direction = 'customer_inbound') AND (kind = 'outbound_observed') = (direction IN ('agent_outbound','human_outbound')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX sav_case_events_dedupe ON sav.case_events (case_id, dedupe_key);
--> statement-breakpoint
CREATE INDEX sav_case_events_case ON sav.case_events (case_id, case_version);
--> statement-breakpoint
CREATE FUNCTION sav.case_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'SAV_CASE_EVENTS_APPEND_ONLY';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sav_case_events_append_only BEFORE UPDATE OR DELETE ON sav.case_events FOR EACH ROW EXECUTE FUNCTION sav.case_events_append_only();
--> statement-breakpoint
INSERT INTO sav.sync_state(key,status) VALUES('sav-case-schema-v2','installed') ON CONFLICT(key) DO NOTHING;
