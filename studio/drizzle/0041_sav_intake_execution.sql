CREATE TABLE sav.intake_execution_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), revision text NOT NULL, state text NOT NULL CHECK (state IN ('approved','revoked')),
 administrator_id uuid NOT NULL REFERENCES public.staff_users(id), policy_hash text NOT NULL, payload_ciphertext text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE sav.intake_execution_budget (id text PRIMARY KEY CHECK(id='global'), admitted integer NOT NULL DEFAULT 0 CHECK(admitted>=0));
--> statement-breakpoint
INSERT INTO sav.intake_execution_budget(id) VALUES('global');
--> statement-breakpoint
CREATE TABLE sav.intake_executions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), message_id uuid NOT NULL UNIQUE, thread_id uuid NOT NULL,
 run_id uuid, run_version integer NOT NULL, policy_id uuid NOT NULL REFERENCES sav.intake_execution_policies(id), policy_hash text NOT NULL,
 actor_type text NOT NULL DEFAULT 'ai' CHECK(actor_type='ai'), state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','waiting','uncertain','confirmed','refused')),
 ticket_id text, lease_token uuid, lease_until timestamptz, payload_ciphertext text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE sav.intake_effects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_key text NOT NULL UNIQUE, execution_id uuid NOT NULL REFERENCES sav.intake_executions(id),
 kind text NOT NULL, permission text NOT NULL, state text NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','dispatched','acked','confirmed','uncertain')),
 intent_hash text NOT NULL, intent_ciphertext text NOT NULL, attempt_id uuid NOT NULL DEFAULT gen_random_uuid(),
 ack_ciphertext text, verification_ciphertext text, dispatch_token uuid, dispatched_at timestamptz, confirmed_at timestamptz,
 reconcile_attempts integer NOT NULL DEFAULT 0, next_reconcile_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE sav.intake_effect_journal (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), execution_id uuid NOT NULL REFERENCES sav.intake_executions(id), effect_id uuid REFERENCES sav.intake_effects(id),
 kind text NOT NULL, payload_ciphertext text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE sav.intake_occupations (
 key text PRIMARY KEY, owner_id uuid NOT NULL, owner_kind text NOT NULL CHECK(owner_kind IN ('intake','legacy')), acquired_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE sav.intake_identity_episodes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), thread_id uuid NOT NULL UNIQUE, initial_message_id uuid NOT NULL,
 recipient_ciphertext text NOT NULL, initial_effect_id uuid UNIQUE REFERENCES sav.intake_effects(id), retry_effect_id uuid UNIQUE REFERENCES sav.intake_effects(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO sav.sync_state(key,status) VALUES('sav-intake-execution-schema-v1','installed') ON CONFLICT(key) DO NOTHING;
