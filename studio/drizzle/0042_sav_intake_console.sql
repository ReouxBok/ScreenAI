CREATE TABLE sav.intake_console (
 thread_id uuid PRIMARY KEY REFERENCES sav.threads(id) ON DELETE CASCADE,
 epoch bigint NOT NULL DEFAULT 1, projected_epoch bigint NOT NULL DEFAULT 0,
 message_id uuid, run_id uuid, version integer, mailbox_id uuid NOT NULL,
 view text CHECK(view IN ('learning','missing_contact','to_validate','sensitive','completed','other')),
 status text NOT NULL DEFAULT 'processing', reason text, updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX sav_intake_console_list ON sav.intake_console(mailbox_id,updated_at,thread_id);
--> statement-breakpoint
CREATE TABLE sav.intake_human_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), command_key uuid NOT NULL UNIQUE,
 thread_id uuid NOT NULL, message_id uuid NOT NULL, parent_run_id uuid NOT NULL, parent_version integer NOT NULL,
 revision_run_id uuid UNIQUE, base_config_hash text NOT NULL, source_hash text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('select','classify','refuse')), state text NOT NULL DEFAULT 'pending',
 lease_token uuid, lease_until timestamptz, read_attempts integer NOT NULL DEFAULT 0 CHECK(read_attempts BETWEEN 0 AND 2),
 payload_ciphertext text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX sav_intake_human_pending ON sav.intake_human_events(state,created_at);
--> statement-breakpoint
CREATE TABLE sav.intake_observation_bindings (
 observation_id uuid PRIMARY KEY REFERENCES sav.resolution_observations(id) ON DELETE CASCADE,
 execution_id uuid NOT NULL UNIQUE REFERENCES sav.intake_executions(id), run_id uuid NOT NULL, message_id uuid NOT NULL,
 thread_id uuid NOT NULL, baseline_ciphertext text NOT NULL, baseline_hash text NOT NULL,
 sensitive boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE sav.intake_effect_revisions (
 effect_id uuid PRIMARY KEY REFERENCES sav.intake_effects(id), event_id uuid NOT NULL REFERENCES sav.intake_human_events(id),
 active boolean NOT NULL, revision_run_id uuid NOT NULL
);
--> statement-breakpoint
CREATE FUNCTION sav.dirty_intake_console(target uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO sav.intake_console(thread_id,mailbox_id)
 SELECT t.id,t.mailbox_id FROM sav.threads t WHERE t.id=target
 AND (EXISTS(SELECT 1 FROM sav.messages m WHERE m.thread_id=t.id AND m.analysis_status LIKE 'intake_%')
 OR EXISTS(SELECT 1 FROM sav.sync_state launch WHERE launch.key='sav-intake-launch:' || t.mailbox_id::text AND launch.status='intake_launch_v1'))
 ON CONFLICT(thread_id) DO UPDATE SET epoch=sav.intake_console.epoch+1,updated_at=now();
END;
$$;
--> statement-breakpoint
CREATE FUNCTION sav.dirty_intake_console_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='threads' THEN target:=NEW.id;
 ELSIF TG_TABLE_NAME='intake_effects' THEN SELECT thread_id INTO target FROM sav.intake_executions WHERE id=NEW.execution_id;
 ELSIF TG_TABLE_NAME='observation_cycles' THEN SELECT thread_id INTO target FROM sav.resolution_observations WHERE id=NEW.observation_id;
 ELSE target:=NEW.thread_id;
 END IF;
 PERFORM sav.dirty_intake_console(target);
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sav_intake_console_messages AFTER INSERT OR UPDATE ON sav.messages FOR EACH ROW EXECUTE FUNCTION sav.dirty_intake_console_row();
--> statement-breakpoint
CREATE TRIGGER sav_intake_console_threads AFTER UPDATE ON sav.threads FOR EACH ROW EXECUTE FUNCTION sav.dirty_intake_console_row();
--> statement-breakpoint
CREATE TRIGGER sav_intake_console_runs AFTER INSERT OR UPDATE ON sav.intake_runs FOR EACH ROW EXECUTE FUNCTION sav.dirty_intake_console_row();
--> statement-breakpoint
CREATE TRIGGER sav_intake_console_executions AFTER INSERT OR UPDATE ON sav.intake_executions FOR EACH ROW EXECUTE FUNCTION sav.dirty_intake_console_row();
--> statement-breakpoint
CREATE TRIGGER sav_intake_console_effects AFTER INSERT OR UPDATE ON sav.intake_effects FOR EACH ROW EXECUTE FUNCTION sav.dirty_intake_console_row();
--> statement-breakpoint
CREATE TRIGGER sav_intake_console_observations AFTER INSERT OR UPDATE ON sav.resolution_observations FOR EACH ROW EXECUTE FUNCTION sav.dirty_intake_console_row();
--> statement-breakpoint
CREATE TRIGGER sav_intake_console_cycles AFTER INSERT OR UPDATE ON sav.observation_cycles FOR EACH ROW EXECUTE FUNCTION sav.dirty_intake_console_row();
--> statement-breakpoint
CREATE TRIGGER sav_intake_console_choices AFTER INSERT OR UPDATE ON sav.intake_human_events FOR EACH ROW EXECUTE FUNCTION sav.dirty_intake_console_row();
--> statement-breakpoint
INSERT INTO sav.intake_console(thread_id,mailbox_id) SELECT DISTINCT t.id,t.mailbox_id FROM sav.threads t JOIN sav.messages m ON m.thread_id=t.id WHERE m.analysis_status LIKE 'intake_%';
--> statement-breakpoint
INSERT INTO sav.sync_state(key,status) VALUES('sav-intake-console-schema-v1','installed') ON CONFLICT(key) DO NOTHING;
--> statement-breakpoint
-- State/lease/result binding can advance, but the authenticated event bytes and
-- parent/source authority are immutable after insertion.
CREATE FUNCTION sav.immutable_intake_human_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.command_key,NEW.thread_id,NEW.message_id,NEW.parent_run_id,NEW.parent_version,NEW.base_config_hash,NEW.source_hash,NEW.kind,NEW.payload_ciphertext,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.command_key,OLD.thread_id,OLD.message_id,OLD.parent_run_id,OLD.parent_version,OLD.base_config_hash,OLD.source_hash,OLD.kind,OLD.payload_ciphertext,OLD.created_at)
 OR (OLD.revision_run_id IS NOT NULL AND NEW.revision_run_id IS DISTINCT FROM OLD.revision_run_id)
 OR (OLD.state='refused' AND NEW.state <> 'refused')
 THEN RAISE EXCEPTION 'SAV_INTAKE_HUMAN_EVENT_IMMUTABLE'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sav_intake_human_immutable BEFORE UPDATE ON sav.intake_human_events FOR EACH ROW EXECUTE FUNCTION sav.immutable_intake_human_event();
