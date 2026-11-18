-- A ticket-origin execution has no Gmail thread until its first message is verified.
ALTER TABLE sav.case_effect_executions ALTER COLUMN thread_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE sav.case_effect_executions ADD CONSTRAINT case_effect_executions_source_thread
  CHECK ((thread_id IS NULL) = (reply_key ~ '^reply:[^:]+:ticket:[0-9a-f-]{36}$'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sav.check_effect_kind_for_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE case_has_thread boolean;
BEGIN
 SELECT thread_id IS NOT NULL INTO case_has_thread FROM sav.case_effect_executions WHERE id = NEW.execution_id;
 IF FOUND THEN
  IF (case_has_thread AND NEW.kind NOT IN ('reply_send','note_create','note_associate','handoff_notify','ticket_stage'))
     OR (NOT case_has_thread AND NEW.kind NOT IN ('new_thread_send','new_thread_crm_email')) THEN
   RAISE EXCEPTION 'effect kind % cannot belong to this case execution', NEW.kind USING ERRCODE = '23514';
  END IF;
 ELSIF NEW.kind IN ('reply_send','handoff_notify','ticket_stage','new_thread_send','new_thread_crm_email') THEN
  RAISE EXCEPTION '% can only belong to a case execution', NEW.kind USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
INSERT INTO sav.sync_state(key,status) VALUES('sav-case-schema-v10','installed') ON CONFLICT(key) DO NOTHING;
