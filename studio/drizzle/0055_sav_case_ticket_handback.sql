-- SAV-99 (Ugo 19/11): a ticket a person gave the V2 agent that the agent does not take goes back to the team, once, with no mail: its hand-over stage
-- (« Nouveau », no owner, one short note) and its Slack hand-over notice run on a case that may have no Gmail thread.
-- Additive: the check below is strictly weaker than 0054's (every row 0054 accepts is still accepted, and code before this migration never writes
-- the two new shapes), and the trigger keeps every pair 0054 accepted. Safe to apply before the code that uses it.
ALTER TABLE sav.case_effect_executions DROP CONSTRAINT case_effect_executions_source_thread;
--> statement-breakpoint
ALTER TABLE sav.case_effect_executions ADD CONSTRAINT case_effect_executions_source_thread
  CHECK (CASE WHEN reply_key ~ '^reply:[^:]+:ticket:[0-9a-f-]{36}$' THEN thread_id IS NULL
    ELSE thread_id IS NOT NULL OR reply_key ~ '^case-stage:[0-9a-f-]{36}:handoff:handoff-v[0-9]{1,10}$' OR reply_key ~ '^handoff-notice:[0-9a-f-]{36}:ticket:[0-9a-f-]{36}$' END);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sav.check_effect_kind_for_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE case_has_thread boolean; parent_key text;
BEGIN
 SELECT thread_id IS NOT NULL, reply_key INTO case_has_thread, parent_key FROM sav.case_effect_executions WHERE id = NEW.execution_id;
 IF FOUND THEN
  IF (case_has_thread AND NEW.kind NOT IN ('reply_send','note_create','note_associate','handoff_notify','ticket_stage'))
     OR (NOT case_has_thread AND parent_key ~ '^case-stage:' AND NEW.kind NOT IN ('ticket_stage','note_create','note_associate'))
     OR (NOT case_has_thread AND parent_key ~ '^handoff-notice:' AND NEW.kind NOT IN ('handoff_notify','note_create','note_associate'))
     OR (NOT case_has_thread AND parent_key !~ '^(case-stage|handoff-notice):' AND NEW.kind NOT IN ('new_thread_send','new_thread_crm_email')) THEN
   RAISE EXCEPTION 'effect kind % cannot belong to this case execution', NEW.kind USING ERRCODE = '23514';
  END IF;
 ELSIF NEW.kind IN ('reply_send','handoff_notify','ticket_stage','new_thread_send','new_thread_crm_email') THEN
  RAISE EXCEPTION '% can only belong to a case execution', NEW.kind USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
INSERT INTO sav.sync_state(key,status) VALUES('sav-case-schema-v11','installed') ON CONFLICT(key) DO NOTHING;
