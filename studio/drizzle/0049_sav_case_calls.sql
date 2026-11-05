-- Contract v9 §6 (SAV-5/SAV-44): one row per model call key of a V2 case, so that the same callKey
-- is paid at most once, even after a crash. Additive; written only while SAV_CASE_RECORDING is on.
-- A key once dispatched never returns to reserved or released; a settled key never changes again.
CREATE TABLE sav.case_calls (
 call_key text PRIMARY KEY CHECK (char_length(call_key) BETWEEN 10 AND 420),
 subject_key text NOT NULL CHECK (char_length(subject_key) BETWEEN 10 AND 400 AND starts_with(call_key, subject_key || ':call')),
 case_id uuid NOT NULL CONSTRAINT case_calls_case_id_cases_id_fk REFERENCES sav.cases(id),
 case_version integer NOT NULL CHECK (case_version >= 1),
 purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 80),
 state text NOT NULL CHECK (state IN ('reserved','dispatched','settled','released')),
 token uuid NOT NULL,
 holder text NOT NULL CHECK (char_length(holder) BETWEEN 1 AND 200),
 lease_until timestamptz,
 dispatched_at timestamptz,
 settled_at timestamptz,
 result_status text CHECK (result_status IN ('ok','failed')),
 result_uncertain boolean,
 output_ciphertext text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT sav_case_calls_lease CHECK ((state = 'reserved') = (lease_until IS NOT NULL)),
 CONSTRAINT sav_case_calls_dispatched CHECK ((state IN ('dispatched','settled')) = (dispatched_at IS NOT NULL)),
 CONSTRAINT sav_case_calls_settled CHECK ((state = 'settled') = (settled_at IS NOT NULL) AND (state = 'settled') = (result_status IS NOT NULL) AND (state = 'settled') = (result_uncertain IS NOT NULL)),
 CONSTRAINT sav_case_calls_output CHECK ((result_status = 'ok') = (output_ciphertext IS NOT NULL) AND (result_status <> 'ok' OR NOT result_uncertain))
);
--> statement-breakpoint
CREATE INDEX sav_case_calls_subject ON sav.case_calls (subject_key);
--> statement-breakpoint
CREATE INDEX sav_case_calls_case_created ON sav.case_calls (case_id, created_at);
--> statement-breakpoint
CREATE FUNCTION sav.case_calls_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SAV_CASE_CALL_IMMUTABLE'; END IF;
 IF NEW.call_key <> OLD.call_key OR NEW.subject_key <> OLD.subject_key OR NEW.case_id <> OLD.case_id OR NEW.purpose <> OLD.purpose OR NEW.created_at <> OLD.created_at THEN
  RAISE EXCEPTION 'SAV_CASE_CALL_IMMUTABLE';
 END IF;
 IF OLD.state = 'settled' THEN RAISE EXCEPTION 'SAV_CASE_CALL_SETTLED'; END IF;
 IF OLD.state = 'dispatched' AND (NEW.state <> 'settled' OR NEW.token <> OLD.token OR NEW.dispatched_at <> OLD.dispatched_at) THEN
  RAISE EXCEPTION 'SAV_CASE_CALL_DISPATCHED';
 END IF;
 IF OLD.state = 'reserved' AND NEW.state = 'settled' THEN RAISE EXCEPTION 'SAV_CASE_CALL_NOT_DISPATCHED'; END IF;
 IF OLD.state = 'released' AND NEW.state NOT IN ('released','reserved') THEN RAISE EXCEPTION 'SAV_CASE_CALL_RELEASED'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sav_case_calls_guard BEFORE UPDATE OR DELETE ON sav.case_calls FOR EACH ROW EXECUTE FUNCTION sav.case_calls_guard();
--> statement-breakpoint
INSERT INTO sav.sync_state(key,status) VALUES('sav-case-schema-v5','installed') ON CONFLICT(key) DO NOTHING;
