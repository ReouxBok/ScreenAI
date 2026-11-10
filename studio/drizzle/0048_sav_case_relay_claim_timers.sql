-- SAV-5/SAV-11/SAV-8 on the V2 case record: decision claim, observation events and J2
-- timers kept through a technical pause. Additive; written only while SAV_CASE_RECORDING is on.
ALTER TABLE sav.cases
 ADD COLUMN claim_token uuid,
 ADD COLUMN claim_version integer CHECK (claim_version >= 1),
 ADD COLUMN claim_holder text CHECK (char_length(claim_holder) BETWEEN 1 AND 200),
 ADD COLUMN claim_until timestamptz;
--> statement-breakpoint
ALTER TABLE sav.cases ADD CONSTRAINT sav_cases_claim_complete CHECK (
 (claim_token IS NULL) = (claim_version IS NULL) AND (claim_token IS NULL) = (claim_holder IS NULL) AND (claim_token IS NULL) = (claim_until IS NULL));
--> statement-breakpoint
-- Only an agent case can be claimed: leaving the agent clears the claim in the same write.
ALTER TABLE sav.cases ADD CONSTRAINT sav_cases_claim_agent_only CHECK (claim_token IS NULL OR owner = 'agent');
--> statement-breakpoint
ALTER TABLE sav.case_events DROP CONSTRAINT case_events_kind_check;
--> statement-breakpoint
ALTER TABLE sav.case_events ADD CONSTRAINT case_events_kind_check CHECK (kind IN ('inbound_confirmed','outbound_observed','timer_fired','human_command','crm_observed','owner_changed','admission_decided','observation_recorded'));
--> statement-breakpoint
-- A pause is not a cancel reason: a scheduled timer keeps its due date through it.
CREATE TABLE sav.case_timers (
 id uuid PRIMARY KEY,
 key text NOT NULL CONSTRAINT case_timers_key_unique UNIQUE CHECK (char_length(key) BETWEEN 10 AND 420),
 case_id uuid NOT NULL CONSTRAINT case_timers_case_id_cases_id_fk REFERENCES sav.cases(id),
 question_effect_id text NOT NULL CHECK (char_length(question_effect_id) BETWEEN 1 AND 200),
 sent_at timestamptz NOT NULL,
 due_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'scheduled' CHECK (state IN ('scheduled','fired','cancelled')),
 scheduled_at_case_version integer NOT NULL CHECK (scheduled_at_case_version >= 1),
 fired_at timestamptz,
 cancelled_at timestamptz,
 cancel_reason text CHECK (cancel_reason IN ('customer_inbound','owner_changed','human_outbound','new_question','admission_withdrawn')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT sav_case_timers_due_after_sent CHECK (due_at > sent_at),
 CONSTRAINT sav_case_timers_cancelled CHECK ((state = 'cancelled') = (cancel_reason IS NOT NULL) AND (state = 'cancelled') = (cancelled_at IS NOT NULL)),
 CONSTRAINT sav_case_timers_fired CHECK ((state = 'fired') = (fired_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX sav_case_timers_case_state ON sav.case_timers (case_id, state);
--> statement-breakpoint
CREATE INDEX sav_case_timers_due ON sav.case_timers (due_at) WHERE state = 'scheduled';
--> statement-breakpoint
CREATE FUNCTION sav.case_timers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SAV_CASE_TIMER_IMMUTABLE'; END IF;
 IF OLD.state <> 'scheduled' OR NEW.id <> OLD.id OR NEW.key <> OLD.key OR NEW.case_id <> OLD.case_id OR NEW.question_effect_id <> OLD.question_effect_id
  OR NEW.sent_at <> OLD.sent_at OR NEW.due_at <> OLD.due_at OR NEW.scheduled_at_case_version <> OLD.scheduled_at_case_version THEN
  RAISE EXCEPTION 'SAV_CASE_TIMER_IMMUTABLE';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sav_case_timers_guard BEFORE UPDATE OR DELETE ON sav.case_timers FOR EACH ROW EXECUTE FUNCTION sav.case_timers_guard();
--> statement-breakpoint
INSERT INTO sav.sync_state(key,status) VALUES('sav-case-schema-v4','installed') ON CONFLICT(key) DO NOTHING;
