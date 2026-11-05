-- V2 human handoff notice (local, OFF): the one Slack post of a final handoff decision runs on the EXISTING effect ledger and executor, hosted by a case
-- execution like reply_send and the two note kinds. The only change is what a case execution may host: handoff_notify joins reply_send, note_create and
-- note_associate; an intake execution still hosts every V1 kind and never reply_send, and now never handoff_notify either. Function body only: no table,
-- no column, no row of any existing execution is touched. Nothing runs here.
CREATE OR REPLACE FUNCTION sav.check_effect_kind_for_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM sav.case_effect_executions WHERE id = NEW.execution_id) THEN
  IF NEW.kind NOT IN ('reply_send','note_create','note_associate','handoff_notify') THEN
   RAISE EXCEPTION 'effect kind % cannot belong to a case execution', NEW.kind USING ERRCODE = '23514';
  END IF;
 ELSIF NEW.kind IN ('reply_send','handoff_notify') THEN
  RAISE EXCEPTION '% can only belong to a case execution', NEW.kind USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
INSERT INTO sav.sync_state(key,status) VALUES('sav-case-schema-v8','installed') ON CONFLICT(key) DO NOTHING;
