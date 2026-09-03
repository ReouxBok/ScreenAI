ALTER TYPE "sav"."pilot_batch_status" ADD VALUE IF NOT EXISTS 'cancelled';--> statement-breakpoint
UPDATE "sav"."actions"
SET "status" = 'succeeded', "executed_at" = COALESCE("executed_at", now()), "updated_at" = now()
WHERE "pilot_batch_id" IS NOT NULL AND "kind" = 'request_human' AND "status" = 'pending';--> statement-breakpoint
UPDATE "sav"."actions"
SET "status" = 'cancelled', "error_code" = 'SAV_PILOT_STATUS_UPDATE_BLOCKED', "executed_at" = COALESCE("executed_at", now()), "updated_at" = now()
WHERE "pilot_batch_id" IS NOT NULL AND "kind" = 'update_ticket_status' AND "status" = 'pending';
