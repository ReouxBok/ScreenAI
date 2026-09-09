ALTER TABLE "sav"."pilot_items" ADD COLUMN "classification_verdict" "sav"."pilot_verdict";--> statement-breakpoint
ALTER TABLE "sav"."pilot_items" ADD COLUMN "routing_verdict" "sav"."pilot_verdict";--> statement-breakpoint
ALTER TABLE "sav"."pilot_items" ADD COLUMN "grounding_verdict" "sav"."pilot_verdict";--> statement-breakpoint
ALTER TABLE "sav"."pilot_items" ADD COLUMN "tone_verdict" "sav"."pilot_verdict";--> statement-breakpoint
ALTER TABLE "sav"."pilot_items" ADD COLUMN "escalation_verdict" "sav"."pilot_verdict";
