-- V2 ticket states (local, OFF): « waiting for the customer » after a confirmed reply and « closed » after a proven resolution run on the EXISTING effect ledger and executor,
-- hosted by a case execution like reply_send, the note kinds and handoff_notify. The only change is what a case execution may host: ticket_stage joins them; an intake
-- execution still hosts every V1 kind and never reply_send, handoff_notify or ticket_stage. Function body only: no table, no column, no row of any existing execution is
-- touched. Nothing runs here.
CREATE OR REPLACE FUNCTION sav.check_effect_kind_for_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM sav.case_effect_executions WHERE id = NEW.execution_id) THEN
  IF NEW.kind NOT IN ('reply_send','note_create','note_associate','handoff_notify','ticket_stage') THEN
   RAISE EXCEPTION 'effect kind % cannot belong to a case execution', NEW.kind USING ERRCODE = '23514';
  END IF;
 ELSIF NEW.kind IN ('reply_send','handoff_notify','ticket_stage') THEN
  RAISE EXCEPTION '% can only belong to a case execution', NEW.kind USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
INSERT INTO sav.sync_state(key,status) VALUES('sav-case-schema-v9','installed') ON CONFLICT(key) DO NOTHING;
