CREATE TABLE "sav"."intake_runs" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "thread_id" uuid NOT NULL REFERENCES "sav"."threads"("id") ON DELETE CASCADE,
 "message_id" uuid NOT NULL REFERENCES "sav"."messages"("id") ON DELETE CASCADE,
 "version" integer NOT NULL CHECK (version > 0),
 "is_current" boolean NOT NULL DEFAULT true,
 "state" text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','analysing','observed','waiting','uncertain','superseded')),
 "config_hash" text NOT NULL, "policy_hash" text NOT NULL,
 "source_hash" text, "payload_ciphertext" text NOT NULL,
 "human_choice_ciphertext" text,
 "lease_token" uuid, "lease_until" timestamptz,
 "attempts" integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
 "fresh_until" timestamptz,
 "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT "sav_intake_runs_version" UNIQUE("thread_id","version"),
 CONSTRAINT "sav_intake_runs_message_config" UNIQUE("message_id","config_hash")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sav_intake_runs_current" ON "sav"."intake_runs"("thread_id") WHERE "is_current";
--> statement-breakpoint
CREATE INDEX "sav_intake_runs_recovery" ON "sav"."intake_runs"("state","lease_until");
--> statement-breakpoint
CREATE TABLE "sav"."intake_journal" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "run_id" uuid NOT NULL REFERENCES "sav"."intake_runs"("id") ON DELETE CASCADE,
 "kind" text NOT NULL, "payload_ciphertext" text NOT NULL,
 "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sav"."intake_model_calls" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "run_id" uuid REFERENCES "sav"."intake_runs"("id") ON DELETE SET NULL,
 "message_key" text NOT NULL,
 "request_hash" text NOT NULL,
 "state" text NOT NULL CHECK (state IN ('dispatched','settled','uncertain')),
 "reserved_nano_usd" bigint NOT NULL CHECK (reserved_nano_usd > 0),
 "charged_nano_usd" bigint NOT NULL CHECK (charged_nano_usd >= 0 AND charged_nano_usd <= reserved_nano_usd),
 "result_ciphertext" text,
 "payload_ciphertext" text NOT NULL,
 "created_at" timestamptz NOT NULL DEFAULT now(), "settled_at" timestamptz
);

--> statement-breakpoint
CREATE UNIQUE INDEX "sav_intake_model_request" ON "sav"."intake_model_calls"("message_key","request_hash");
--> statement-breakpoint
-- A pause/release or operator routing change permanently fences an in-flight
-- observation, including a pause toggled on and off between provider checks.
CREATE FUNCTION sav.invalidate_intake_thread_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE sav.intake_runs SET state = 'waiting', lease_token = NULL, lease_until = NULL, fresh_until = NULL, updated_at = now()
 WHERE thread_id = NEW.id AND is_current AND state IN ('pending','analysing','observed');
 UPDATE sav.messages SET analysis_status = 'intake_waiting' WHERE id IN (SELECT message_id FROM sav.intake_runs WHERE thread_id = NEW.id AND is_current AND state = 'waiting');
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sav_intake_thread_context AFTER UPDATE OF ai_paused, human_requested_at, hubspot_ticket_id ON sav.threads
FOR EACH ROW WHEN (OLD.ai_paused IS DISTINCT FROM NEW.ai_paused OR OLD.human_requested_at IS DISTINCT FROM NEW.human_requested_at OR OLD.hubspot_ticket_id IS DISTINCT FROM NEW.hubspot_ticket_id)
EXECUTE FUNCTION sav.invalidate_intake_thread_context();

--> statement-breakpoint
-- Cost receipts survive mail retention; cached private model content does not.
CREATE FUNCTION sav.purge_intake_orphan_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.run_id IS NULL THEN NEW.result_ciphertext = NULL; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sav_intake_orphan_result BEFORE UPDATE OF run_id ON sav.intake_model_calls
FOR EACH ROW EXECUTE FUNCTION sav.purge_intake_orphan_result();
--> statement-breakpoint
CREATE FUNCTION sav.invalidate_intake_human_choice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.state = 'waiting'; NEW.lease_token = NULL; NEW.lease_until = NULL; NEW.fresh_until = NULL;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sav_intake_human_choice BEFORE UPDATE OF human_choice_ciphertext ON sav.intake_runs
FOR EACH ROW WHEN (OLD.human_choice_ciphertext IS DISTINCT FROM NEW.human_choice_ciphertext)
EXECUTE FUNCTION sav.invalidate_intake_human_choice();
