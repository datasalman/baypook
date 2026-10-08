ALTER TABLE "processed_webhook_events" DROP CONSTRAINT "processed_webhook_events_pkey";--> statement-breakpoint
ALTER TABLE "processed_webhook_events" ALTER COLUMN "venue_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_webhook_events" ADD CONSTRAINT "processed_webhook_events_venue_id_id_pk" PRIMARY KEY("venue_id","id");--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "external_ref" text;--> statement-breakpoint
CREATE INDEX "bookings_external_ref_idx" ON "bookings" USING btree ("external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_provider_refund_idx" ON "refunds" USING btree ("provider_refund_id");