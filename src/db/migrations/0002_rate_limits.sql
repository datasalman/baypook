CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "holds" ADD COLUMN "client_key" text;--> statement-breakpoint
CREATE INDEX "holds_client_idx" ON "holds" USING btree ("client_key","status");