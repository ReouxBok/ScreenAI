-- SAV-10 (pole C, DDL_PROPOSAL_FOR_A.sql of c5ad3d6, turned into a migration by pole A, owner of migrations, journal and snapshots): the durable
-- human validation of a prepared case reply, and the effect kinds each parent execution may host. After A's 0050 (case_effect_executions parent).
-- Additive: no existing row is touched. Written only while SAV_CASE_EFFECTS is supervised; nothing runs here.
CREATE TABLE sav.case_reply_validations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 case_id uuid NOT NULL CONSTRAINT case_reply_validations_case_id_cases_id_fk REFERENCES sav.cases(id),
 reply_key text NOT NULL CHECK (char_length(reply_key) BETWEEN 10 AND 420),
 payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
 case_version integer NOT NULL CHECK (case_version >= 1),
 recipient text NOT NULL CHECK (char_length(recipient) BETWEEN 3 AND 320 AND recipient = lower(btrim(recipient))),
 state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','approved','declined','superseded','revoked')),
 proposal_ciphertext text NOT NULL,
 decided_by uuid,
 decided_at timestamptz,
 authorization_basis text CHECK (authorization_basis IS NULL OR authorization_basis ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$'),
 revoked_by uuid,
 revoked_at timestamptz,
 revocation_basis text CHECK (revocation_basis IS NULL OR revocation_basis ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$'),
 execution_id uuid CONSTRAINT case_reply_validations_execution_id_case_effect_executions_id_fk REFERENCES sav.case_effect_executions(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT case_reply_validations_trigger_payload_unique UNIQUE (reply_key, payload_hash),
 CONSTRAINT case_reply_validations_execution_needs_approval CHECK (execution_id IS NULL OR state IN ('approved','revoked')),
 CONSTRAINT case_reply_validations_decision_shape CHECK (CASE state
  WHEN 'proposed' THEN decided_by IS NULL AND decided_at IS NULL AND authorization_basis IS NULL AND revoked_by IS NULL AND revoked_at IS NULL AND revocation_basis IS NULL
  WHEN 'superseded' THEN decided_by IS NULL AND decided_at IS NOT NULL AND authorization_basis IS NULL AND revoked_by IS NULL AND revoked_at IS NULL AND revocation_basis IS NULL
  WHEN 'approved' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND authorization_basis IS NOT NULL AND revoked_by IS NULL AND revoked_at IS NULL AND revocation_basis IS NULL
  WHEN 'declined' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND authorization_basis IS NOT NULL AND revoked_by IS NULL AND revoked_at IS NULL AND revocation_basis IS NULL
  WHEN 'revoked' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND authorization_basis IS NOT NULL AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revocation_basis IS NOT NULL
 END)
);
--> statement-breakpoint
CREATE UNIQUE INDEX case_reply_validations_one_approved ON sav.case_reply_validations(reply_key) WHERE state = 'approved';
--> statement-breakpoint
CREATE INDEX case_reply_validations_case ON sav.case_reply_validations(case_id, created_at);
--> statement-breakpoint
CREATE INDEX case_reply_validations_awaiting ON sav.case_reply_validations(created_at) WHERE state = 'proposed';
--> statement-breakpoint
-- A validation is durable evidence: never deleted, never rewritten. Only proposed -> approved | declined | superseded and approved -> revoked, each once,
-- and a revocation is refused once the reply's effect has left 'planned' (a marker exists: the send may have started, only verification remains).
CREATE FUNCTION sav.case_reply_validation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'case reply validation is never deleted' USING ERRCODE = '23514'; END IF;
 -- A validation is born a proposal with no execution: an approval only exists as a decision taken on a stored proposal (pole A review of c5ad3d6).
 IF TG_OP = 'INSERT' THEN
  IF NEW.state <> 'proposed' OR NEW.execution_id IS NOT NULL THEN RAISE EXCEPTION 'case reply validation starts as a proposal' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.reply_key IS DISTINCT FROM OLD.reply_key
  OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR NEW.case_version IS DISTINCT FROM OLD.case_version OR NEW.recipient IS DISTINCT FROM OLD.recipient
  OR NEW.proposal_ciphertext IS DISTINCT FROM OLD.proposal_ciphertext OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'case reply validation payload is immutable' USING ERRCODE = '23514';
 END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND NOT ((OLD.state = 'proposed' AND NEW.state IN ('approved','declined','superseded')) OR (OLD.state = 'approved' AND NEW.state = 'revoked')) THEN
  RAISE EXCEPTION 'case reply validation transition refused' USING ERRCODE = '23514';
 END IF;
 IF OLD.decided_at IS NOT NULL AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.authorization_basis IS DISTINCT FROM OLD.authorization_basis) THEN
  RAISE EXCEPTION 'case reply validation decision is immutable' USING ERRCODE = '23514';
 END IF;
 IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_by IS DISTINCT FROM OLD.revoked_by OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revocation_basis IS DISTINCT FROM OLD.revocation_basis) THEN
  RAISE EXCEPTION 'case reply validation revocation is immutable' USING ERRCODE = '23514';
 END IF;
 IF OLD.execution_id IS NOT NULL AND NEW.execution_id IS DISTINCT FROM OLD.execution_id THEN
  RAISE EXCEPTION 'case reply validation execution is immutable' USING ERRCODE = '23514';
 END IF;
 IF NEW.state = 'revoked' AND OLD.state IS DISTINCT FROM 'revoked'
  AND EXISTS (SELECT 1 FROM sav.intake_effects WHERE business_key = OLD.reply_key AND state <> 'planned') THEN
  RAISE EXCEPTION 'case reply validation cannot be revoked once the send started' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sav_case_reply_validations_guard BEFORE INSERT OR UPDATE OR DELETE ON sav.case_reply_validations FOR EACH ROW EXECUTE FUNCTION sav.case_reply_validation_guard();
--> statement-breakpoint
-- Type separation of the effect ledger's two parents (0050 checks that a parent exists, not what it may host). A case execution hosts only reply_send and
-- the two note kinds; an intake execution hosts everything except reply_send. Fires after sav_intake_effects_parent (name order), which owns "no parent".
CREATE FUNCTION sav.check_effect_kind_for_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM sav.case_effect_executions WHERE id = NEW.execution_id) THEN
  IF NEW.kind NOT IN ('reply_send','note_create','note_associate') THEN
   RAISE EXCEPTION 'effect kind % cannot belong to a case execution', NEW.kind USING ERRCODE = '23514';
  END IF;
 ELSIF NEW.kind = 'reply_send' THEN
  RAISE EXCEPTION 'reply_send can only belong to a case execution' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sav_intake_effects_parent_kind BEFORE INSERT OR UPDATE OF execution_id, kind ON sav.intake_effects FOR EACH ROW EXECUTE FUNCTION sav.check_effect_kind_for_parent();
--> statement-breakpoint
INSERT INTO sav.sync_state(key,status) VALUES('sav-case-schema-v7','installed') ON CONFLICT(key) DO NOTHING;
