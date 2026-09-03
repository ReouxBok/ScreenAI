CREATE TABLE "sav"."gmail_quarantine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"receipt_id" uuid,
	"gmail_message_id" text NOT NULL,
	"cause" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'quarantined' NOT NULL,
	"first_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sav"."gmail_quarantine" ADD CONSTRAINT "gmail_quarantine_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "sav"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sav"."gmail_quarantine" ADD CONSTRAINT "gmail_quarantine_receipt_id_webhook_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "sav"."webhook_receipts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sav_gmail_quarantine_mailbox_message_idx" ON "sav"."gmail_quarantine" USING btree ("mailbox_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX "sav_gmail_quarantine_status_failed_idx" ON "sav"."gmail_quarantine" USING btree ("status","last_failed_at");
