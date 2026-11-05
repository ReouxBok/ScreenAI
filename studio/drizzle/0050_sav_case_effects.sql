-- SAV-10 (pole C, proposal 4fc543f, renumbered after 0049 by pole A, owner of the journal and snapshots): reply_send / case_note on the EXISTING
-- effect ledger. A case effect needs its own parent row (one per triggering event of a case) because sav.intake_executions is one row per inbound
-- message and every V1 reader assumes a V1 payload. The effect ledger and its journal are the same tables, protocol and states: only their parent
-- may now be either kind of execution. Additive for V1: no V1 row is touched. Written only while SAV_CASE_EFFECTS is supervised; nothing runs here.
CREATE TABLE sav.case_effect_executions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 case_id uuid NOT NULL CONSTRAINT case_effect_executions_case_id_cases_id_fk REFERENCES sav.cases(id),
 reply_key text NOT NULL CONSTRAINT case_effect_executions_reply_key_unique UNIQUE CHECK (char_length(reply_key) BETWEEN 10 AND 420),
 thread_id uuid NOT NULL,
 policy_id uuid NOT NULL CONSTRAINT case_effect_executions_policy_id_intake_execution_policies_id_fk REFERENCES sav.intake_execution_policies(id),
 policy_hash text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','waiting','uncertain','confirmed','refused')),
 reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 200),
 lease_token uuid,
 lease_until timestamptz,
 payload_ciphertext text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT case_effect_executions_lease_complete CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
--> statement-breakpoint
CREATE INDEX case_effect_executions_open ON sav.case_effect_executions(state, updated_at) WHERE state IN ('pending','running','waiting','uncertain');
--> statement-breakpoint
CREATE INDEX case_effect_executions_case ON sav.case_effect_executions(case_id);
--> statement-breakpoint
-- The ledger and its journal keep their parent check, now against either kind of execution (a foreign key can only name one table).
ALTER TABLE sav.intake_effects DROP CONSTRAINT intake_effects_execution_id_fkey;
--> statement-breakpoint
ALTER TABLE sav.intake_effect_journal DROP CONSTRAINT intake_effect_journal_execution_id_fkey;
--> statement-breakpoint
-- Child side, as the dropped keys did: the parent row is locked FOR KEY SHARE, so a concurrent delete of it waits, then this insert sees it gone.
CREATE FUNCTION sav.check_effect_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM sav.intake_executions WHERE id = NEW.execution_id FOR KEY SHARE;
 IF FOUND THEN RETURN NEW; END IF;
 PERFORM 1 FROM sav.case_effect_executions WHERE id = NEW.execution_id FOR KEY SHARE;
 IF FOUND THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'effect parent execution missing' USING ERRCODE = '23503';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sav_intake_effects_parent BEFORE INSERT OR UPDATE OF execution_id ON sav.intake_effects FOR EACH ROW EXECUTE FUNCTION sav.check_effect_parent();
--> statement-breakpoint
CREATE TRIGGER sav_intake_effect_journal_parent BEFORE INSERT OR UPDATE OF execution_id ON sav.intake_effect_journal FOR EACH ROW EXECUTE FUNCTION sav.check_effect_parent();
--> statement-breakpoint
-- Parent side of the dropped keys (NO ACTION): an execution that has effects or journal rows is neither deleted nor given another id. AFTER, like
-- the keys' own check, so it runs once the row is locked and sees children committed meanwhile.
CREATE FUNCTION sav.check_effect_children() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND NEW.id = OLD.id THEN RETURN NULL; END IF;
 IF EXISTS (SELECT 1 FROM sav.intake_effects WHERE execution_id = OLD.id) OR EXISTS (SELECT 1 FROM sav.intake_effect_journal WHERE execution_id = OLD.id) THEN
  RAISE EXCEPTION 'effect parent execution still referenced' USING ERRCODE = '23503';
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sav_intake_executions_effect_children AFTER DELETE OR UPDATE OF id ON sav.intake_executions FOR EACH ROW EXECUTE FUNCTION sav.check_effect_children();
--> statement-breakpoint
CREATE TRIGGER sav_case_effect_executions_effect_children AFTER DELETE OR UPDATE OF id ON sav.case_effect_executions FOR EACH ROW EXECUTE FUNCTION sav.check_effect_children();
--> statement-breakpoint
INSERT INTO sav.sync_state(key,status) VALUES('sav-case-schema-v6','installed') ON CONFLICT(key) DO NOTHING;
