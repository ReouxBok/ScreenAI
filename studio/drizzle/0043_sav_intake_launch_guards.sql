-- A sensitive history update dirties every retained projection sharing the
-- actual ticket, including associations retained by an execution after unlink.
CREATE OR REPLACE FUNCTION sav.dirty_intake_console(target uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO sav.intake_console(thread_id,mailbox_id)
 SELECT t.id,t.mailbox_id FROM sav.threads t
 WHERE (t.id=target OR t.hubspot_ticket_id IN (
   SELECT hubspot_ticket_id FROM sav.threads WHERE id=target AND hubspot_ticket_id IS NOT NULL
   UNION SELECT ticket_id FROM sav.intake_executions WHERE thread_id=target AND ticket_id IS NOT NULL)
 OR t.id IN (SELECT e.thread_id FROM sav.intake_executions e WHERE e.ticket_id IN (
   SELECT hubspot_ticket_id FROM sav.threads WHERE id=target AND hubspot_ticket_id IS NOT NULL
   UNION SELECT ticket_id FROM sav.intake_executions WHERE thread_id=target AND ticket_id IS NOT NULL)))
 AND (EXISTS(SELECT 1 FROM sav.messages m WHERE m.thread_id=t.id AND m.analysis_status LIKE 'intake_%')
 OR EXISTS(SELECT 1 FROM sav.sync_state launch WHERE launch.key='sav-intake-launch:' || t.mailbox_id::text AND launch.status='intake_launch_v1'))
 ON CONFLICT(thread_id) DO UPDATE SET epoch=sav.intake_console.epoch+1,updated_at=now();
END;
$$;
--> statement-breakpoint
CREATE FUNCTION sav.dirty_intake_console_agent_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 SELECT thread_id INTO target FROM sav.messages WHERE id=NEW.message_id;
 IF target IS NOT NULL THEN PERFORM sav.dirty_intake_console(target); END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER sav_intake_console_agent_runs AFTER INSERT OR UPDATE ON sav.agent_runs FOR EACH ROW EXECUTE FUNCTION sav.dirty_intake_console_agent_run();
