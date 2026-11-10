-- SAV-44 on the SAV-5 case record: server admission. Additive; the case tables are
-- written only while SAV_CASE_RECORDING is on. No admission means the agent never owns
-- the case, enforced here as well as in code.
ALTER TABLE sav.cases
 ADD COLUMN admission_target text CHECK (admission_target IN ('agent','team','qualification')),
 ADD COLUMN admission_reason text CHECK (char_length(admission_reason) BETWEEN 1 AND 64),
 ADD COLUMN admission_policy_revision text CHECK (char_length(admission_policy_revision) BETWEEN 1 AND 200),
 ADD COLUMN admission_version integer CHECK (admission_version >= 1),
 ADD COLUMN admission_input_version integer NOT NULL DEFAULT 0 CHECK (admission_input_version >= 0),
 ADD COLUMN admission_decided_at timestamptz,
 ADD COLUMN admission_ciphertext text;
--> statement-breakpoint
ALTER TABLE sav.cases ADD CONSTRAINT sav_cases_agent_admitted CHECK (owner <> 'agent' OR admission_target IS NOT DISTINCT FROM 'agent');
--> statement-breakpoint
ALTER TABLE sav.cases ADD CONSTRAINT sav_cases_sensitive_not_admitted CHECK (sensitivity = 'none' OR admission_target IS DISTINCT FROM 'agent');
--> statement-breakpoint
ALTER TABLE sav.case_events DROP CONSTRAINT case_events_kind_check;
--> statement-breakpoint
ALTER TABLE sav.case_events ADD CONSTRAINT case_events_kind_check CHECK (kind IN ('inbound_confirmed','outbound_observed','timer_fired','human_command','crm_observed','owner_changed','admission_decided'));
--> statement-breakpoint
INSERT INTO sav.sync_state(key,status) VALUES('sav-case-schema-v3','installed') ON CONFLICT(key) DO NOTHING;
